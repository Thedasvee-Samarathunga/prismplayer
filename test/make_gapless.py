#!/usr/bin/env python3
"""Creates a continuous test signal and splits it into FLAC "album tracks" at exact sample positions.
Concatenating the decoded tracks must give back the original signal bit for bit (that is what gapless means).
Usage: make_gapless.py OUTDIR  -> writes OUTDIR/t1.flac t2.flac t3.flac and OUTDIR/expected.s16 (raw, mono-interleaved stereo int16)"""
import sys, os, numpy as np, soundfile as sf
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
sr = 44100; lens = [2 * sr + 137, 2 * sr + 4001, int(1.5 * sr) + 55]   # deliberately not multiples of any frame size
n = sum(lens)
t = np.arange(n)
left = np.round(12000 * np.sin(2 * np.pi * 440 * t / sr) + 1500).astype(np.int16)
right = np.round(9000 * np.sin(2 * np.pi * 660 * t / sr + 0.3) - 1500).astype(np.int16)
sig = np.stack([left, right], axis=1)
pos = 0
for i, l in enumerate(lens):
    sf.write(os.path.join(out, f"t{i + 1}.flac"), sig[pos:pos + l], sr, subtype="PCM_16")
    pos += l
sig.astype('<i2').tofile(os.path.join(out, "expected.s16"))
print(n)
