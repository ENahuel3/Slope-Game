"""Rebuild a UnityWebData1.0 container, replacing one entry. usage: pack_webdata.py <in .unityweb> <entry path> <replacement file> <out .unityweb> [--raw]
The input may be raw or gzip-wrapped; the output is gzip-wrapped with the Unity marker (tools/unitygz.py) unless --raw is given."""
import struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unitygz import compress, decompress
src, entry, repl, out = [x for x in sys.argv[1:] if not x.startswith('--')][:4]
b = decompress(open(src, 'rb').read()); assert b.startswith(b'UnityWebData1.0\0')
pos = 16; (begin,) = struct.unpack_from('<I', b, pos); pos += 4
entries = []
while pos < begin:
    off, size, plen = struct.unpack_from('<III', b, pos); pos += 12
    path = b[pos:pos+plen].decode(); pos += plen
    entries.append([path, b[off:off+size]])
new = open(repl, 'rb').read()
for e in entries:
    if e[0] == entry: print("replacing", entry, len(e[1]), "->", len(new)); e[1] = new
hdr_len = 16 + 4 + sum(12 + len(e[0].encode()) for e in entries)
out_b = bytearray(b'UnityWebData1.0\0' + struct.pack('<I', hdr_len))
off = hdr_len; blobs = bytearray()
for path, data in entries:
    out_b += struct.pack('<III', off, len(data), len(path.encode())) + path.encode()
    blobs += data; off += len(data)
out_b += blobs
final = bytes(out_b) if '--raw' in sys.argv else compress(bytes(out_b))
open(out, 'wb').write(final); print("wrote", out, len(final), "bytes" + ("" if '--raw' in sys.argv else " (gzip, raw %d)" % len(out_b)))
