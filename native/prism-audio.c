/*
 * prism-audio: tiny audio output helper for Prism.
 *
 *   prism-audio list            print the output devices as JSON lines and exit
 *   prism-audio                 run: read commands + PCM on stdin, print events on stdout
 *
 * Backends:
 *   Windows: WASAPI, exclusive (bit-perfect, direct to the DAC) or shared, event driven.
 *   Anything else (used by the test-suite): a "sink" that writes the converted samples to $PRISM_SINK_FILE.
 *
 * stdin  = frames:  [1 byte command][4 byte little-endian length][payload]
 *   'O' open    "mode|deviceId|rate|bits|bufferMs"   mode = exclusive|shared, bits = 0(auto)|16|24|32
 *   'K' close the device (releases it for other programs)
 *   'P' pcm     u32 epoch + interleaved stereo float32 little-endian; stale epochs are dropped
 *   'F' flush   "epoch"    drop everything queued, accept PCM of this epoch from now on
 *   'S' state   "1" play / "0" pause
 *   'V' volume  "0.0..1.0"
 *   'E' eq      "enabled preampDb g0 g1 .. g9"
 *   'Q' queue end "epoch"   print "drained <epoch>" once everything queued has been played
 *   'C' caps    "mode|deviceId"   print the sample rates the device accepts
 *   'X' quit
 * stdout = lines:  ready | fmt <rate> <bits> <mode> <name> | caps <r1,r2,..> | pos <epoch> <frames> |
 *                  drained <epoch> | underrun <n> | err <message>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <math.h>

#ifdef _WIN32
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <io.h>
#include <fcntl.h>
typedef CRITICAL_SECTION Mutex;
#define mutex_init(m) InitializeCriticalSection(m)
#define mutex_lock(m) EnterCriticalSection(m)
#define mutex_unlock(m) LeaveCriticalSection(m)
static uint64_t now_ms(void) { return GetTickCount64(); }
#else
#include <pthread.h>
#include <unistd.h>
#include <time.h>
typedef pthread_mutex_t Mutex;
#define mutex_init(m) pthread_mutex_init(m, NULL)
#define mutex_lock(m) pthread_mutex_lock(m)
#define mutex_unlock(m) pthread_mutex_unlock(m)
static uint64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
#endif

#define NBANDS 10
static const double EQ_FREQ[NBANDS] = { 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 };
#define EQ_Q 1.41421356

/* ------------------------------------------------------------------ shared state */
static Mutex g_lock;       /* guards the ring, flags and dsp parameters */
static Mutex g_out;        /* serialises stdout */

static float *g_ring = NULL;           /* interleaved stereo */
static size_t g_cap = 0, g_r = 0, g_w = 0, g_count = 0;   /* in frames */

static volatile int g_playing = 0;
static uint32_t g_epoch = 0;
static uint32_t g_eoq_epoch = 0xFFFFFFFFu;
static int g_drained_sent = 0;
static uint64_t g_played = 0;          /* frames of the current epoch that went to the device */
static uint64_t g_underruns = 0;
static double g_volume = 1.0, g_vol_cur = 1.0;
static double g_env = 0.0;             /* pause/resume fade 0..1 */
static int g_prebuf = 1;               /* after a flush wait for ~100 ms of audio before starting (no start-up glitches) */

static int g_rate = 0;                 /* current device rate */
static int g_bits = 0;                 /* container bits actually used: 16, 24 (packed), 32, 33 = 24-in-32 */
static int g_dither = 0;

/* equaliser */
static int g_eq_on = 0;
static double g_eq_pre = 1.0;
static double g_eq_gain_db[NBANDS];
typedef struct { double b0, b1, b2, a1, a2; } Biquad;
static Biquad g_bq[NBANDS];
static int g_bq_active[NBANDS];
static double g_z[2][NBANDS][2];       /* per channel, per band: z1,z2 */

static void say(const char *fmt, ...) {
    va_list ap;
    mutex_lock(&g_out);
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
    mutex_unlock(&g_out);
}

#ifdef _WIN32
static void json_escape(const char *s, char *out, size_t n) {
    size_t j = 0;
    for (; *s && j + 8 < n; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { out[j++] = '\\'; out[j++] = (char)c; }
        else if (c < 0x20) { j += (size_t)snprintf(out + j, n - j, "\\u%04x", c); }
        else out[j++] = (char)c;
    }
    out[j] = 0;
}
#endif

/* ------------------------------------------------------------------ dsp */
static void eq_recalc(void) {   /* call with g_lock held */
    for (int b = 0; b < NBANDS; b++) {
        double db = g_eq_gain_db[b];
        g_bq_active[b] = 0;
        if (!g_rate || fabs(db) < 0.01 || EQ_FREQ[b] >= g_rate * 0.45) continue;
        double A = pow(10.0, db / 40.0), w0 = 2.0 * 3.14159265358979323846 * EQ_FREQ[b] / g_rate;
        double alpha = sin(w0) / (2.0 * EQ_Q), c = cos(w0);
        double a0 = 1.0 + alpha / A;
        g_bq[b].b0 = (1.0 + alpha * A) / a0;
        g_bq[b].b1 = (-2.0 * c) / a0;
        g_bq[b].b2 = (1.0 - alpha * A) / a0;
        g_bq[b].a1 = (-2.0 * c) / a0;
        g_bq[b].a2 = (1.0 - alpha / A) / a0;
        g_bq_active[b] = 1;
    }
}

static uint32_t g_rng = 22222;
static inline double rnd(void) { g_rng ^= g_rng << 13; g_rng ^= g_rng >> 17; g_rng ^= g_rng << 5; return (g_rng / 4294967296.0); }

static inline int32_t to_int(double v, double scale, int dither) {
    if (dither && v != 0.0) v += (rnd() - rnd()) / scale;      /* TPDF, +-1 LSB; digital silence stays silent */
    v *= scale;
    if (v > scale - 1) v = scale - 1;
    if (v < -scale) v = -scale;
    return (int32_t)lrint(v);
}

/* float stereo -> device bytes */
static void convert(const float *in, unsigned char *out, int frames) {
    int n = frames * 2;
    for (int i = 0; i < n; i++) {
        double v = in[i];
        switch (g_bits) {
        case 16: { int16_t s = (int16_t)to_int(v, 32768.0, g_dither); memcpy(out, &s, 2); out += 2; break; }
        case 24: { int32_t s = to_int(v, 8388608.0, 0); out[0] = (unsigned char)s; out[1] = (unsigned char)(s >> 8); out[2] = (unsigned char)(s >> 16); out += 3; break; }
        case 33: { int32_t s = to_int(v, 8388608.0, 0) << 8; memcpy(out, &s, 4); out += 4; break; }     /* 24 valid bits in a 32-bit container */
        case 32: { int32_t s = to_int(v, 2147483648.0, 0); memcpy(out, &s, 4); out += 4; break; }
        default: { float f = (float)v; memcpy(out, &f, 4); out += 4; break; }                           /* 0 = float */
        }
    }
}

static int bytes_per_frame(void) { switch (g_bits) { case 16: return 4; case 24: return 6; default: return 8; } }

/* Pull `frames` frames of processed float audio. Fills the remainder with silence. */
static void render_float(float *dst, int frames) {
    mutex_lock(&g_lock);
    int playing = g_playing;
    if (g_prebuf && (g_count >= (size_t)(g_rate / 10) || g_eoq_epoch == g_epoch)) g_prebuf = 0;
    int hold = g_prebuf;                       /* still collecting the first ~100 ms: output silence, do not count underruns */
    double target_env = (playing && !hold) ? 1.0 : 0.0;
    int have = 0;
    if (!hold && (g_env > 0.0001 || playing)) {
        int take = (int)(g_count < (size_t)frames ? g_count : (size_t)frames);
        for (int i = 0; i < take; i++) {
            dst[i * 2] = g_ring[g_r * 2]; dst[i * 2 + 1] = g_ring[g_r * 2 + 1];
            if (++g_r == g_cap) g_r = 0;
        }
        g_count -= (size_t)take;
        have = take;
    }
    for (int i = have; i < frames; i++) { dst[i * 2] = 0; dst[i * 2 + 1] = 0; }
    if (have < frames && playing && !hold && !(g_eoq_epoch == g_epoch)) {
        g_underruns += (uint64_t)(frames - have);
    }
    g_played += (uint64_t)have;

    int eq_on = g_eq_on;
    double pre = g_eq_pre;
    double step = 1.0 / (0.010 * (g_rate ? g_rate : 44100));   /* 10 ms fades */
    double vtarget = g_volume;
    for (int i = 0; i < frames; i++) {
        if (g_env < target_env) { g_env += step; if (g_env > target_env) g_env = target_env; }
        else if (g_env > target_env) { g_env -= step; if (g_env < target_env) g_env = target_env; }
        g_vol_cur += (vtarget - g_vol_cur) * 0.002;
        for (int c = 0; c < 2; c++) {
            double x = dst[i * 2 + c];
            if (eq_on) {
                x *= pre;
                for (int b = 0; b < NBANDS; b++) {
                    if (!g_bq_active[b]) continue;
                    const Biquad *q = &g_bq[b];
                    double y = q->b0 * x + g_z[c][b][0];
                    g_z[c][b][0] = q->b1 * x - q->a1 * y + g_z[c][b][1];
                    g_z[c][b][1] = q->b2 * x - q->a2 * y;
                    x = y;
                }
            }
            dst[i * 2 + c] = (float)(x * g_vol_cur * g_env);
        }
    }
    int drained_now = 0;
    if (g_eoq_epoch == g_epoch && g_count == 0 && !g_drained_sent && playing && !hold) { g_drained_sent = 1; drained_now = 1; }
    uint32_t ep = g_epoch;
    mutex_unlock(&g_lock);
    if (drained_now) say("drained %u", ep);
}

static uint64_t g_last_pos_ms = 0, g_last_under_ms = 0, g_last_under = 0;
static void report(void) {
    uint64_t t = now_ms();
    if (t - g_last_pos_ms >= 50) {
        g_last_pos_ms = t;
        mutex_lock(&g_lock);
        uint32_t ep = g_epoch; uint64_t pl = g_played; uint64_t un = g_underruns;
        mutex_unlock(&g_lock);
        say("pos %u %llu", ep, (unsigned long long)pl);
        if (un != g_last_under && t - g_last_under_ms > 1000) { g_last_under = un; g_last_under_ms = t; say("underrun %llu", (unsigned long long)un); }
    }
}

static void ring_alloc(int rate) {
    mutex_lock(&g_lock);
    free(g_ring);
    g_cap = (size_t)rate * 4;                  /* 4 s; the server never sends more than ~1.5 s ahead */
    g_ring = (float *)calloc(g_cap * 2, sizeof(float));
    g_r = g_w = g_count = 0;
    mutex_unlock(&g_lock);
}

static void ring_push(const float *src, size_t frames) {
    mutex_lock(&g_lock);
    if (!g_ring) { mutex_unlock(&g_lock); return; }
    if (frames > g_cap - g_count) frames = g_cap - g_count;   /* overflow: drop (cannot happen with a well-behaved server) */
    for (size_t i = 0; i < frames; i++) {
        g_ring[g_w * 2] = src[i * 2]; g_ring[g_w * 2 + 1] = src[i * 2 + 1];
        if (++g_w == g_cap) g_w = 0;
    }
    g_count += frames;
    if (g_eoq_epoch == g_epoch) { /* data arrived after the end marker: not drained any more */ }
    mutex_unlock(&g_lock);
}

/* ================================================================== backends */
#ifdef _WIN32
/* ------------------------------------------------------------------ WASAPI */
static IMMDeviceEnumerator *g_en = NULL;
static IMMDevice *g_dev = NULL;
static IAudioClient *g_cl = NULL;
static IAudioRenderClient *g_rc = NULL;
static HANDLE g_ev = NULL, g_th = NULL;
static UINT32 g_buf_frames = 0;
static int g_exclusive = 0;
static volatile int g_stop = 0;
static char g_devname[256] = "";

static void narrow(const WCHAR *w, char *out, int n) { WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL); out[n - 1] = 0; }
static WCHAR *widen(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    WCHAR *w = (WCHAR *)malloc((size_t)n * sizeof(WCHAR));
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

static int en_init(void) {
    if (g_en) return 1;
    HRESULT hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator, (void **)&g_en);
    return SUCCEEDED(hr);
}

static void dev_name(IMMDevice *d, char *out, int n) {
    IPropertyStore *ps = NULL; PROPVARIANT v; PropVariantInit(&v);
    out[0] = 0;
    if (SUCCEEDED(IMMDevice_OpenPropertyStore(d, STGM_READ, &ps))) {
        if (SUCCEEDED(IPropertyStore_GetValue(ps, &PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR && v.pwszVal) narrow(v.pwszVal, out, n);
        PropVariantClear(&v);
        IPropertyStore_Release(ps);
    }
}

static int get_device(const char *id, IMMDevice **out) {
    if (!en_init()) return 0;
    if (id && id[0]) {
        WCHAR *w = widen(id);
        HRESULT hr = IMMDeviceEnumerator_GetDevice(g_en, w, out);
        free(w);
        return SUCCEEDED(hr);
    }
    return SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(g_en, eRender, eMultimedia, out));
}

static void fill_wfx(WAVEFORMATEXTENSIBLE *w, int rate, int bitsKind) {
    memset(w, 0, sizeof(*w));
    int container = 32, valid = 32, flt = 0;
    switch (bitsKind) {
    case 16: container = 16; valid = 16; break;
    case 24: container = 24; valid = 24; break;
    case 33: container = 32; valid = 24; break;
    case 32: container = 32; valid = 32; break;
    default: container = 32; valid = 32; flt = 1; break;
    }
    w->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    w->Format.nChannels = 2;
    w->Format.nSamplesPerSec = (DWORD)rate;
    w->Format.wBitsPerSample = (WORD)container;
    w->Format.nBlockAlign = (WORD)(2 * container / 8);
    w->Format.nAvgBytesPerSec = w->Format.nSamplesPerSec * w->Format.nBlockAlign;
    w->Format.cbSize = 22;
    w->Samples.wValidBitsPerSample = (WORD)valid;
    w->dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    w->SubFormat = flt ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
}

static void dev_close(void) {
    if (g_th) { g_stop = 1; if (g_ev) SetEvent(g_ev); WaitForSingleObject(g_th, 3000); CloseHandle(g_th); g_th = NULL; }
    if (g_cl) { IAudioClient_Stop(g_cl); }
    if (g_rc) { IAudioRenderClient_Release(g_rc); g_rc = NULL; }
    if (g_cl) { IAudioClient_Release(g_cl); g_cl = NULL; }
    if (g_dev) { IMMDevice_Release(g_dev); g_dev = NULL; }
    if (g_ev) { CloseHandle(g_ev); g_ev = NULL; }
    g_stop = 0;
    g_rate = 0;
}

static DWORD WINAPI audio_thread(LPVOID unused) {
    (void)unused;
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    float *tmp = (float *)malloc((size_t)g_buf_frames * 2 * sizeof(float));
    unsigned char *raw = (unsigned char *)malloc((size_t)g_buf_frames * 8 + 16);
    while (!g_stop) {
        DWORD w = WaitForSingleObject(g_ev, 500);
        if (g_stop) break;
        if (w != WAIT_OBJECT_0) { report(); continue; }
        UINT32 frames = g_buf_frames;
        if (!g_exclusive) {
            UINT32 pad = 0;
            if (FAILED(IAudioClient_GetCurrentPadding(g_cl, &pad))) { say("err device lost"); break; }
            frames = g_buf_frames - pad;
        }
        if (!frames) continue;
        BYTE *data = NULL;
        HRESULT hr = IAudioRenderClient_GetBuffer(g_rc, frames, &data);
        if (FAILED(hr)) { say("err device lost (0x%08lx)", (unsigned long)hr); break; }
        if (frames > g_buf_frames) frames = g_buf_frames;
        render_float(tmp, (int)frames);
        if (g_bits == 0) memcpy(data, tmp, (size_t)frames * 8);
        else { convert(tmp, raw, (int)frames); memcpy(data, raw, (size_t)frames * (size_t)bytes_per_frame()); }
        IAudioRenderClient_ReleaseBuffer(g_rc, frames, 0);
        report();
    }
    free(tmp); free(raw);
    if (mm) AvRevertMmThreadCharacteristics(mm);
    return 0;
}

/* try to initialise the client for one format; returns S_OK on success */
static HRESULT try_init(IMMDevice *dev, int exclusive, int rate, int bitsKind, int bufferMs, IAudioClient **out) {
    IAudioClient *cl = NULL;
    HRESULT hr = IMMDevice_Activate(dev, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&cl);
    if (FAILED(hr)) return hr;
    WAVEFORMATEXTENSIBLE wf;
    fill_wfx(&wf, rate, bitsKind);
    REFERENCE_TIME defp = 0, minp = 0;
    IAudioClient_GetDevicePeriod(cl, &defp, &minp);
    if (exclusive) {
        hr = IAudioClient_IsFormatSupported(cl, AUDCLNT_SHAREMODE_EXCLUSIVE, (WAVEFORMATEX *)&wf, NULL);
        if (hr != S_OK) { IAudioClient_Release(cl); return hr; }
        REFERENCE_TIME period = defp;
        if (bufferMs > 0 && (REFERENCE_TIME)bufferMs * 10000 > period) period = (REFERENCE_TIME)bufferMs * 10000;
        hr = IAudioClient_Initialize(cl, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period, (WAVEFORMATEX *)&wf, NULL);
        if (hr == AUDCLNT_E_INVALID_DEVICE_PERIOD && period != defp) {
            IAudioClient_Release(cl);
            IMMDevice_Activate(dev, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&cl);
            hr = IAudioClient_Initialize(cl, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, defp, defp, (WAVEFORMATEX *)&wf, NULL);
        }
        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {      /* HD Audio devices want an aligned buffer */
            UINT32 frames = 0;
            IAudioClient_GetBufferSize(cl, &frames);
            IAudioClient_Release(cl); cl = NULL;
            hr = IMMDevice_Activate(dev, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&cl);
            if (SUCCEEDED(hr)) {
                REFERENCE_TIME p = (REFERENCE_TIME)(10000.0 * 1000.0 / rate * frames + 0.5);
                hr = IAudioClient_Initialize(cl, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, p, p, (WAVEFORMATEX *)&wf, NULL);
            }
        }
    } else {
        hr = IAudioClient_Initialize(cl, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            defp, 0, (WAVEFORMATEX *)&wf, NULL);
    }
    if (FAILED(hr)) { if (cl) IAudioClient_Release(cl); return hr; }
    *out = cl;
    return S_OK;
}

static int backend_open(const char *mode, const char *id, int rate, int bitsPref, int bufferMs, char *err, size_t errn) {
    dev_close();
    int exclusive = strcmp(mode, "shared") != 0;
    if (!get_device(id, &g_dev)) { snprintf(err, errn, "output device not found"); return 0; }
    dev_name(g_dev, g_devname, sizeof g_devname);
    int order[4], n = 0;
    if (!exclusive) order[n++] = 0;                                  /* shared: float, Windows converts */
    else if (bitsPref == 16) order[n++] = 16;
    else if (bitsPref == 24) { order[n++] = 33; order[n++] = 24; }
    else if (bitsPref == 32) order[n++] = 32;
    else { order[n++] = 33; order[n++] = 32; order[n++] = 24; order[n++] = 16; }
    HRESULT hr = E_FAIL, last = E_FAIL;
    int used = -1;
    for (int i = 0; i < n; i++) {
        hr = try_init(g_dev, exclusive, rate, order[i], bufferMs, &g_cl);
        if (SUCCEEDED(hr)) { used = order[i]; break; }
        last = hr;
        if (hr == AUDCLNT_E_DEVICE_IN_USE) { snprintf(err, errn, "device is in use by another program (exclusive mode)"); dev_close(); return 0; }
    }
    if (used < 0) {
        snprintf(err, errn, "%s does not accept %d Hz in %s mode (0x%08lx)", g_devname, rate, exclusive ? "exclusive" : "shared", (unsigned long)last);
        dev_close(); return 0;
    }
    g_ev = CreateEvent(NULL, FALSE, FALSE, NULL);
    IAudioClient_SetEventHandle(g_cl, g_ev);
    IAudioClient_GetBufferSize(g_cl, &g_buf_frames);
    if (FAILED(IAudioClient_GetService(g_cl, &IID_IAudioRenderClient, (void **)&g_rc))) { snprintf(err, errn, "cannot get render client"); dev_close(); return 0; }
    g_exclusive = exclusive; g_bits = used; g_rate = rate; g_dither = (used == 16);
    ring_alloc(rate);
    mutex_lock(&g_lock); eq_recalc(); memset(g_z, 0, sizeof g_z); g_env = 0; mutex_unlock(&g_lock);
    BYTE *data = NULL;                                          /* pre-fill with silence */
    if (SUCCEEDED(IAudioRenderClient_GetBuffer(g_rc, g_buf_frames, &data))) IAudioRenderClient_ReleaseBuffer(g_rc, g_buf_frames, AUDCLNT_BUFFERFLAGS_SILENT);
    g_stop = 0;
    g_th = CreateThread(NULL, 0, audio_thread, NULL, 0, NULL);
    IAudioClient_Start(g_cl);
    return 1;
}

static void backend_caps(const char *mode, const char *id, char *out, size_t n) {
    static const int rates[] = { 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000 };
    IMMDevice *d = NULL;
    out[0] = 0;
    if (!get_device(id, &d)) return;
    int exclusive = strcmp(mode, "shared") != 0;
    for (size_t i = 0; i < sizeof rates / sizeof rates[0]; i++) {
        int ok = 0;
        int kinds[4] = { 33, 32, 24, 16 };
        for (int k = 0; k < 4 && !ok; k++) {
            IAudioClient *cl = NULL;
            if (FAILED(IMMDevice_Activate(d, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&cl))) continue;
            WAVEFORMATEXTENSIBLE wf; fill_wfx(&wf, rates[i], exclusive ? kinds[k] : 0);
            HRESULT hr = IAudioClient_IsFormatSupported(cl, exclusive ? AUDCLNT_SHAREMODE_EXCLUSIVE : AUDCLNT_SHAREMODE_SHARED, (WAVEFORMATEX *)&wf, NULL);
            ok = (hr == S_OK) || (!exclusive && hr == S_FALSE);
            IAudioClient_Release(cl);
            if (!exclusive) break;
        }
        if (ok) { size_t l = strlen(out); snprintf(out + l, n - l, "%s%d", l ? "," : "", rates[i]); }
    }
    IMMDevice_Release(d);
}

static void backend_list(void) {
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (!en_init()) return;
    char defid[512] = "";
    IMMDevice *def = NULL;
    if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(g_en, eRender, eMultimedia, &def))) {
        LPWSTR w = NULL;
        if (SUCCEEDED(IMMDevice_GetId(def, &w))) { narrow(w, defid, sizeof defid); CoTaskMemFree(w); }
        IMMDevice_Release(def);
    }
    IMMDeviceCollection *col = NULL;
    if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(g_en, eRender, DEVICE_STATE_ACTIVE, &col))) return;
    UINT n = 0; IMMDeviceCollection_GetCount(col, &n);
    for (UINT i = 0; i < n; i++) {
        IMMDevice *d = NULL;
        if (FAILED(IMMDeviceCollection_Item(col, i, &d))) continue;
        LPWSTR w = NULL; char id[512] = "", name[256] = "", jid[1100], jname[600];
        if (SUCCEEDED(IMMDevice_GetId(d, &w))) { narrow(w, id, sizeof id); CoTaskMemFree(w); }
        dev_name(d, name, sizeof name);
        json_escape(id, jid, sizeof jid); json_escape(name, jname, sizeof jname);
        printf("{\"id\":\"%s\",\"name\":\"%s\",\"default\":%s}\n", jid, jname, strcmp(id, defid) == 0 ? "true" : "false");
        IMMDevice_Release(d);
    }
    IMMDeviceCollection_Release(col);
    fflush(stdout);
}

static void backend_close(void) { dev_close(); }
static const char *backend_devname(void) { return g_devname; }
static int backend_exclusive(void) { return g_exclusive; }

#else
/* ------------------------------------------------------------------ test sink (non-Windows) */
static FILE *g_sink = NULL;
static pthread_t g_th;
static int g_th_on = 0;
static volatile int g_stop = 0;
static int g_sink_fast = 0;
static char g_devname[64] = "Test sink";
static int g_exclusive = 1;

static int rate_ok(int rate) {
    const char *list = getenv("PRISM_SINK_RATES");
    if (!list) return rate >= 8000 && rate <= 384000;
    char buf[256]; strncpy(buf, list, sizeof buf - 1); buf[sizeof buf - 1] = 0;
    for (char *t = strtok(buf, ","); t; t = strtok(NULL, ",")) if (atoi(t) == rate) return 1;
    return 0;
}

static void *sink_thread(void *unused) {
    (void)unused;
    const int chunk = 480;
    float tmp[480 * 2];
    unsigned char raw[480 * 8];
    while (!g_stop) {
        render_float(tmp, chunk);
        if (g_sink) {
            if (g_bits == 0) fwrite(tmp, 8, chunk, g_sink); else { convert(tmp, raw, chunk); fwrite(raw, (size_t)bytes_per_frame(), chunk, g_sink); }
            fflush(g_sink);
        }
        report();
        if (!g_sink_fast) { struct timespec ts; ts.tv_sec = 0; ts.tv_nsec = (long)((double)chunk / (g_rate ? g_rate : 44100) * 1e9); nanosleep(&ts, NULL); }
        else { struct timespec ts; ts.tv_sec = 0; ts.tv_nsec = 200000; nanosleep(&ts, NULL); }
    }
    return NULL;
}

static void backend_close(void) {
    if (g_th_on) { g_stop = 1; pthread_join(g_th, NULL); g_th_on = 0; }
    g_stop = 0;
    if (g_sink) { fclose(g_sink); g_sink = NULL; }
    g_rate = 0;
}

static int backend_open(const char *mode, const char *id, int rate, int bitsPref, int bufferMs, char *err, size_t errn) {
    (void)id; (void)bufferMs;
    backend_close();
    g_exclusive = strcmp(mode, "shared") != 0;
    if (!rate_ok(rate)) { snprintf(err, errn, "%s does not accept %d Hz in %s mode", g_devname, rate, mode); return 0; }
    g_bits = bitsPref == 16 ? 16 : bitsPref == 32 ? 32 : bitsPref == 24 ? 24 : 33;
    if (!g_exclusive) g_bits = 0;                 /* shared: float */
    g_dither = (g_bits == 16);
    g_rate = rate;
    const char *f = getenv("PRISM_SINK_FILE");
    g_sink = f ? fopen(f, "wb") : NULL;
    g_sink_fast = getenv("PRISM_SINK_FAST") != NULL;
    ring_alloc(rate);
    mutex_lock(&g_lock); eq_recalc(); memset(g_z, 0, sizeof g_z); g_env = 0; mutex_unlock(&g_lock);
    g_stop = 0;
    pthread_create(&g_th, NULL, sink_thread, NULL);
    g_th_on = 1;
    return 1;
}

static void backend_caps(const char *mode, const char *id, char *out, size_t n) {
    static const int rates[] = { 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000 };
    (void)mode; (void)id;
    out[0] = 0;
    for (size_t i = 0; i < sizeof rates / sizeof rates[0]; i++) if (rate_ok(rates[i])) { size_t l = strlen(out); snprintf(out + l, n - l, "%s%d", l ? "," : "", rates[i]); }
}

static void backend_list(void) {
    printf("{\"id\":\"sink0\",\"name\":\"Test sink\",\"default\":true}\n");
    printf("{\"id\":\"sink1\",\"name\":\"Second \\\"test\\\" device\",\"default\":false}\n");
    fflush(stdout);
}
static const char *backend_devname(void) { return g_devname; }
static int backend_exclusive(void) { return g_exclusive; }
#endif

/* ================================================================== command loop */
static int read_full(void *buf, size_t n) {
    size_t got = 0;
    while (got < n) {
        size_t r = fread((char *)buf + got, 1, n - got, stdin);
        if (r == 0) return 0;
        got += r;
    }
    return 1;
}

static void split(char *s, char **parts, int max) {
    int n = 0;
    parts[n++] = s;
    for (char *p = s; *p && n < max; p++) if (*p == '|') { *p = 0; parts[n++] = p + 1; }
    while (n < max) parts[n++] = (char *)"";
}

int main(int argc, char **argv) {
    mutex_init(&g_lock); mutex_init(&g_out);
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (argc > 1 && strcmp(argv[1], "list") == 0) { backend_list(); return 0; }
#ifdef _WIN32
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
#endif
    setvbuf(stdout, NULL, _IOFBF, 1 << 16);
    say("ready");

    unsigned char *payload = NULL; size_t payload_cap = 0;
    for (;;) {
        unsigned char hdr[5];
        if (!read_full(hdr, 5)) break;
        uint32_t len = (uint32_t)hdr[1] | ((uint32_t)hdr[2] << 8) | ((uint32_t)hdr[3] << 16) | ((uint32_t)hdr[4] << 24);
        if (len > (64u << 20)) break;
        if (len + 1 > payload_cap) { payload_cap = len + 1; payload = (unsigned char *)realloc(payload, payload_cap); }
        if (len && !read_full(payload, len)) break;
        payload[len] = 0;
        char cmd = (char)hdr[0];

        if (cmd == 'P') {
            if (len < 4) continue;
            uint32_t ep; memcpy(&ep, payload, 4);
            mutex_lock(&g_lock); int ok = (ep == g_epoch); mutex_unlock(&g_lock);
            if (ok) ring_push((const float *)(payload + 4), (len - 4) / 8);
        } else if (cmd == 'F') {
            uint32_t ep = (uint32_t)strtoul((char *)payload, NULL, 10);
            mutex_lock(&g_lock);
            g_epoch = ep; g_count = 0; g_r = g_w = 0; g_played = 0; g_eoq_epoch = 0xFFFFFFFFu; g_drained_sent = 0; g_prebuf = 1;
            memset(g_z, 0, sizeof g_z);
            mutex_unlock(&g_lock);
        } else if (cmd == 'S') {
            mutex_lock(&g_lock); g_playing = payload[0] == '1'; mutex_unlock(&g_lock);
        } else if (cmd == 'V') {
            double v = atof((char *)payload); if (v < 0) v = 0; if (v > 1) v = 1;
            mutex_lock(&g_lock); g_volume = v; mutex_unlock(&g_lock);
        } else if (cmd == 'E') {
            char *p = (char *)payload;
            int en = (int)strtol(p, &p, 10);
            double pre = strtod(p, &p);
            mutex_lock(&g_lock);
            g_eq_on = en; g_eq_pre = pow(10.0, pre / 20.0);
            for (int b = 0; b < NBANDS; b++) g_eq_gain_db[b] = strtod(p, &p);
            eq_recalc();
            mutex_unlock(&g_lock);
        } else if (cmd == 'Q') {
            uint32_t ep = (uint32_t)strtoul((char *)payload, NULL, 10);
            mutex_lock(&g_lock); g_eoq_epoch = ep; g_drained_sent = 0; mutex_unlock(&g_lock);
        } else if (cmd == 'O') {
            char *parts[5]; split((char *)payload, parts, 5);
            char err[300] = "";
            int rate = atoi(parts[2]), bits = atoi(parts[3]), buf = atoi(parts[4]);
            if (backend_open(parts[0], parts[1], rate, bits, buf, err, sizeof err))
                say("fmt %d %d %s %s", g_rate, g_bits == 0 ? 32 : g_bits == 33 ? 24 : g_bits, backend_exclusive() ? "exclusive" : "shared", backend_devname());
            else say("err %s", err);
        } else if (cmd == 'K') {
            backend_close();
            say("closed");
        } else if (cmd == 'C') {
            char *parts[2]; split((char *)payload, parts, 2);
            char out[256];
            backend_caps(parts[0], parts[1], out, sizeof out);
            say("caps %s", out);
        } else if (cmd == 'X') break;
    }
    backend_close();
    free(payload);
    return 0;
}
