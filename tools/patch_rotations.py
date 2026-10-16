"""Make block prefabs inherit the spawn point's roll.
Every lane block runs a SetRotation(xAngle=A, y/z=None, world) on spawn, which flattens any roll of the
spawn transform. Patch: bake Rx(A-45) into the prefab root rotation (the spawn transform is pitched 45)
and disable that action. Prefabs spawned from an unpitched transform (buildings) get Rx(A) instead.
usage: patch_rotations.py <in data.unity3d> <out data.unity3d> [--dry]"""
import UnityPy, sys, struct, math
sys.argv_save = sys.argv[:]
src, dst = sys.argv[1], sys.argv[2]; dry = '--dry' in sys.argv
code = open('/tmp/claude-1000/-home-ncasares/3d35404c-c7ea-42d7-b438-6d670f0d97ae/scratchpad/tools/fsm_parse.py').read().split("env = UnityPy.load")[0]
# record the byte offset of each state's actionEnabled array
code = code.replace("    a['names'] = r.arr(r.str); PROG['actions'] = a['names']; a['custom'] = r.arr(r.str); a['enabled'] = r.bools(); a['open'] = r.bools()",
                    "    a['names'] = r.arr(r.str); PROG['actions'] = a['names']; a['custom'] = r.arr(r.str); a['_enabledPos'] = r.p; a['enabled'] = r.bools(); a['open'] = r.bools()")
sys.argv = [sys.argv[0], src]
exec(code)
env = UnityPy.load(src)
objs = {(id(o.assets_file), o.path_id): o for o in env.objects}          # path ids repeat across the bundle's files
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
UNPITCHED = {'buildings'}          # spawned from an identity transform
SKIP = {'deathTower'}              # spawned both ways; leave as is
def qx(deg):
    h = math.radians(deg) / 2; return (math.sin(h), 0.0, 0.0, math.cos(h))
patched = []
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytearray(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    goid = struct.unpack_from('<q', raw, 4)[0]; fk = id(o.assets_file); gname = gos.get((fk, goid), '?')
    f = parse(bytes(raw))
    if f.get('_err'): continue
    hits = []
    for st in f['states']:
        a = st['actions']
        for i, nm in enumerate(a['names']):
            if not nm.endswith('.SetRotation') or not a['enabled'][i]: continue
            s_, e_ = a['start'][i], (a['start'][i+1] if i+1 < len(a['start']) else len(a['pname']))
            params = {a['pname'][k]: (a['ptype'][k], a['ppos'][k], a['psize'][k]) for k in range(s_, e_)}
            def inline(k):
                if k not in params: return None
                pt, pp, ps = params[k]; b = a['bytes'][pp:pp+ps]
                if pt != 15: return ('t%d' % pt)
                use = b[4] if len(b) > 4 else 0
                return ('var', b[5:].decode('utf-8', 'replace')) if use else ('const', struct.unpack_from('<f', b)[0])
            x, y, z = inline('xAngle'), inline('yAngle'), inline('zAngle')
            sp = params.get('space'); space = struct.unpack_from('<i', a['bytes'], sp[1])[0] if sp else -1
            ev = params.get('everyFrame'); every = a['bytes'][ev[1]] if ev else 0
            hits.append((st['name'], i, x, y, z, space, every, a['_enabledPos'] + 4 + i))
    if not hits: continue
    ok = [h for h in hits if h[2] and h[2][0] == 'const' and h[3] == ('var', '') and h[4] == ('var', '') and h[5] == 0 and not h[6]]
    print(f"{gname:>22}: {[(h[0], h[2], h[5], 'every' if h[6] else '') for h in hits]}  patchable={len(ok)==len(hits)}")
    if gname in SKIP or len(ok) != len(hits) or dry: continue
    A = ok[0][2][1]
    for h in ok: raw[h[7]] = 0                                  # disable the action
    o.set_raw_data(bytes(raw))
    # prefab root rotation
    go = objs[(fk, goid)].read()
    for c in go.m_Components:
        pp = c.component if hasattr(c, 'component') else c
        co = objs.get((fk, pp.path_id))
        if co and co.type.name == 'Transform':
            t = co.read(); q = qx(A if gname in UNPITCHED else A - 45)
            old = (t.m_LocalRotation.x, t.m_LocalRotation.y, t.m_LocalRotation.z, t.m_LocalRotation.w)
            t.m_LocalRotation.x, t.m_LocalRotation.y, t.m_LocalRotation.z, t.m_LocalRotation.w = q
            t.save()
            patched.append((gname, A, old, q))
print("patched:", [(p[0], p[1], tuple(round(v, 3) for v in p[2])) for p in patched])
if not dry:
    data = env.file.save(packer="original"); open(dst, 'wb').write(data); print("wrote", dst, len(data))
