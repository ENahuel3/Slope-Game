import json, math, sys
sys.path.insert(0, sys.argv[1]); SP = sys.argv[1]
import geometry as G
M = G.M; mats = G.mats; R2 = G.R2
FWD_W = [0, -R2, R2]; UP_W = [0, R2, R2]; RIGHT_W = [1, 0, 0]
BALL = 0.5; CLEAR = 1.05
def lane_tris(kind):
    m = mats[kind]; mesh = M[kind]; org = [m[12], m[13], m[14]]
    W = [G.mulp(m, v) for v in mesh['v']]
    L = [[G.dot(G.sub(w, org), RIGHT_W), G.dot(G.sub(w, org), FWD_W), G.dot(G.sub(w, org), UP_W)] for w in W]
    tris = []
    for t in mesh['t']:
        a, b, c = L[t[0]], L[t[1]], L[t[2]]
        n = G.cross(G.sub(b, a), G.sub(c, a)); tris.append((a, b, c, n[2] < 0))   # Unity winds clockwise: the outward normal is minus the CCW cross product
    return tris, L
def make_fc(tris):
    def column(x, s):
        o = [x, s, 200.0]; d = [0, 0, -1.0]; hits = []
        for a, b, c, up in tris:
            t = G.ray_tri(o, d, a, b, c)
            if t is not None: hits.append((round(200.0 - t, 3), up))
        hits.sort(); return hits
    def fc(x, s):
        """walkable floor at (x, s): the lowest upward face with ball headroom above it; returns (floor, clearance)"""
        h = column(x, s)
        for i, (n, up) in enumerate(h):
            if not up: continue
            above = [v for v, _ in h[i+1:] if v > n + 0.02]
            clear = (above[0] - n) if above else 99.0
            if clear >= CLEAR: return n, clear
        return None, None
    return fc, column
def reach(fc, x, s, foot=0.45):
    f0, c0 = fc(x, s)
    if f0 is None: return None
    for dx, ds in ((foot, 0), (-foot, 0)):
        f, c = fc(x+dx, s+ds)
        if f is None or abs(f - f0) > 0.6: return None
    return f0
OUT = {}
for kind in sorted(M):
    if kind not in mats: continue
    tris, L = lane_tris(kind); fc, col = make_fc(tris)
    xs = [p[0] for p in L]; ss = [p[1] for p in L]
    x0, x1, s0, s1 = min(xs), max(xs), min(ss), max(ss)
    print('== %s x[%.1f,%.1f] s[%.1f,%.1f]' % (kind, x0, x1, s0, s1))
    rows = []
    step = 1.0 if (s1 - s0) < 60 else 4.0
    s = s0
    while s <= s1 + 1e-6:
        xr = [x/4 for x in range(int(math.floor(x0*4)), int(math.ceil(x1*4))+1)]
        ok = [(x, reach(fc, x, s)) for x in xr]; ok = [(x, f) for x, f in ok if f is not None]
        if ok: rows.append((round(s,1), ok[0][0], ok[-1][0], round(min(f for _, f in ok),2), round(max(f for _, f in ok),2), round(sum(f for _, f in ok)/len(ok),2)))
        s += step
    OUT[kind] = rows
    for r in rows[::max(1, len(rows)//12)]: print('   s=%6.1f reach x %5.2f..%5.2f floor %6.2f..%6.2f mean %6.2f' % r)
    if kind in ('jump', 'jumpGapMid'):
        print('   lip profile (centre x=5):', [(round(s/10,1), fc(5, s/10)[0]) for s in range(380, 426, 4)])
    if kind in ('tunnelArc', 'tunnelArcLong', 'tunnelRoof', 'deathTunnel'):
        for x in (1.0, 1.5, 5.0, 8.5, 9.0): print('   headroom column at x=%.1f s=%.1f: %s' % (x, (s0+s1)/2, col(x, (s0+s1)/2)[:6]))
json.dump(OUT, open(SP + '/reach.json', 'w'))
