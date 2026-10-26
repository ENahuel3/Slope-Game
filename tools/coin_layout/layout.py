"""Coin positions derived from the piece geometry and the ball physics, each checked against the reachable set.
Ball: radius 0.5 (centre rides 0.5 above the floor), pick radius 1.25. Steering 480 N on 30 kg = 16 u/s^2 across.
The game pushes the ball with zforce (+z) and yforce = -10 zforce (-y) plus gravity 9.81; in the lane frame the
normal acceleration is a_n = R2 (9.81 + 0.3 zforce) (12..30 for zforce 24..110) and the ball speed is 8..40 u/s."""
import json, math, sys
sys.path.insert(0, sys.argv[1]); SP = sys.argv[1]
import geometry as G, floors as C
R2 = G.R2
FC = {}
for kind in C.M:
    if kind in G.mats: tris, L = C.lane_tris(kind); FC[kind] = C.make_fc(tris)[0]
def floor(kind, x, s): return C.reach(FC[kind], x, s)
def check_floor_coin(kind, x, s, n):
    f = floor(kind, x, s)
    if f is None: return 'FAIL no walkable floor under (%.1f, %.1f)' % (x, s)
    d = n - (f + 0.5)   # distance from the ball centre riding there
    return ('ok' if abs(d) <= 0.9 else 'FAIL %.2f above the ball' % d) + ' (floor %.2f)' % f
# --- lips: where the floor is highest at the end of the jump pieces, and the ramp angle just before it
def lip(kind, x=5.0):
    pts = [(s/10, FC[kind](x, s/10)[0]) for s in range(90, 146, 1)]
    pts = [(s, n) for s, n in pts if n is not None]
    s_top, n_top = max(pts, key=lambda p: p[1])
    before = [(s, n) for s, n in pts if s_top - 3.0 <= s < s_top - 0.3]
    ang = math.atan2(n_top - before[0][1], s_top - before[0][0]) if before else 0
    return s_top, n_top, ang
def air_coin(kind, d=3.0, v_min=8.0, a_max=30.0):
    s_top, n_top, th = lip(kind)
    # band of trajectories over the speed/force range at distance d past the lip: top = slow drop ~0, bottom = slow ball at max force
    drop_slow = 0.5 * a_max * (d / (v_min * math.cos(th))) ** 2
    n_line = n_top + d * math.tan(th)
    n_coin = n_line - drop_slow / 2
    margin = drop_slow / 2
    return (5.0, round(s_top + d, 1), round(n_coin, 2)), (round(s_top, 1), round(n_top, 2), round(math.degrees(th), 1), round(margin, 2))
layouts = {}; report = []
# lane blocks keep the peer's rule (one block in three gets an edge coin at x 0.9 / 9.1, s 7, n 1.0)
for x in (0.9, 9.1): report.append(('slope', x, 7, 1.0, check_floor_coin('slope', x, 7, 1.0)))
# thin lanes: the edges, pulled 0.3 in from the limit of the ball's centre (|x| <= 2.0)
layouts['thin'] = [[1.7, 15, 1.0], [-1.7, 30, 1.0], [1.7, 45, 1.0], [-1.7, 60, 1.0], [1.7, 74, 1.0]]
layouts['thinNoJump'] = layouts['thin']
# doglegs: the outer corners of the two bends and the crossing, from the reachable spans
layouts['dogleg'] = [[-4.2, 34, 1.0], [-0.4, 76, 1.0], [4.4, 118, 1.0]]
# tilted lanes: the uphill side of the regular lane width (holding higher needs more than the 16 u/s^2 of steering
# once zforce passes ~94: a_n sin 22.9 deg); n follows the tilted floor
for kind, x in (('tiltLeft', 8.9), ('tiltRight', 1.1)):
    f = floor(kind, x, 7); layouts[kind] = [[x, 7, round(f + 1.0, 2)]]
# tunnels: the ball can land on a tunnel after a gap lip (a jumpGapMid lip at 20+ u/s peaks ~4.9 high), so the coins
# sit on the walkable top: the ridge of the arch (4.92 at x 5) and the centre beam of the stepped death-tunnel roof
# (4.45 at x 4..6). Nothing inside: the arch meets the floor near x 0.5 and the death tunnel's side bays are 1.46 high,
# so interior coins (radius 0.8) end up in the walls or the roof. The start tunnel (tunnelArcLong) gets none at all,
# and lane-block edge coins under any tunnel are hidden by coins.js (they would sit in the arch wall).
def top(kind, x, s):
    f = floor(kind, x, s); return f
layouts['tunnelArc'] = [[5, s, round(top('tunnelArc', 5, s) + 1.0, 2)] for s in (20, 28, 36, 44)]
layouts['tunnelArcLong'] = []
layouts['tunnelRoof'] = [[5, s, round(top('tunnelRoof', 5, s) + 1.0, 2)] for s in (14, 22, 30)]
# jumps: one coin on the lip the ball always crosses, one in the air 3 units past it inside the band of all trajectories
for kind, d in (('jump', 2.6), ('jumpGapMid', 2.4)):   # close enough to the lip that every speed's trajectory passes within the pick radius
    (ax, as_, an), (s_top, n_top, deg, margin) = air_coin(kind, d)
    layouts[kind] = [[5.0, round(s_top - 0.2, 1), round(n_top + 1.0, 2)], [ax, as_, an]]
    report.append((kind, 'lip at s=%.1f n=%.2f ramp %.1f deg; air coin band half-width %.2f (pick radius 1.25)' % (s_top, n_top, deg, margin)))
# verify every floor coin against the geometry
for kind, cs in layouts.items():
    k = 'thin' if kind == 'thinNoJump' else kind
    for i, (x, s, n) in enumerate(cs):
        if kind in ('jump', 'jumpGapMid') and i == 1: continue
        report.append((kind, x, s, n, check_floor_coin(k, x, s, n)))
for r in report: print(r)
print('\nvar LAYOUTS = ' + json.dumps(layouts))
json.dump(layouts, open(SP + '/layouts.json', 'w'))
