"""Background figure meshes: a procedural Minecraft-style zombie and a downloaded
Mort (Madagascar) model; attribution/rebuild details are in assets/mort/README.md.
Meshes return vertices, UVs and triangles in a right-handed frame, +y up and
facing -z. Zombies tile the neon-outline texture; Mort samples its original textures in an atlas.
Winding: front='ccw' or 'cw' viewed from outside.
"""
import math

class Mesh:
    def __init__(s, front): s.v, s.uv, s.t, s.front = [], [], [], front
    def quad(s, a, b, c, d, uvs=None):
        """a,b,c,d counter-clockwise when viewed from outside"""
        i = len(s.v); s.v += [a, b, c, d]
        s.uv += uvs or [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]   # one outline tile per face: crisp blocky edges, like the game's obstacle cubes
        if s.front == 'ccw': s.t += [(i, i + 1, i + 2), (i, i + 2, i + 3)]
        else: s.t += [(i, i + 2, i + 1), (i, i + 3, i + 2)]
    def box(s, x0, y0, z0, x1, y1, z1):
        P = lambda a, b, c: (a, b, c)
        s.quad(P(x0,y0,z1), P(x1,y0,z1), P(x1,y1,z1), P(x0,y1,z1))   # +z
        s.quad(P(x1,y0,z0), P(x0,y0,z0), P(x0,y1,z0), P(x1,y1,z0))   # -z
        s.quad(P(x1,y0,z1), P(x1,y0,z0), P(x1,y1,z0), P(x1,y1,z1))   # +x
        s.quad(P(x0,y0,z0), P(x0,y0,z1), P(x0,y1,z1), P(x0,y1,z0))   # -x
        s.quad(P(x0,y1,z1), P(x1,y1,z1), P(x1,y1,z0), P(x0,y1,z0))   # +y
        s.quad(P(x0,y0,z0), P(x1,y0,z0), P(x1,y0,z1), P(x0,y0,z1))   # -y
    def ellipsoid(s, cx, cy, cz, rx, ry, rz, seg=8, rings=6, tilt=0.0):
        """lat/long sphere scaled to radii, vertices shared along the grid (uv = grid/2, the texture tiles);
        `tilt` rotates about x (radians) for ears/tail pieces"""
        ct, st = math.cos(tilt), math.sin(tilt); base = len(s.v)
        for j in range(rings + 1):
            for i in range(seg + 1):
                th = math.pi * j / rings; ph = 2 * math.pi * i / seg
                x, y, z = rx * math.sin(th) * math.cos(ph), ry * math.cos(th), rz * math.sin(th) * math.sin(ph)
                y, z = y * ct - z * st, y * st + z * ct
                s.v.append((cx + x, cy + y, cz + z)); s.uv.append((float(i), float(j)))   # one outline tile per quad
        V = lambda i, j: base + j * (seg + 1) + i
        for j in range(rings):
            for i in range(seg):
                a, b, c, d = V(i, j + 1), V(i + 1, j + 1), V(i + 1, j), V(i, j)   # ccw from outside
                if s.front == 'ccw': s.t += [(a, b, c), (a, c, d)]
                else: s.t += [(a, c, b), (a, d, c)]
    def translate(s, dx, dy, dz): s.v = [(x + dx, y + dy, z + dz) for x, y, z in s.v]

def zombie(front, u=20.0):
    """Minecraft zombie in the classic pose: arms straight out in front, facing -z. Feet at y=0, 32u tall, 8u wide."""
    m = Mesh(front)
    m.box(-4*u, 24*u, -4*u, 4*u, 32*u, 4*u)            # head 8x8x8
    m.box(-4*u, 12*u, -2*u, 4*u, 24*u, 2*u)            # body 8x12x4
    m.box(-4*u, 0, -2*u, 0, 12*u, 2*u)                 # left leg 4x12x4
    m.box(0, 0, -2*u, 4*u, 12*u, 2*u)                  # right leg
    m.box(-8*u, 20*u, -14*u, -4*u, 24*u, 2*u)          # left arm, out to the front (4 wide, 4 tall, 16 long)
    m.box(4*u, 20*u, -14*u, 8*u, 24*u, 2*u)            # right arm
    return m

def mort(front, u=100.0):
    """Textured Mort V2 by calvinwil5782; see assets/mort/README.md.
    The import preserves the original texture UVs, +y up and -z front.
    """
    import json
    from pathlib import Path
    data = json.loads((Path(__file__).resolve().parent / 'assets/mort/mesh.json').read_text())
    m = Mesh(front)
    m.v = [tuple(c * u / 100 for c in p) for p in data['vertices']]
    m.uv = [tuple(p) for p in data['uvs']]
    m.t = [tuple(t if front == 'ccw' else (t[0], t[2], t[1])) for t in data['triangles']]
    return m

def preview(meshes, path, size=400):
    """orthographic wireframe preview (front and side views), for a sanity check"""
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (size * len(meshes) * 2, size), 'black'); dr = ImageDraw.Draw(im)
    for k, m in enumerate(meshes):
        ys = [p[1] for p in m.v]; sc = (size - 20) / (max(ys) - min(ys)); y0 = min(ys)
        for view in range(2):
            ox = (k * 2 + view) * size + size / 2
            pr = (lambda p: (ox + p[0] * sc, size - 10 - (p[1] - y0) * sc)) if view == 0 else (lambda p: (ox + p[2] * sc, size - 10 - (p[1] - y0) * sc))
            for a, b, c in m.t:
                for i, j in ((a, b), (b, c), (c, a)): dr.line([pr(m.v[i]), pr(m.v[j])], fill=(0, 230, 120))
    im.save(path)

if __name__ == '__main__':
    import sys
    z, mo = zombie('ccw'), mort('ccw')
    print('zombie verts %d tris %d; mort verts %d tris %d' % (len(z.v), len(z.t), len(mo.v), len(mo.t)))
    preview([z, mo], sys.argv[1] if len(sys.argv) > 1 else 'figures.png')
