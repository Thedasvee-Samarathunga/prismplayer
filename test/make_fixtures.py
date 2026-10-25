#!/usr/bin/env python3
"""Builds a small test music library in the given directory (default ./fixtures) using ffmpeg + PIL.
Covers every format the player claims to support, incl. a real DSF file, embedded + folder cover art."""
import os, subprocess, sys, struct, shutil, math
from PIL import Image, ImageDraw

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
shutil.rmtree(root, ignore_errors=True)
os.makedirs(root)
here = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(here, "dsd_gen")):  # tiny 1-bit sigma-delta generator for the DSF test file
    subprocess.run(["gcc", "-O2", "-o", os.path.join(here, "dsd_gen"), os.path.join(here, "dsd_gen.c"), "-lm"], check=True)

def run(*a):
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED:", " ".join(a), "\n", r.stderr[-600:]); sys.exit(1)

def cover(path, c1, c2, kind="grad"):
    im = Image.new("RGB", (600, 600), c1)
    d = ImageDraw.Draw(im)
    if kind == "grad":
        for y in range(600):
            t = y / 599
            d.line([(0, y), (600, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
        d.ellipse((150, 150, 450, 450), fill=c2, outline=c1, width=12)
    im.save(path, quality=92)

def tone(out, freq, secs=6, extra=(), meta=None, cov=None, sr=44100, ch=2):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={secs}:sample_rate={sr}"]
    if cov:
        cmd += ["-i", cov]
    cmd += ["-ac", str(ch)]
    if cov:
        cmd += ["-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic"]
    cmd += list(extra)
    for k, v in (meta or {}).items():
        cmd += ["-metadata", f"{k}={v}"]
    cmd += [out]
    run(*cmd)

def alb(artist, album, year, genre="Test"):
    d = os.path.join(root, artist, album)
    os.makedirs(d, exist_ok=True)
    return d, dict(artist=artist, album=album, date=str(year), genre=genre, album_artist=artist)

# ---- Album One: red, embedded art ----
d, m = alb("Aurora Fox", "Crimson Tide", 2021)
cover(os.path.join(d, "_c.jpg"), (150, 20, 30), (240, 90, 60))
c = os.path.join(d, "_c.jpg")
tone(os.path.join(d, "01 Ember.mp3"), 440, extra=["-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3"], meta={**m, "title": "Ember", "track": "1/4"}, cov=c)
tone(os.path.join(d, "02 Flame.flac"), 523, extra=["-c:a", "flac"], meta={**m, "title": "Flame", "track": "2/4", "REPLAYGAIN_TRACK_GAIN": "-3.50 dB"}, cov=c)
tone(os.path.join(d, "03 Spark.m4a"), 659, extra=["-c:a", "aac", "-b:a", "128k"], meta={**m, "title": "Spark", "track": "3/4"}, cov=c)
tone(os.path.join(d, "04 Ash.wav"), 784, extra=["-c:a", "pcm_s24le"], meta={**m, "title": "Ash", "track": "4/4"})
shutil.copy(c, os.path.join(d, "cover.jpg")); os.remove(c)

# ---- Album Two: teal folder-art, lots of 'other' formats ----
d, m = alb("Blue Harbor", "Deep Water", 2019, "Ambient")
cover(os.path.join(d, "cover.jpg"), (10, 70, 90), (40, 190, 170))
tone(os.path.join(d, "01 Tide.ogg"), 330, extra=["-c:a", "libvorbis"], meta={**m, "title": "Tide", "track": "1/6"})
tone(os.path.join(d, "02 Swell.opus"), 392, extra=["-c:a", "libopus", "-ar", "48000"], meta={**m, "title": "Swell", "track": "2/6"})
tone(os.path.join(d, "03 Reef.m4a"), 466, extra=["-c:a", "alac"], meta={**m, "title": "Reef (ALAC)", "track": "3/6"})
tone(os.path.join(d, "04 Kelp.wv"), 554, extra=["-c:a", "wavpack"], meta={**m, "title": "Kelp (WavPack)", "track": "4/6"})
tone(os.path.join(d, "05 Pearl.wma"), 622, extra=["-c:a", "wmav2"], meta={**m, "title": "Pearl (WMA)", "track": "5/6"})
tone(os.path.join(d, "06 Brine.tta"), 740, extra=["-c:a", "tta"], meta={**m, "title": "Brine (TTA)", "track": "6/6"})

# ---- Album Three: hi-res 96k/24 flac, bright near-white cover (contrast stress) ----
d, m = alb("Cirrus", "Overexposed", 2023, "Electronic")
cover(os.path.join(d, "cover.png"), (250, 248, 240), (235, 235, 225))
tone(os.path.join(d, "01 White Out.flac"), 880, secs=5, extra=["-c:a", "flac", "-sample_fmt", "s32", "-ar", "96000"], meta={**m, "title": "White Out (96k/24)", "track": "1/2"}, sr=96000)
tone(os.path.join(d, "02 Glare.aiff"), 988, secs=5, extra=["-c:a", "pcm_s16be"], meta={**m, "title": "Glare (AIFF)", "track": "2/2"})

# ---- Album Four: near-black cover (stress), 5.1-ish downmix test = mono file ----
d, m = alb("Dusk Static", "Void", 2018, "Noise")
cover(os.path.join(d, "folder.jpg"), (4, 4, 6), (12, 10, 16), kind="flat")
tone(os.path.join(d, "01 Nothing.mp3"), 220, extra=["-c:a", "libmp3lame", "-q:a", "4"], meta={**m, "title": "Nothing (mono)", "track": "1/1"}, ch=1)

# ---- No art, no tags ----
d = os.path.join(root, "Loose Files")
os.makedirs(d)
tone(os.path.join(d, "untitled recording.mp3"), 300, secs=4, extra=["-c:a", "libmp3lame", "-q:a", "6"])

# ---- Long track (scrobbling needs >30 s) ----
d, m = alb("Long Distance", "Marathon", 2022, "Test")
cover(os.path.join(d, "cover.jpg"), (200, 140, 20), (250, 220, 90))
tone(os.path.join(d, "01 Endurance.mp3"), 350, secs=40, extra=["-c:a", "libmp3lame", "-b:a", "96k"], meta={**m, "title": "Endurance", "track": "1/1"})

# ---- DSD (DSF) from a real sigma-delta modulator ----
d, m = alb("Sigma Delta", "One Bit", 2020, "Test")
cover(os.path.join(d, "cover.jpg"), (90, 40, 140), (230, 120, 220))
secs = 5
subprocess.run([os.path.join(here, "dsd_gen"), str(secs), os.path.join(root, "_dsd")], check=True)
L = open(os.path.join(root, "_dsd_0.bin"), "rb").read()
R = open(os.path.join(root, "_dsd_1.bin"), "rb").read()
BS = 4096
nblocks = len(L) // BS
data = bytearray()
for b in range(nblocks):
    data += L[b * BS:(b + 1) * BS] + R[b * BS:(b + 1) * BS]
def frame(fid, text):
    t = b"\x00" + text.encode("latin-1")
    return fid.encode() + struct.pack(">I", len(t)) + b"\x00\x00" + t
frames = b"".join([frame("TIT2", "One Bit Wonder"), frame("TPE1", "Sigma Delta"), frame("TALB", "One Bit"), frame("TYER", "2020"), frame("TRCK", "1/1"), frame("TCON", "Test")])
def synch(n): return bytes([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])
id3 = b"ID3\x03\x00\x00" + synch(len(frames)) + frames
data_chunk_size = 12 + len(data)
fmt = b"fmt " + struct.pack("<Q", 52) + struct.pack("<IIIIIIQI", 1, 0, 2, 2, 2822400, 1, len(L) * 8, BS) + b"\x00\x00\x00\x00"
meta_ptr = 28 + len(fmt) + data_chunk_size
total = meta_ptr + len(id3)
dsd_hdr = b"DSD " + struct.pack("<QQQ", 28, total, meta_ptr)
with open(os.path.join(d, "01 One Bit Wonder.dsf"), "wb") as f:
    f.write(dsd_hdr + fmt + b"data" + struct.pack("<Q", data_chunk_size) + bytes(data) + id3)
for x in ("_dsd_0.bin", "_dsd_1.bin"):
    os.remove(os.path.join(root, x))

n = sum(len(fs) for _, _, fs in os.walk(root))
print(f"fixtures ready: {n} files in {root}")
