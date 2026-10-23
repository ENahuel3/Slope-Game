"""Compress / decompress .unityweb files the way Unity's loader expects: gzip with the comment field set to
"UnityWeb Compressed Content (gzip)". unityloader41.js only inflates a gzip stream that carries that marker
(UnityLoader.Compression.gzip.hasUnityMarker); any other gzip is passed to the engine as-is and fails to load.
Upstream shipped the engine files compressed this way but the data bundle raw (8.6 MB; 2.6 MB compressed).
usage: unitygz.py <in> <out>            compress (a raw UnityWebData1.0 bundle or any file)
       unitygz.py -d <in> <out>         decompress
As a module: compress(bytes) -> bytes, decompress(bytes) -> bytes (passes a raw bundle through unchanged)."""
import sys, zlib, struct, gzip, io

MARKER = b'UnityWeb Compressed Content (gzip)'

def is_gzip(b): return len(b) > 2 and b[0] == 0x1f and b[1] == 0x8b

def compress(data, name=b'slope_data.unityweb'):
    hdr = b'\x1f\x8b\x08' + bytes([0x08 | 0x10]) + struct.pack('<I', 0) + b'\x02\x03'   # FNAME | FCOMMENT, max compression, Unix
    hdr += name + b'\0' + MARKER + b'\0'
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    body = c.compress(data) + c.flush()
    return hdr + body + struct.pack('<II', zlib.crc32(data) & 0xffffffff, len(data) & 0xffffffff)

def decompress(b):
    return gzip.GzipFile(fileobj=io.BytesIO(b)).read() if is_gzip(b) else b

if __name__ == '__main__':
    a = [x for x in sys.argv[1:] if not x.startswith('-')]
    if len(a) != 2: sys.exit(__doc__)
    raw = open(a[0], 'rb').read()
    out = decompress(raw) if '-d' in sys.argv else compress(decompress(raw))
    open(a[1], 'wb').write(out); print(a[1], len(raw), '->', len(out))
