"""Build the coin mesh the mod renders (TemplateData/coins/coin.json + coin.png) from the downloaded model in
tools/assets/coin/source: plaggy's "cc0 - gold coin blank" (https://opengameart.org/node/132629, CC0), glTF export.
The disc lies in the model's xy-plane (thin along z); it is centred and scaled to RADIUS. Positions, normals, UVs
and the index list go into one compact JSON; the base colour texture is shrunk to a small square (the mod shades it
per vertex, the 2000s way, so a big texture would be wasted).
usage: import_coin.py [--radius 0.8] [--tex 128]"""
import json, struct, math, os, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.join(HERE, 'assets', 'coin', 'source'); OUT = os.path.join(HERE, '..', 'TemplateData', 'coins')
RADIUS = float(sys.argv[sys.argv.index('--radius') + 1]) if '--radius' in sys.argv else 0.8
TEX = int(sys.argv[sys.argv.index('--tex') + 1]) if '--tex' in sys.argv else 128
j = json.load(open(os.path.join(SRC, 'scene.gltf'))); bin_ = open(os.path.join(SRC, 'scene.bin'), 'rb').read()
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; st = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]; fmt = {5126: 'f', 5123: 'H', 5125: 'I'}[a['componentType']]; sz = struct.calcsize(fmt); stride = bv.get('byteStride', n * sz)
    return [struct.unpack_from('<%d%s' % (n, fmt), bin_, st + k * stride) for k in range(a['count'])]
p = j['meshes'][0]['primitives'][0]
P = acc(p['attributes']['POSITION']); N = acc(p['attributes']['NORMAL']); UV = acc(p['attributes']['TEXCOORD_0']); I = [x[0] for x in acc(p['indices'])]
cx = (min(v[0] for v in P) + max(v[0] for v in P)) / 2; cy = (min(v[1] for v in P) + max(v[1] for v in P)) / 2; cz = (min(v[2] for v in P) + max(v[2] for v in P)) / 2
r = max(math.hypot(v[0] - cx, v[1] - cy) for v in P); sc = RADIUS / r
out = {'radius': RADIUS, 'source': 'plaggy, "cc0 - gold coin blank", https://opengameart.org/node/132629 (CC0), via tools/import_coin.py',
       'p': [round((v[i] - (cx, cy, cz)[i]) * sc, 4) for v in P for i in range(3)], 'n': [round(c, 3) for v in N for c in v], 't': [round(c, 4) for v in UV for c in v], 'i': I}
os.makedirs(OUT, exist_ok=True)
json.dump(out, open(os.path.join(OUT, 'coin.json'), 'w'), separators=(',', ':'))
Image.open(os.path.join(SRC, 'baseColor-512.png')).convert('RGB').resize((TEX, TEX), Image.LANCZOS).save(os.path.join(OUT, 'coin.png'), optimize=True)
print('coin.json: %d verts, %d tris, radius %.2f, thickness %.3f; coin.png %dx%d' % (len(P), len(I) // 3, RADIUS, (max(v[2] for v in P) - min(v[2] for v in P)) * sc, TEX, TEX))
