"""Lane-frame geometry of every track piece from its mesh and a real draw matrix: floor height, clearance and the
reachable set of the ball's centre; then coin positions that a ball can actually pass through."""
import json, math, sys
SP = sys.argv[1]   # folder with meshes.json (tools/mesh_export.py) and matrices.json (SlopeCoins.matrices() from a vanilla run)
M = json.load(open(SP + '/meshes.json')); mats = json.load(open(SP + '/matrices.json'))['matrices']
R2 = 0.70710678
def mulv(m, v): return [m[0]*v[0]+m[4]*v[1]+m[8]*v[2], m[1]*v[0]+m[5]*v[1]+m[9]*v[2], m[2]*v[0]+m[6]*v[1]+m[10]*v[2]]
def mulp(m, p): v = mulv(m, p); return [v[0]+m[12], v[1]+m[13], v[2]+m[14]]
def norm(v): l = math.hypot(*v) or 1; return [x/l for x in v]
def dot(a, b): return sum(x*y for x, y in zip(a, b))
def cross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def sub(a, b): return [x-y for x, y in zip(a, b)]
def ray_tri(o, d, a, b, c):   # Moller-Trumbore, returns t or None
    e1, e2 = sub(b, a), sub(c, a); p = cross(d, e2); det = dot(e1, p)
    if abs(det) < 1e-9: return None
    inv = 1/det; tv = sub(o, a); u = dot(tv, p)*inv
    if u < -1e-6 or u > 1+1e-6: return None
    q = cross(tv, e1); v = dot(d, q)*inv
    if v < -1e-6 or u+v > 1+1e-6: return None
    return dot(e2, q)*inv
BALL = 0.5
def analyse(kind, mkey=None):
    m = mats[mkey or kind]; mesh = M[kind]
    up = norm(mulv(m, [0, -R2, R2])); fwd = norm(mulv(m, [0, -R2, -R2])); right = norm(cross(up, fwd)); org = [m[12], m[13], m[14]]
    W = [mulp(m, v) for v in mesh['v']]
    L = [[dot(sub(w, org), right), dot(sub(w, org), fwd), dot(sub(w, org), up)] for w in W]   # lane coords (x, s, n)
    tris = [[L[i] for i in t] for t in mesh['t']]
    xs = [p[0] for p in L]; ss = [p[1] for p in L]; ns = [p[2] for p in L]
    info = {'x': (min(xs), max(xs)), 's': (min(ss), max(ss)), 'n': (min(ns), max(ns))}
    def column(x, s):      # all surfaces crossed by the vertical line at (x, s): sorted n values
        o = [x, s, 100.0]; d = [0, 0, -1.0]; hits = []
        for a, b, c in tris:
            t = ray_tri(o, d, a, b, c)
            if t is not None: hits.append(100.0 - t)
        return sorted(set(round(h, 3) for h in hits))
    def floor_clear(x, s):
        h = column(x, s)
        if not h: return None, None
        lo = h[0]; above = [v for v in h if v > lo + 0.05]
        return lo, (above[0] - lo if above else 99.0)
    return info, floor_clear, column
def reachable(fc, x, s, clear_min=1.05, foot=0.45):
    """the ball's centre can be at (x, s): floor under its footprint and headroom for its diameter"""
    f0, c0 = fc(x, s)
    if f0 is None or c0 < clear_min: return None
    for dx, ds in ((foot, 0), (-foot, 0), (0, foot), (0, -foot)):
        f, c = fc(x+dx, s+ds)
        if f is None or abs(f - f0) > 0.6 or c < clear_min: return None
    return f0
if __name__ == '__main__':
    for kind in sorted(M):
        if kind not in mats: print(kind, 'no matrix'); continue
        info, fc, col = analyse(kind)
        print('== %s  x[%.1f,%.1f] s[%.1f,%.1f] n[%.1f,%.1f]' % (kind, *info['x'], *info['s'], *info['n']))
        # floor profile along the centre and the reachable x-span at a few stations
        for s in [info['s'][0] + (info['s'][1]-info['s'][0]) * f for f in (0.1, 0.3, 0.5, 0.7, 0.9)]:
            xr = [x/4 for x in range(int(info['x'][0]*4)-2, int(info['x'][1]*4)+3)]
            reach = [(x, reachable(fc, x, s)) for x in xr]
            ok = [(x, f) for x, f in reach if f is not None]
            mid = (info['x'][0]+info['x'][1])/2; f, c = fc(mid, s)
            print('   s=%6.1f centre floor=%s clear=%s | reachable x %s..%s (%d pts) floor %s..%s' % (s, None if f is None else round(f,2), None if c is None else round(c,2), ok[0][0] if ok else None, ok[-1][0] if ok else None, len(ok), round(min(x[1] for x in ok),2) if ok else None, round(max(x[1] for x in ok),2) if ok else None))
