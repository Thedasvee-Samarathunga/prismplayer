#!/usr/bin/env python3
"""Builds the Windows icon files from build/icon-1024.png (needs Pillow: pip install pillow).

  build/icon.ico       the program's icon (Prism Player.exe, shortcuts, taskbar). The standard Windows layout: classic 32-bit bitmaps for 16-128 px, PNG for the 256 px picture.
  build/installer.ico  for the installer / uninstaller (NSIS): ONLY classic bitmaps (NSIS is picky about PNG-compressed pictures)
  build/icon.png       512 px PNG (the window / taskbar icon inside the app, and the fallback for electron-builder)
  src/ui/icon.png      256 px PNG (the page icon)

The files are written by this script itself (not by Pillow's ICO writer, which stores every picture PNG-compressed), so the layout is exactly what is described above.
Run:  python scripts/make-icons.py
"""
import io, os, struct, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build', 'icon-1024.png')

def scaled(im, n):
    # step down by halves, then the last step with Lanczos: much cleaner small sizes than one big jump
    cur = im
    while cur.width > n * 2:
        cur = cur.resize((cur.width // 2, cur.height // 2), Image.LANCZOS)
    return cur.resize((n, n), Image.LANCZOS)

def bmp_entry(img):
    """An icon picture as a classic DIB: BITMAPINFOHEADER (height = 2 x), 32-bit BGRA bottom-up, then the 1-bit AND mask (all zero: the alpha channel does the shaping)."""
    w, h = img.size
    px = img.convert('RGBA').tobytes('raw', 'BGRA')
    rows = [px[y * w * 4:(y + 1) * w * 4] for y in range(h)]
    pixels = b''.join(reversed(rows))
    mask_row = ((w + 31) // 32) * 4
    mask = bytes(mask_row * h)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return header + pixels + mask

def png_entry(img):
    b = io.BytesIO(); img.convert('RGBA').save(b, 'PNG', optimize=True); return b.getvalue()

def write_ico(path, pictures):
    """pictures: [(size, bytes)] in the order they are stored"""
    n = len(pictures)
    out = bytearray(struct.pack('<HHH', 0, 1, n))
    offset = 6 + 16 * n
    entries = bytearray(); data = bytearray()
    for size, blob in pictures:
        entries += struct.pack('<BBBBHHII', 0 if size >= 256 else size, 0 if size >= 256 else size, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    open(path, 'wb').write(bytes(out + entries + data))

def main():
    if not os.path.exists(SRC):
        sys.exit('missing ' + SRC)
    big = Image.open(SRC).convert('RGBA')
    if big.width < 256 or big.width != big.height:
        sys.exit('build/icon-1024.png must be a square picture of at least 256 px')
    sizes = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256]
    pics = {n: scaled(big, n) for n in sizes}
    write_ico(os.path.join(ROOT, 'build', 'icon.ico'), [(n, bmp_entry(pics[n]) if n < 256 else png_entry(pics[n])) for n in sizes])
    write_ico(os.path.join(ROOT, 'build', 'installer.ico'), [(n, bmp_entry(pics[n])) for n in [16, 24, 32, 48, 64, 128, 256]])
    scaled(big, 512).save(os.path.join(ROOT, 'build', 'icon.png'), optimize=True)
    scaled(big, 256).save(os.path.join(ROOT, 'src', 'ui', 'icon.png'), optimize=True)
    for f in ['build/icon.ico', 'build/installer.ico', 'build/icon.png', 'src/ui/icon.png']:
        print(f, os.path.getsize(os.path.join(ROOT, f)), 'bytes')

if __name__ == '__main__':
    main()
