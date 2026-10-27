"""Twist a course piece's mesh into a helicoid about the lane's centre line (the rule of tools/patch_roll.py,
generalised to any mesh). Every piece is spawned with the spawn point's rotation, in whose frame the course runs
along (0, -1, -1)/sqrt2 from the piece's origin, the lane spans x 0..10 and z is up. A point at local y lies on
the lane's cross-section t = -sqrt2 * y along the course (the vertical plane y = const), and the whole
cross-section rotates rigidly about the centre line through (5, 0, 0) by angle = rate * t, so the twist is a
function of the course coordinate alone and any two pieces that met before the twist still meet after it.
Triangles are sliced by the planes y = k * DY first so long edges follow the helix (SEG units of course per slice,
the eight-per-block of the slope helicoid). Meshes here are position + uv0 (20 bytes per vertex), 16-bit indices.
"""
import struct, math
BLOCK = 14.1421356; RATE_DEG = 4.5                     # degrees of roll per lane block
SEG = BLOCK / 8; DY = SEG / math.sqrt(2)                # slice spacing along the course, and in y
AXIS_A = (5.0, 0.0, 0.0); AXIS_D = (0.0, -1 / math.sqrt(2), -1 / math.sqrt(2))
def rot_about_axis(v, th):
    a, d = AXIS_A, AXIS_D; p = (v[0] - a[0], v[1] - a[1], v[2] - a[2]); c, s = math.cos(th), math.sin(th)
    dot = p[0] * d[0] + p[1] * d[1] + p[2] * d[2]
    cr = (d[1] * p[2] - d[2] * p[1], d[2] * p[0] - d[0] * p[2], d[0] * p[1] - d[1] * p[0])
    r = [p[i] * c + cr[i] * s + d[i] * dot * (1 - c) for i in range(3)]
    return (r[0] + a[0], r[1] + a[1], r[2] + a[2])
def angle_at(y, deg_per_block, direction): return direction * math.radians(deg_per_block) / BLOCK * (-math.sqrt(2) * y)
def parse(vdata, idata, vcount, stride=20):
    verts = [struct.unpack_from('<5f', vdata, i * stride) for i in range(vcount)]
    idx = struct.unpack_from('<%dH' % (len(idata) // 2), idata)
    return verts, [(idx[i], idx[i + 1], idx[i + 2]) for i in range(0, len(idx) - 2, 3)]
def lerp(a, b, f): return tuple(a[i] + (b[i] - a[i]) * f for i in range(5))
def split_polygon(poly, c):
    """poly: vertex tuples in order; returns (part with y <= c, part with y >= c), each in the original order"""
    lo, hi = [], []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        (lo if p[1] <= c else hi).append(p)
        if (p[1] < c < q[1]) or (q[1] < c < p[1]):
            m = lerp(p, q, (c - p[1]) / (q[1] - p[1])); lo.append(m); hi.append(m)
        elif p[1] == c: hi.append(p)         # a vertex on the plane belongs to both
    return lo, hi
def slice_triangle(tri, planes):
    """tri: three vertex tuples; planes: sorted y values; yields triangles (fans of the sliced polygons)"""
    polys = [list(tri)]
    for c in planes:
        out = []
        for poly in polys:
            ys = [p[1] for p in poly]
            if min(ys) >= c or max(ys) <= c: out.append(poly); continue
            lo, hi = split_polygon(poly, c)
            if len(lo) >= 3: out.append(lo)
            if len(hi) >= 3: out.append(hi)
        polys = out
    for poly in polys:
        for i in range(1, len(poly) - 1): yield (poly[0], poly[i], poly[i + 1])
def twist(vdata, idata, vcount, direction, deg_per_block=RATE_DEG, stride=20):
    """-> (vdata, idata, vertex count, triangle count, (lo, hi) bounds) of the twisted mesh"""
    verts, tris = parse(vdata, idata, vcount, stride)
    ymin = min(v[1] for v in verts); ymax = max(v[1] for v in verts)
    planes = [k * DY for k in range(int(math.floor(ymin / DY)), int(math.ceil(ymax / DY)) + 1) if ymin < k * DY < ymax]
    out_tris = []
    for a, b, c in tris:
        tri = (verts[a], verts[b], verts[c])
        out_tris += [t for t in slice_triangle(tri, planes) if len({(round(p[0], 5), round(p[1], 5), round(p[2], 5)) for p in t}) == 3]
    keyed = {}; nv = []; ni = []
    for t in out_tris:
        ids = []
        for p in t:
            tp = rot_about_axis(p[:3], angle_at(p[1], deg_per_block, direction))
            key = tuple(round(x, 4) for x in tp) + (round(p[3], 5), round(p[4], 5))
            if key not in keyed: keyed[key] = len(nv); nv.append(tp + (p[3], p[4]))
            ids.append(keyed[key])
        ni += ids
    assert len(nv) < 65535, 'too many vertices after slicing: %d' % len(nv)
    xs = [v[0] for v in nv]; ys = [v[1] for v in nv]; zs = [v[2] for v in nv]
    return (b''.join(struct.pack('<5f', *v) for v in nv), struct.pack('<%dH' % len(ni), *ni), len(nv), len(ni) // 3,
            ((min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))))
