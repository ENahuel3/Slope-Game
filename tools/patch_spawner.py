"""Let the course roll: the spawn transform rests at Rx(-90) (what blocks need, since the pool copies the
transform's rotation), its Self-space translations are rotated by Rx(135) to keep the same world steps,
its child subtree is counter-rotated, and the lane blocks' flattening SetRotation is disabled.
usage: patch_spawner.py <in data.unity3d> <out data.unity3d>"""
import UnityPy, sys, struct, math
src, dst = sys.argv[1], sys.argv[2]
code = open('/tmp/claude-1000/-home-ncasares/3d35404c-c7ea-42d7-b438-6d670f0d97ae/scratchpad/tools/fsm_parse.py').read().split("env = UnityPy.load")[0]
code = code.replace("    a['names'] = r.arr(r.str); PROG['actions'] = a['names']; a['custom'] = r.arr(r.str); a['enabled'] = r.bools(); a['open'] = r.bools()",
                    "    a['names'] = r.arr(r.str); PROG['actions'] = a['names']; a['custom'] = r.arr(r.str); a['_enabledPos'] = r.p; a['enabled'] = r.bools(); a['open'] = r.bools()")
code = code.replace("    a['sparams'] = r.arr(r.str); a['bytes'] = r.bytes_();", "    a['sparams'] = r.arr(r.str); a['_bytesPos'] = r.p + 4; a['bytes'] = r.bytes_();")
code = code.replace("def fsmFloat(r): d = named(r); d['v'] = r.f32(); return d", "def fsmFloat(r): d = named(r); d['_valPos'] = r.p; d['v'] = r.f32(); return d")
sys.argv = [sys.argv[0], src]; exec(code)
env = UnityPy.load(src)
objs = {(id(o.assets_file), o.path_id): o for o in env.objects}
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
C, S_ = math.cos(math.radians(135)), math.sin(math.radians(135))
def rot_yz(y, z): return (C * y - S_ * z, S_ * y + C * z)
LANE_A = (-90.0, 270.0); SKIP = {'buildings', 'deathTower', 't_CloseCam', 't_CloseCamSmaller', 'Main Camera'}
report = []
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytearray(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    fk = id(o.assets_file); gname = gos.get((fk, struct.unpack_from('<q', raw, 4)[0]), '?')
    f = parse(bytes(raw))
    if f.get('_err'): continue
    changed = False
    if gname == 't_Spawner':
        # BlockLength variable -> -10 (the new local z step; y gets the matching -10 below)
        for v in f['vars']['float']:
            if v['name'] == 'BlockLength': struct.pack_into('<f', raw, v['_valPos'], -10.0); changed = True; report.append('BlockLength -> -10')
        n_tr = 0
        for st in f['states']:
            a = st['actions']
            for i, nm in enumerate(a['names']):
                if not nm.endswith('.Translate'): continue
                s_, e_ = a['start'][i], (a['start'][i+1] if i+1 < len(a['start']) else len(a['pname']))
                P = {a['pname'][k]: (a['ptype'][k], a['ppos'][k], a['psize'][k]) for k in range(s_, e_)}
                go = a['owner'][P['gameObject'][1]] if P.get('gameObject', (None,))[0] == 20 else None
                if not go or go['go']['v'][1] != 37: continue                           # only SpawnPos
                if struct.unpack_from('<i', a['bytes'], P['space'][1])[0] != 1: continue # Self space only
                def rd(k):
                    pt, pp, ps = P[k]; b = a['bytes'][pp:pp+ps]; use = b[4]; return ('var', b[5:].decode()) if use else ('const', struct.unpack_from('<f', b)[0])
                y, z = rd('y'), rd('z')
                yv = 0.0 if (y[0] == 'var' and y[1] == '') else (14.1421404 if y == ('var', 'BlockLength') else y[1] if y[0] == 'const' else None)
                zv = 0.0 if (z[0] == 'var' and z[1] == '') else (14.1421404 if z == ('var', 'BlockLength') else z[1] if z[0] == 'const' else None)
                if yv is None or zv is None: report.append(f"SKIP translate in {st['name']}: y={y} z={z}"); continue
                ny, nz = rot_yz(yv, zv)
                base = a['_bytesPos']
                if z == ('var', 'BlockLength'):
                    # z keeps the variable (now -10); y becomes the constant -10 (write value, clear the use flag)
                    py = P['y'][1]; struct.pack_into('<f', raw, base + py, -10.0); raw[base + py + 4] = 0
                    assert abs(ny + 10) < 0.01 and abs(nz + 10) < 0.01, (ny, nz)
                else:
                    py, pz = P['y'][1], P['z'][1]
                    struct.pack_into('<f', raw, base + py, ny); raw[base + py + 4] = 0
                    struct.pack_into('<f', raw, base + pz, nz); raw[base + pz + 4] = 0
                n_tr += 1; changed = True
        report.append(f"t_Spawner: {n_tr} translates rotated")
    elif gname not in SKIP:
        for st in f['states']:
            a = st['actions']
            for i, nm in enumerate(a['names']):
                if not nm.endswith('.SetRotation') or not a['enabled'][i]: continue
                s_, e_ = a['start'][i], (a['start'][i+1] if i+1 < len(a['start']) else len(a['pname']))
                P = {a['pname'][k]: (a['ptype'][k], a['ppos'][k], a['psize'][k]) for k in range(s_, e_)}
                pt, pp, ps = P['xAngle']; b = a['bytes'][pp:pp+ps]
                if b[4] != 0: continue
                A = struct.unpack_from('<f', b)[0]
                if A not in LANE_A: continue
                raw[a['_enabledPos'] + 4 + i] = 0; changed = True; report.append(f"{gname}: SetRotation off")
    if changed: o.set_raw_data(bytes(raw))
# scene transforms: SpawnPos rest -> Rx(-90); t_Spawner local -> Rx(135) so its subtree keeps its world pose
def setrot(name, q):
    for (fk, pid), nm in gos.items():
        if nm != name: continue
        go = objs[(fk, pid)].read()
        for c in go.m_Components:
            pp = c.component if hasattr(c, 'component') else c
            co = objs.get((fk, pp.path_id))
            if co and co.type.name == 'Transform':
                t = co.read()
                if name == 'SpawnPos' and abs(t.m_LocalRotation.x - 0.38268) > 0.01: continue   # the one at 45 degrees
                old = (t.m_LocalRotation.x, t.m_LocalRotation.w)
                t.m_LocalRotation.x, t.m_LocalRotation.y, t.m_LocalRotation.z, t.m_LocalRotation.w = q; t.save()
                report.append(f"{name} transform rot {tuple(round(v,3) for v in old)} -> {tuple(round(v,3) for v in q)}")
h = math.radians(-90) / 2; setrot('SpawnPos', (math.sin(h), 0.0, 0.0, math.cos(h)))
h = math.radians(135) / 2; setrot('t_Spawner', (math.sin(h), 0.0, 0.0, math.cos(h)))

# Trigger prefabs without a rotation action used to inherit the spawn point's +45 and now inherit -90:
# re-express their box triggers in the new local frame (bounds of the old box rotated by Rx(135)).
import itertools
def rot135(v):
    x, y, z = v; return (x, C * y - S_ * z, S_ * y + C * z)
for (fk, pid), nm in list(gos.items()):
    if nm not in ('ScorePoint', 'SpeedUp', 'SpeedUpNoSpawning'): continue
    go = objs[(fk, pid)].read()
    for c in go.m_Components:
        pp = c.component if hasattr(c, 'component') else c
        co = objs.get((fk, pp.path_id))
        if co and co.type.name == 'BoxCollider':
            b = co.read(); cx, cy, cz = b.m_Center.x, b.m_Center.y, b.m_Center.z; sx, sy, sz = b.m_Size.x, b.m_Size.y, b.m_Size.z
            pts = [rot135((cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2)) for dx, dy, dz in itertools.product((-1, 1), repeat=3)]
            lo = [min(p[i] for p in pts) for i in range(3)]; hi = [max(p[i] for p in pts) for i in range(3)]
            b.m_Center.x, b.m_Center.y, b.m_Center.z = [(lo[i] + hi[i]) / 2 for i in range(3)]
            b.m_Size.x, b.m_Size.y, b.m_Size.z = [max(1.0, hi[i] - lo[i]) for i in range(3)]
            b.save(); report.append(f"{nm} trigger box -> center {tuple(round(v,2) for v in (b.m_Center.x,b.m_Center.y,b.m_Center.z))} size {tuple(round(v,2) for v in (b.m_Size.x,b.m_Size.y,b.m_Size.z))}")

print("\n".join(report))
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print("wrote", dst, len(data))
