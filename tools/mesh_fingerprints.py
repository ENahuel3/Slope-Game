"""Fingerprints of the game's meshes as TemplateData/coins.js recognises them: the game uploads every mesh's
vertex data to WebGL byte for byte, so a mesh is "<bytes>/<FNV-1a hash of the first 256 bytes>" of that upload.
Prints the table for the scene bundle (and the whole index data's hash, for reference).
usage: mesh_fingerprints.py <data.unity3d (tools/unpack_webdata.py)> [name-filter]"""
import sys, UnityPy
env = UnityPy.load(sys.argv[1]); flt = sys.argv[2] if len(sys.argv) > 2 else ''
def fnv(b):
    h = 0x811c9dc5
    for x in b: h = ((h ^ x) * 0x01000193) & 0xffffffff
    return h
seen = set()
for o in env.objects:
    if o.type.name != 'Mesh': continue
    m = o.read(); data = bytes(m.m_VertexData.m_DataSize); ib = bytes(m.m_IndexBuffer)
    if flt and flt.lower() not in m.m_Name.lower(): continue
    key = (m.m_Name, len(data), fnv(data[:256]))
    if key in seen: continue
    seen.add(key)
    print('%-24s "%d/%08x"  verts=%6d tris=%6d  index-data fnv=%08x  (%s)' % (m.m_Name, len(data), fnv(data[:256]), m.m_VertexData.m_VertexCount, len(ib) // 6, fnv(ib), o.assets_file.name.split('/')[-1]))
