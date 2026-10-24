"""Continuous roll: lane blocks are whole blocks again, and a block inside a roll is a helicoid.
Two copies of the slope prefab are added to sharedassets0 whose surface and neon walls twist by +RATE / -RATE
degrees from start to end about the lane's centre line (the next block starts where this one ends, so a run of
them is one smooth helicoid). The spawner's lane-block spawns take their prefab from a new FSM GameObject
variable ModBlock instead of a fixed prefab; three more variables ModBlockFlat / ModBlockP / ModBlockN hold the
flat and the two twisted prefabs so the mod can read their object pointers from the heap and write the one it
wants into ModBlock before each block spawns (one block per frame while a track mode is on). The slab machinery
of the previous builds is reverted: the slope prefab is full size and every slab group is one block again.
usage: patch_roll.py <in data.unity3d (patched by patch_sections.py)> <out data.unity3d>"""
import sys, os, struct, math, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import UnityPy, fsmparse, fsmwrite
src, dst = sys.argv[1], sys.argv[2]
RATE = float(os.environ.get('RATE', '4.5'))   # degrees of roll per block (14.1421 units)
SKIP = set(os.environ.get('SKIP', '').split(','))   # debug: 'gate', 'var', 'prefabs' leave that part out
BLOCK = 14.1421; SEGS = 8; WALL = 40.0
SLOPE = 118; BASE_P, BASE_N = 2000, 2020          # new object ids in sharedassets0
SETROT = 'HutongGames.PlayMaker.Actions.SetRotation'
SLAB_LABEL = 'Mod slab step'; STEP = 10.0 / 3
def ustr(s): b = s.encode(); return struct.pack('<i', len(b)) + b + b'\0' * ((4 - len(b) % 4) % 4)
env = UnityPy.load(src)
sa = next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
# ---------------------------------------------------------------- helicoid block meshes
def rot_about_axis(v, th):
    """rotate v about the lane centre line (through (5,0,0), along (0,-1,-1)/sqrt2 in the prefab's space)"""
    a = (5.0, 0.0, 0.0); d = (0.0, -1 / math.sqrt(2), -1 / math.sqrt(2))
    p = (v[0] - a[0], v[1] - a[1], v[2] - a[2]); c, s = math.cos(th), math.sin(th)
    dot = p[0] * d[0] + p[1] * d[1] + p[2] * d[2]
    cr = (d[1] * p[2] - d[2] * p[1], d[2] * p[0] - d[0] * p[2], d[0] * p[1] - d[1] * p[0])
    r = [p[i] * c + cr[i] * s + d[i] * dot * (1 - c) for i in range(3)]
    return (r[0] + a[0], r[1] + a[1], r[2] + a[2])
def helicoid(deg):
    """the Slope mesh's shape (surface quad x 0..10 from (y,z)=(0,0) to (-10,-10); side walls hanging down;
    bottom face) swept along the block with the roll growing linearly from 0 to deg"""
    verts, uvs, tris = [], [], []
    rate = math.radians(deg) / BLOCK
    for i in range(SEGS + 1):
        t = BLOCK * i / SEGS; th = rate * t; k = t / math.sqrt(2)
        for x in (0.0, 10.0):
            verts.append(rot_about_axis((x, -k, -k), th)); uvs.append((3 - 0.3 * x, 6 - 4 * t / BLOCK))          # surface edge
            verts.append(rot_about_axis((x, -k, -k - WALL), th)); uvs.append((1.7 + 3.4 * t / BLOCK, -15.0))      # wall foot
    def ring(i): a = 4 * i; return a, a + 1, a + 2, a + 3     # LT LB RT RB
    # single-sided, wound like the Slope mesh: surface faces up, walls face outward, bottom faces down
    for i in range(SEGS):
        LT, LB, RT, RB = ring(i); LT2, LB2, RT2, RB2 = ring(i + 1)
        tris += [(RT2, LT, LT2), (LT, RT2, RT)]            # surface
        tris += [(LT2, LT, LB), (LT2, LB, LB2)]            # left wall (x = 0)
        tris += [(RT, RT2, RB2), (RT, RB2, RB)]            # right wall (x = 10)
        tris += [(LB, RB, RB2), (LB, RB2, LB2)]            # bottom
    LT, LB, RT, RB = ring(0); tris += [(LT, RT, RB), (LT, RB, LB)]          # start cap
    LT, LB, RT, RB = ring(SEGS); tris += [(LT, LB, RB), (LT, RB, RT)]       # end cap
    return verts, uvs, tris
def dup(pid, nid, patch=None):
    o = sa.objects[pid]; n = copy.copy(o); n.path_id = nid; n.data = None; sa.objects[nid] = n
    if patch: patch(n)
    return n
def make_mesh(nid, name, deg):
    verts, uvs, tris = helicoid(deg)
    vdata = b''.join(struct.pack('<5f', *verts[i], *uvs[i]) for i in range(len(verts)))
    idata = b''.join(struct.pack('<3H', *t) for t in tris)
    xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
    def patch(n):
        m = n.read(); m.m_Name = name
        m.m_VertexData.m_VertexCount = len(verts); m.m_VertexData.m_DataSize = vdata; m.m_IndexBuffer = idata
        sm = m.m_SubMeshes[0]; sm.indexCount = len(tris) * 3; sm.vertexCount = len(verts); sm.firstByte = 0; sm.firstVertex = 0
        for box in (sm.localAABB, m.m_LocalAABB):
            box.m_Center.x, box.m_Center.y, box.m_Center.z = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
            box.m_Extent.x, box.m_Extent.y, box.m_Extent.z = (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2, (max(zs) - min(zs)) / 2
        m.m_BakedConvexCollisionMesh = b''; m.m_BakedTriangleCollisionMesh = b''      # cooked at runtime (verified in WebGL)
        m.save()
    slope_mesh = next(cid for cid in comp_ids(SLOPE) if sa.objects[cid].type.name == 'MeshFilter')
    dup(sa.objects[slope_mesh].read().m_Mesh.m_PathID, nid, patch)
    return nid, len(verts), len(tris)
def comp_ids(go_id):
    go = sa.objects[go_id].read(); return [(c.component if hasattr(c, 'component') else c).m_PathID for c in go.m_Components]
def make_prefab(base, name, mesh_id):
    cids = comp_ids(SLOPE); newid = {cid: base + 1 + i for i, cid in enumerate(cids)}; GO = base
    def go_patch(n):
        g = n.read(); g.m_Name = name
        for c in g.m_Components:
            pp = c.component if hasattr(c, 'component') else c; pp.m_PathID = newid[pp.m_PathID]
        g.save()
    dup(SLOPE, GO, go_patch)
    for cid in cids:
        kind = sa.objects[cid].type.name
        if kind == 'MonoBehaviour':
            raw = bytes(sa.objects[cid].get_raw_data()); n = dup(cid, newid[cid]); n.data = raw[:4] + struct.pack('<q', GO) + raw[12:]
        elif kind == 'Transform':
            def tp(n):
                t = n.read(); t.m_GameObject.m_PathID = GO; t.m_Children = []; t.m_LocalScale.x = t.m_LocalScale.y = t.m_LocalScale.z = 1.0; t.save()
            dup(cid, newid[cid], tp)
        elif kind in ('MeshFilter', 'MeshCollider'):
            def mp(n):
                d = n.read(); d.m_GameObject.m_PathID = GO; d.m_Mesh.m_PathID = mesh_id; d.m_Mesh.m_FileID = 0; d.save()
            dup(cid, newid[cid], mp)
        else:
            def cp(n):
                d = n.read(); d.m_GameObject.m_PathID = GO; d.save()
            dup(cid, newid[cid], cp)
    return GO
if 'prefabs' in SKIP: GO_P = GO_N = SLOPE; nv = nt = 0; mp_id = mn_id = 0
else:
    mp_id, nv, nt = make_mesh(BASE_P + 9, 'SlopeTwistP', RATE); mn_id, _, _ = make_mesh(BASE_N + 9, 'SlopeTwistN', -RATE)
    GO_P = make_prefab(BASE_P, 'slopeTwistP', mp_id); GO_N = make_prefab(BASE_N, 'slopeTwistN', mn_id)
print('prefabs: slopeTwistP go#%d mesh#%d, slopeTwistN go#%d mesh#%d (%d verts, %d tris, %.1f deg per block)' % (GO_P, mp_id, GO_N, mn_id, nv, nt, RATE))
# the slope prefab itself: full size again (the slab builds scaled it to a third)
for cid in comp_ids(SLOPE):
    co = sa.objects[cid]
    if co.type.name == 'Transform':
        t = co.read(); t.m_LocalScale.x = t.m_LocalScale.y = t.m_LocalScale.z = 1.0; t.save(); print('slope prefab scale -> 1')
# ---------------------------------------------------------------- spawner FSM
def inline_float(a, k):
    pos, sz = a['ppos'][k], a['psize'][k]; d = a['bytes'][pos:pos + sz]
    return ('var', d[5:].decode()) if (sz > 4 and d[4]) else struct.unpack_from('<f', d)[0]
def pend(a, i): return a['start'][i + 1] if i + 1 < len(a['names']) else len(a['pname'])
def spawn_prefab(a, i):
    gk = next((k for k in range(a['start'][i], pend(a, i)) if a['pname'][k] == 'gameObject'), None)
    if gk is None or a['ptype'][gk] != 19: return None, None
    e = a['gameObject'][a['ppos'][gk]]; return (None if e['use'] else e['ptr']), e
def isT(a, i, y):
    if not a['names'][i].endswith('.Translate'): return False
    ys = [inline_float(a, k) for k in range(a['start'][i], pend(a, i)) if a['pname'][k] in ('y', 'z')]
    return len(ys) == 2 and all(not isinstance(v, tuple) and abs(v - y) < 1e-3 for v in ys)
def keep_actions(a, keep):
    pn, pt, pp, ps, starts = [], [], [], [], []
    for i in keep:
        starts.append(len(pn)); s0, e0 = a['start'][i], pend(a, i)
        pn += a['pname'][s0:e0]; pt += a['ptype'][s0:e0]; pp += a['ppos'][s0:e0]; ps += a['psize'][s0:e0]
    for key in ('names', 'custom', 'enabled', 'open', 'hash'): a[key] = [a[key][i] for i in keep]
    a['start'] = starts; a['pname'] = pn; a['ptype'] = pt; a['ppos'] = pp; a['psize'] = ps
def unslab(st):
    """slab groups -> one block; lane-block spawns -> prefab from the ModBlock variable"""
    a = st['actions']; n = len(a['names']); keep = []; i = 0; groups = 0; spawns = 0
    isS = lambda i: i < n and a['names'][i].endswith('.PmtSpawn') and spawn_prefab(a, i)[0] == (2, SLOPE)
    while i < n:
        if isT(a, i, -10.0) and i + 9 < n and a['names'][i + 1] == SETROT and isS(i + 2) and isT(a, i + 3, -STEP) and isS(i + 5) and isT(a, i + 6, -STEP) and isS(i + 8) and isT(a, i + 9, 2 * STEP):
            keep += [i, i + 1, i + 2]; i += 10; groups += 1; continue                                     # lane step
        if isS(i) and i + 5 < n and isT(a, i + 1, -STEP) and isS(i + 2) and isT(a, i + 3, -STEP) and isS(i + 4) and isT(a, i + 5, 2 * STEP):
            keep.append(i); i += 6; groups += 1; continue                                                    # section-opening block
        keep.append(i); i += 1
    if groups: keep_actions(a, keep)
    for i in range(len(a['names'])):
        if a['names'][i].endswith('.PmtSpawn') and a['enabled'][i]:
            ptr, e = spawn_prefab(a, i)
            if ptr == (2, SLOPE) and 'var' not in SKIP: e['use'] = True; e['name'] = 'ModBlock'; spawns += 1
    return groups, spawns
SETFLOAT = 'HutongGames.PlayMaker.Actions.SetFloatValue'; SETFLOAT_HASH = 95634840
WAIT = 'HutongGames.PlayMaker.Actions.Wait'
def add_float_variable(raw, name, value):
    f = fsmparse.parse(raw); v = f['variables']; assert v['float'] and not any(x['name'] == name for x in v['float'])
    end = v['float'][-1]['_valPos'] + 4
    entry = struct.pack('<i', 0) + ustr(name) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<f', value)
    raw = raw[:end] + entry + raw[end:]
    return raw[:v['_pos']] + struct.pack('<i', len(v['float']) + 1) + raw[v['_pos'] + 4:]
def gate_state(st):
    """[..., Wait(ModSectionDelay)] -> [..., SetFloatValue(ModSectionDelay = ModHold), Wait(ModSectionDelay)]: every step
    starts by taking its wait time from ModHold (0 while the game may burst a run in one frame, 1000 s while a track
    mode runs); the mod releases exactly one step per frame by zeroing ModSectionDelay, and the next step re-arms itself
    before any further Unity update can run. Returns 1 if the state was gated."""
    a = st['actions']; n = len(a['names'])
    wi = [i for i in range(n) if a['names'][i] == WAIT]
    if not wi: return 0
    w = wi[0]
    data = bytes(a['bytes'])
    def inline(bts):
        nonlocal data; off = len(data); data += bts; return off, len(bts)
    def fsm_float(use, name, val): return inline(struct.pack('<f', val) + bytes([1 if use else 0]) + name.encode())
    params = [('floatVariable', 15, fsm_float(True, 'ModSectionDelay', 0.0)), ('floatValue', 15, fsm_float(True, 'ModHold', 0.0)), ('everyFrame', 1, inline(b'\x00'))]
    # ModMark = 1 when this step spawns a helicoid-capable block (from the ModBlock variable), else 0: the mod advances the roll only across those
    mark = 1.0 if any(a['names'][i].endswith('.PmtSpawn') and a['enabled'][i] and spawn_prefab(a, i)[1] is not None and spawn_prefab(a, i)[1]['use'] and spawn_prefab(a, i)[1]['name'] == 'ModBlock' for i in range(n)) else 0.0
    params_mark = [('floatVariable', 15, fsm_float(True, 'ModMark', 0.0)), ('floatValue', 15, fsm_float(False, '', mark)), ('everyFrame', 1, inline(b'\x00'))]
    # insert the action before the Wait: rebuild the per-action arrays
    pn, pt, pp, ps, starts, names, custom, enabled, opened, hashes = [], [], [], [], [], [], [], [], [], []
    for i in range(n):
        if i == w:
            for plist in (params, params_mark):
                starts.append(len(pn)); names.append(SETFLOAT); custom.append(''); enabled.append(True); opened.append(False); hashes.append(SETFLOAT_HASH)
                for nm, ty, (o, sz) in plist: pn.append(nm); pt.append(ty); pp.append(o); ps.append(sz)
        starts.append(len(pn)); s0, e0 = a['start'][i], pend(a, i)
        pn += a['pname'][s0:e0]; pt += a['ptype'][s0:e0]; pp += a['ppos'][s0:e0]; ps += a['psize'][s0:e0]
        names.append(a['names'][i]); custom.append(a['custom'][i]); enabled.append(a['enabled'][i]); opened.append(a['open'][i]); hashes.append(a['hash'][i])
    a['names'] = names; a['custom'] = custom; a['enabled'] = enabled; a['open'] = opened; a['hash'] = hashes
    a['start'] = starts; a['pname'] = pn; a['ptype'] = pt; a['ppos'] = pp; a['psize'] = ps; a['bytes'] = data
    return 1
def add_go_variables(raw, entries):
    f = fsmparse.parse(raw); v = f['variables']; assert not any(x['name'] in dict(entries) for x in v['gameObject'])
    pos, end = v['_goPos'], v['_objPos']                       # append after the FSM's own GameObject variables
    blob = b''.join(struct.pack('<i', 0) + ustr(nm) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<iq', 2, pid) for nm, pid in entries)
    return raw[:pos] + struct.pack('<i', len(v['gameObject']) + len(entries)) + raw[pos + 4:end] + blob + raw[end:]
done = False
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytes(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    if gos.get((id(o.assets_file), struct.unpack_from('<q', raw, 4)[0])) != 't_Spawner': continue
    f = fsmparse.parse(raw); assert '_err' not in f
    assert any(x['name'] == 'ModSectionDelay' for x in f['variables']['float']), 'run patch_sections.py first'
    groups = spawns = gated = 0
    for st in f['states']:
        g, s_ = unslab(st); groups += g; spawns += s_; gated += 0 if 'gate' in SKIP else gate_state(st)
    w = fsmwrite.W()
    for st in f['states']: fsmwrite.write_state(w, st)
    new = raw[:f['states'][0]['_pos']] + bytes(w.b) + raw[f['_afterStates']:]
    new = add_go_variables(new, [('ModBlock', SLOPE), ('ModBlockFlat', SLOPE), ('ModBlockP', GO_P), ('ModBlockN', GO_N)])
    new = add_float_variable(new, 'ModHold', 0.0); new = add_float_variable(new, 'ModMark', 0.0)
    g2 = fsmparse.parse(new); assert '_err' not in g2, g2.get('_err'); assert [x['name'] for x in g2['variables']['gameObject']][-4:] == ['ModBlock', 'ModBlockFlat', 'ModBlockP', 'ModBlockN'], [x['name'] for x in g2['variables']['gameObject']]
    o.set_raw_data(new); done = True
    print('spawner: %d slab groups -> single blocks, %d lane spawns take the ModBlock variable, %d step states gated on ModHold; variables added' % (groups, spawns, gated))
assert done
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
