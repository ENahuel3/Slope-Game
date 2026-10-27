"""Tile screenshots into one labelled image. usage: montage.py <out.png> <img>..."""
import os, sys
from PIL import Image, ImageDraw
out, fs = sys.argv[1], sys.argv[2:]
W, H, cols = 320, 200, 4; rows = (len(fs) + cols - 1) // cols
m = Image.new('RGB', (W * cols, H * rows))
for i, f in enumerate(fs):
    im = Image.open(f).convert('RGB').resize((W, H)); ImageDraw.Draw(im).text((4, 4), os.path.basename(f), fill=(255, 0, 0))
    m.paste(im, ((i % cols) * W, (i // cols) * H))
m.save(out)
