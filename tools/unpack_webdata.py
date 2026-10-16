import struct, sys, os
src, out = sys.argv[1], sys.argv[2]
b = open(src, 'rb').read()
assert b.startswith(b'UnityWebData1.0\0'), b[:16]
pos = 16
(begin,) = struct.unpack_from('<I', b, pos); pos += 4
while pos < begin:
    off, size, plen = struct.unpack_from('<III', b, pos); pos += 12
    path = b[pos:pos+plen].decode(); pos += plen
    print(f'{off:>10} {size:>10} {path}')
    dst = os.path.join(out, path.replace('/', '_'))
    open(dst, 'wb').write(b[off:off+size])
