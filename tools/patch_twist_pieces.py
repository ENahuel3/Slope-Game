"""The roll never pauses: twisted variants of every course piece, and a spawner that holds between moving the
spawn point and spawning so the mod can set each piece's roll knowing where it starts and how long it is.

Geometry. tools/patch_roll.py gave the lane block two helicoid copies (+/-RATE degrees over its length, about the
lane's centre line); every other piece (the tilted lanes, the thin lanes, the dogleg, the jump lips, the tunnels
and their roofs, the speed-arrow block) stayed rigid, so a roll stopped across them and resumed after. This adds
<piece>P / <piece>N copies of all of them with tools/twist_mesh.py (the same rule: the cross-section at course
coordinate t rotates by RATE * t / BLOCK about the centre line, so pieces that met untwisted still meet twisted),
re-points the slopeTwistP/N prefabs' meshes at the generic twist of the real Slope mesh, and gives the spawner
one GameObject variable per piece (ModTw<Piece>, with ModTw<Piece>Flat / P / N holding the three prefabs) that
every spawn of that piece reads, like ModBlock for the lane block.

Spawner. A gated step used to be [Translate SpawnPos, spawns..., SetFloat(ModSectionDelay = ModHold),
SetFloat(ModMark), Wait]: the mod only saw the spawn point move after the piece had spawned, so it could set the
roll one piece ahead at best and knew nothing about the piece's length. Now every such state is split:
[Translate..., SetFloat(delay), SetFloat(ModMark = L), SetFloat(ModSpan = S), Wait] -> FINISHED ->
"<state> ~spawn": [spawns...]. The hold comes between the move and the spawn: the mod reads the new spawn
position, ModMark (the length along the course of the floor piece about to spawn there, 0 if none) and ModSpan
(the furthest any twist-capable piece spawned there reaches, e.g. a tunnel arch over the next blocks), writes
the roll and the prefab variants, and releases; the spawn and the next state's move then happen in one Unity
frame, so a lap still builds one piece per frame. Lengths come from the meshes (-sqrt2 * min y) and cover the
spawn chain up to the next move (states that spawn without moving the spawn point are part of the chain).
usage: patch_twist_pieces.py <in data.unity3d> <out data.unity3d>"""
import sys, os, struct, math, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import UnityPy, fsmparse, fsmwrite, twist_mesh
src, dst = sys.argv[1], sys.argv[2]
SPAWNPOS = (0, 37); SLOPE = 118; SLOPE_P, SLOPE_N = 2000, 2020
TRANSLATE = 'HutongGames.PlayMaker.Actions.Translate'; SETROT = 'HutongGames.PlayMaker.Actions.SetRotation'
SETFLOAT = 'HutongGames.PlayMaker.Actions.SetFloatValue'; WAIT = 'HutongGames.PlayMaker.Actions.Wait'
# (prefab go id, variable stem, floor piece?): floor pieces carry the ball and set where the next piece starts
PIECES = [(119, 'Arrows', True), (120, 'TiltL', True), (121, 'TiltR', True), (124, 'Thin', True), (125, 'ThinNJ', True), (106, 'Dogleg', True),
          (108, 'Jump', True), (109, 'JumpGap', True), (107, 'DropTunnel', False), (126, 'Tunnel', False), (127, 'Arc', False),
          (128, 'ArcDanger', False), (129, 'ArcLong', False), (130, 'ArcLongDanger', False), (131, 'Roof', False)]
GO_BASE, MESH_BASE = 3000, 4000
def ustr(s): b = s.encode(); return struct.pack('<i', len(b)) + b + b'\0' * ((4 - len(b) % 4) % 4)
env = UnityPy.load(src)
sa = next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
assert max(sa.objects) < GO_BASE, max(sa.objects)
def pptr_id(p): return p.m_PathID if hasattr(p, 'm_PathID') else p.path_id
def comp_ids(go_id):
    go = sa.objects[go_id].read(); return [pptr_id(c.component if hasattr(c, 'component') else c) for c in go.m_Components]
def dup(pid, nid, patch=None):
    o = sa.objects[pid]; n = copy.copy(o); n.path_id = nid; n.data = None; sa.objects[nid] = n
    if patch: patch(n)
    return n
# ---------------------------------------------------------------- meshes
mesh_len = {}; twisted = {}; mesh_count = [0]
def piece_length(mid):
    if mid not in mesh_len:
        m = sa.objects[mid].read(); vd = m.m_VertexData; st = len(vd.m_DataSize) // vd.m_VertexCount
        mesh_len[mid] = -math.sqrt(2) * min(struct.unpack_from('<3f', vd.m_DataSize, i * st)[1] for i in range(vd.m_VertexCount))
    return mesh_len[mid]
def twisted_mesh(mid, direction):
    """the +/-RATE twist of mesh mid (shared between prefabs that share the mesh)"""
    key = (mid, direction)
    if key in twisted: return twisted[key]
    m0 = sa.objects[mid].read(); vd0 = m0.m_VertexData
    assert len(m0.m_SubMeshes) == 1 and m0.m_SubMeshes[0].firstByte == 0 and len(vd0.m_DataSize) // vd0.m_VertexCount == 20 and getattr(m0, 'm_IndexFormat', 0) == 0, m0.m_Name
    vdata, idata, nv, nt, (lo, hi) = twist_mesh.twist(bytes(vd0.m_DataSize), bytes(m0.m_IndexBuffer), vd0.m_VertexCount, direction)
    nid = MESH_BASE + mesh_count[0]; mesh_count[0] += 1
    def patch(n):
        m = n.read(); m.m_Name = m0.m_Name + ('P' if direction > 0 else 'N')
        m.m_VertexData.m_VertexCount = nv; m.m_VertexData.m_DataSize = vdata; m.m_IndexBuffer = idata
        sm = m.m_SubMeshes[0]; sm.indexCount = nt * 3; sm.vertexCount = nv; sm.firstByte = 0; sm.firstVertex = 0
        for box in (sm.localAABB, m.m_LocalAABB):
            box.m_Center.x, box.m_Center.y, box.m_Center.z = [(lo[i] + hi[i]) / 2 for i in range(3)]
            box.m_Extent.x, box.m_Extent.y, box.m_Extent.z = [(hi[i] - lo[i]) / 2 for i in range(3)]
        m.m_BakedConvexCollisionMesh = b''; m.m_BakedTriangleCollisionMesh = b''      # cooked at runtime
        m.save()
    dup(mid, nid, patch); twisted[key] = (nid, nv, nt)
    return twisted[key]
def mesh_refs(go_id):
    """{component id: mesh id} for the MeshFilter and MeshCollider of a prefab"""
    out = {}
    for cid in comp_ids(go_id):
        co = sa.objects[cid]
        if co.type.name in ('MeshFilter', 'MeshCollider'): out[cid] = pptr_id(co.read().m_Mesh)
    return out
def make_variant(go_id, base, direction):
    """a copy of prefab go_id whose meshes are the twisted ones (children dropped, like the slope helicoids)"""
    cids = comp_ids(go_id); newid = {cid: base + 1 + i for i, cid in enumerate(cids)}; GO = base; refs = mesh_refs(go_id)
    name = gos[(id(sa), go_id)] + ('P' if direction > 0 else 'N')
    def go_patch(n):
        g = n.read(); g.m_Name = name
        for c in g.m_Components:
            pp = c.component if hasattr(c, 'component') else c; pp.m_PathID = newid[pp.m_PathID]
        g.save()
    dup(go_id, GO, go_patch)
    for cid in cids:
        kind = sa.objects[cid].type.name
        if kind == 'MonoBehaviour':
            raw = bytes(sa.objects[cid].get_raw_data()); n = dup(cid, newid[cid]); n.data = raw[:4] + struct.pack('<q', GO) + raw[12:]
        elif kind == 'Transform':
            def tp(n):
                t = n.read(); t.m_GameObject.m_PathID = GO; t.m_Children = []; t.save()
            dup(cid, newid[cid], tp)
        elif kind in ('MeshFilter', 'MeshCollider'):
            mid = twisted_mesh(refs[cid], direction)[0]
            def mp(n, mid=mid):
                d = n.read(); d.m_GameObject.m_PathID = GO; d.m_Mesh.m_PathID = mid; d.m_Mesh.m_FileID = 0; d.save()
            dup(cid, newid[cid], mp)
        else:
            def cp(n):
                d = n.read(); d.m_GameObject.m_PathID = GO; d.save()
            dup(cid, newid[cid], cp)
    return GO
variants = {}            # prefab id -> (flat, P, N)
lengths = {}             # prefab id -> length along the course
for i, (pid, stem, floor) in enumerate(PIECES):
    assert gos[(id(sa), pid)], pid
    refs = mesh_refs(pid); render_mesh = next(mid for cid, mid in refs.items() if sa.objects[cid].type.name == 'MeshFilter')
    lengths[pid] = piece_length(render_mesh)
    variants[pid] = (pid, make_variant(pid, GO_BASE + 40 * i, +1), make_variant(pid, GO_BASE + 40 * i + 20, -1))
lengths[SLOPE] = piece_length(mesh_refs(SLOPE)[next(c for c in comp_ids(SLOPE) if sa.objects[c].type.name == 'MeshFilter')])
# the slope helicoids: the same generic twist of the real Slope mesh, so the lane block and the other pieces share one rule
slope_mesh = mesh_refs(SLOPE)[next(c for c in comp_ids(SLOPE) if sa.objects[c].type.name == 'MeshFilter')]
for go_id, direction in ((SLOPE_P, +1), (SLOPE_N, -1)):
    mid = twisted_mesh(slope_mesh, direction)[0]
    for cid in comp_ids(go_id):
        co = sa.objects[cid]
        if co.type.name in ('MeshFilter', 'MeshCollider'):
            d = co.read(); d.m_Mesh.m_PathID = mid; d.m_Mesh.m_FileID = 0; d.save()
variants[SLOPE] = (SLOPE, SLOPE_P, SLOPE_N)
print('pieces: %d prefabs x 2 twisted copies, %d twisted meshes; lengths: %s' % (len(PIECES), mesh_count[0], ', '.join('%s %.1f' % (gos[(id(sa), p)], lengths[p]) for p in lengths)))
# ---------------------------------------------------------------- the spawner FSM
def pend(a, i): return a['start'][i + 1] if i + 1 < len(a['names']) else len(a['pname'])
def params(a, i): return {a['pname'][k]: k for k in range(a['start'][i], pend(a, i))}
def spawn_entry(a, i):
    k = params(a, i).get('gameObject')
    return a['gameObject'][a['ppos'][k]] if k is not None and a['ptype'][k] == 19 else None
def is_spawnpos_translate(a, i):
    if a['names'][i] != TRANSLATE or not a['enabled'][i]: return False
    od = a['ownerDefault'][a['ppos'][params(a, i)['gameObject']]]
    return od['opt'] == 1 and not od['go']['use'] and od['go']['ptr'] == SPAWNPOS
def keep_actions(a, keep):
    pn, pt, pp, ps, starts = [], [], [], [], []
    for i in keep:
        starts.append(len(pn)); s0, e0 = a['start'][i], pend(a, i)
        pn += a['pname'][s0:e0]; pt += a['ptype'][s0:e0]; pp += a['ppos'][s0:e0]; ps += a['psize'][s0:e0]
    for key in ('names', 'custom', 'enabled', 'open', 'hash'): a[key] = [a[key][i] for i in keep]
    a['start'] = starts; a['pname'] = pn; a['ptype'] = pt; a['ppos'] = pp; a['psize'] = ps
def add_go_variables(raw, entries):
    f = fsmparse.parse(raw); v = f['variables']; assert not any(x['name'] in dict(entries) for x in v['gameObject'])
    pos, end = v['_goPos'], v['_objPos']
    blob = b''.join(struct.pack('<i', 0) + ustr(nm) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<iq', 2, pid) for nm, pid in entries)
    return raw[:pos] + struct.pack('<i', len(v['gameObject']) + len(entries)) + raw[pos + 4:end] + blob + raw[end:]
def add_float_variable(raw, name, value):
    f = fsmparse.parse(raw); v = f['variables']; assert v['float'] and not any(x['name'] == name for x in v['float'])
    end = v['float'][-1]['_valPos'] + 4
    entry = struct.pack('<i', 0) + ustr(name) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<f', value)
    raw = raw[:end] + entry + raw[end:]
    return raw[:v['_pos']] + struct.pack('<i', len(v['float']) + 1) + raw[v['_pos'] + 4:]
var_of = {pid: 'ModTw' + stem for pid, stem, _ in PIECES}; var_of[SLOPE] = 'ModBlock'
floor_of = {pid: floor for pid, _, floor in PIECES}; floor_of[SLOPE] = True
def spawned_pieces(st):
    """twist-capable prefabs spawned by a state's enabled PmtSpawn actions (by their variable, after rewiring)"""
    a = st['actions']; out = []
    for i, nm in enumerate(a['names']):
        if not nm.endswith('.PmtSpawn') or not a['enabled'][i]: continue
        e = spawn_entry(a, i)
        if e is None: continue
        if e['use']: pid = next((p for p, vn in var_of.items() if vn == e['name']), None)
        else: pid = e['ptr'][1] if e['ptr'][0] == 2 else None
        if pid in var_of: out.append(pid)
    return out
def rewire_spawns(f):
    n = 0
    for st in f['states']:
        a = st['actions']
        for i, nm in enumerate(a['names']):
            if not nm.endswith('.PmtSpawn'): continue
            e = spawn_entry(a, i)
            if e is not None and not e['use'] and e['ptr'][0] == 2 and e['ptr'][1] in var_of and e['ptr'][1] != SLOPE:
                e['use'] = True; e['name'] = var_of[e['ptr'][1]]; n += 1
    return n
def gate_indices(a):
    """(index of the SetFloat(ModSectionDelay) that opens the gate, index of the Wait) or None"""
    for i, nm in enumerate(a['names']):
        if nm == SETFLOAT:
            k = params(a, i)['floatVariable']; d = a['bytes'][a['ppos'][k]:a['ppos'][k] + a['psize'][k]]
            if len(d) > 5 and d[4] and d[5:] == b'ModSectionDelay':
                w = next((j for j in range(i, len(a['names'])) if a['names'][j] == WAIT), None)
                return (i, w) if w is not None else None
    return None
def set_mark(a, i, value):
    k = params(a, i)['floatValue']; pos = a['ppos'][k]; assert a['psize'][k] >= 4 and not a['bytes'][pos + 4]
    a['bytes'][pos:pos + 4] = struct.pack('<f', value)
def mark_index(a, name):
    for i, nm in enumerate(a['names']):
        if nm == SETFLOAT:
            k = params(a, i)['floatVariable']; d = a['bytes'][a['ppos'][k]:a['ppos'][k] + a['psize'][k]]
            if len(d) > 5 and d[4] and d[5:] == name.encode(): return i
    return None
def add_span_action(a, after, value):
    """a SetFloatValue(ModSpan = value) cloned from the ModMark one, inserted after action index `after`"""
    src = mark_index(a, 'ModMark'); assert src is not None
    pn, pt, pp, ps = [], [], [], []
    for k in range(a['start'][src], pend(a, src)):
        nm, ty, pos, sz = a['pname'][k], a['ptype'][k], a['ppos'][k], a['psize'][k]
        if nm == 'floatVariable': d = struct.pack('<f', 0.0) + b'\x01' + b'ModSpan'
        elif nm == 'floatValue': d = struct.pack('<f', value) + b'\x00'
        else: d = bytes(a['bytes'][pos:pos + sz])
        pos = len(a['bytes']); a['bytes'] += d; pn.append(nm); pt.append(ty); pp.append(pos); ps.append(len(d))
    rec = (a['names'][src], 'Mod span', a['hash'][src], pn, pt, pp, ps)
    names, custom, enabled, opened, hashes, starts, PN, PT, PP, PS = [], [], [], [], [], [], [], [], [], []
    for i in range(len(a['names'])):
        starts.append(len(PN)); s0, e0 = a['start'][i], pend(a, i)
        PN += a['pname'][s0:e0]; PT += a['ptype'][s0:e0]; PP += a['ppos'][s0:e0]; PS += a['psize'][s0:e0]
        names.append(a['names'][i]); custom.append(a['custom'][i]); enabled.append(a['enabled'][i]); opened.append(a['open'][i]); hashes.append(a['hash'][i])
        if i == after:
            starts.append(len(PN)); PN += rec[3]; PT += rec[4]; PP += rec[5]; PS += rec[6]
            names.append(rec[0]); custom.append(rec[1]); enabled.append(True); opened.append(False); hashes.append(rec[2])
    a['names'] = names; a['custom'] = custom; a['enabled'] = enabled; a['open'] = opened; a['hash'] = hashes
    a['start'] = starts; a['pname'] = PN; a['ptype'] = PT; a['ppos'] = PP; a['psize'] = PS
def finished_target(st):
    tr = st['transitions']
    return tr[0]['to'] if len(tr) == 1 and tr[0]['event']['name'] == 'FINISHED' else None
def chain_lengths(first, by_name):
    """(floor length, span) of the pieces spawned from state `first` up to the next move of the spawn point"""
    floor, span, seen, st = 0.0, 0.0, set(), first
    while st is not None and st['name'] not in seen:
        seen.add(st['name'])
        for pid in spawned_pieces(st):
            L = lengths[pid]; span = max(span, L)
            if floor_of[pid]: floor = L if floor == 0 else min(floor, L)
        nxt = by_name.get(finished_target(st))
        if nxt is None or any(is_spawnpos_translate(nxt['actions'], i) for i in range(len(nxt['actions']['names']))): break
        st = nxt
    return (floor or span), span
def split_states(f):
    """Every gated state is cut into segments at its moves of the spawn point; each segment with spawns becomes a
    hold state (the segment's leading actions, i.e. its move, then the gate) and a spawn state (the rest), so the
    hold always sits between a move and the spawns that follow it. A segment that only moves keeps the gate alone."""
    states = f['states']; out = []; split = 0; holds = 0
    FIN = lambda to: [{'event': {'name': 'FINISHED', 'sys': True, 'glob': False}, 'to': to, 'linkStyle': 0, 'linkConstraint': 0, 'color': False}]
    for st in states:
        a = st['actions']; a['bytes'] = bytearray(a['bytes']); n = len(a['names'])
        g = gate_indices(a)
        if g is None: out.append(st); continue
        gate, wait = g
        body = list(range(0, gate)); gate_ix = list(range(gate, n))
        moves = [i for i in body if is_spawnpos_translate(a, i)]
        is_spawn = lambda i: (a['names'][i].endswith('.PmtSpawn') and a['enabled'][i]) or a['names'][i] == SETROT
        if not moves and not any(is_spawn(i) for i in body): out.append(st); continue
        assert wait == n - 1, ('actions after the gate', st['name'])
        # segments: [body before the first move], then one per move
        cuts = [0] + moves + [gate]
        segs = [body[cuts[k]:cuts[k + 1]] for k in range(len(cuts) - 1)]
        if not segs[0]: segs = segs[1:]
        elif not any(is_spawn(i) for i in segs[0]) and len(segs) > 1: segs = [segs[0] + segs[1]] + segs[2:]   # leading bookkeeping (IntAdd, RandomFloat) rides with the first move
        pieces = []
        for k, seg in enumerate(segs):
            first = next((j for j, i in enumerate(seg) if is_spawn(i)), None)
            lead, rest = (seg, []) if first is None else (seg[:first], seg[first:])
            assert not any(is_spawnpos_translate(a, i) for i in rest), ('a move after a spawn in one segment', st['name'])
            pieces.append((lead, rest))
        target = st['transitions']; names = []
        for k, (lead, rest) in enumerate(pieces):
            hold = copy.deepcopy(st) if k == 0 else copy.deepcopy(st)
            keep_actions(hold['actions'], lead + gate_ix)
            hold['name'] = st['name'] if k == 0 else '%s ~move %d' % (st['name'], k)
            hold['rect'] = [st['rect'][0], st['rect'][1] + 30 * k, st['rect'][2], st['rect'][3]]
            chain = [hold]
            if rest:
                sp = copy.deepcopy(st); keep_actions(sp['actions'], rest); sp['name'] = '%s ~spawn' % st['name'] + ('' if k == 0 else ' %d' % k)
                sp['rect'] = [st['rect'][0] + 40, st['rect'][1] + 30 * k + 15, st['rect'][2], st['rect'][3]]
                hold['transitions'] = FIN(sp['name']); chain.append(sp)
            names.append(chain)
        for k in range(len(names)):
            last = names[k][-1]
            last['transitions'] = FIN(names[k + 1][0]['name']) if k + 1 < len(names) else target
        for chain in names: out += chain
        split += 1; holds += len(names)
    # the marks: every hold publishes the lengths of the chain that spawns before the next move of the spawn point
    by_name = {st['name']: st for st in out}
    for st in out:
        a = st['actions']; g = gate_indices(a)
        if g is None: continue
        mi = mark_index(a, 'ModMark'); assert mi is not None, st['name']
        start = by_name.get(finished_target(st))
        floor, span = chain_lengths(start, by_name) if start is not None else (0.0, 0.0)
        set_mark(a, mi, floor); add_span_action(a, mi, span)
    return out, split, holds
def rebuild(raw, f, states):
    w = fsmwrite.W()
    for st in states: fsmwrite.write_state(w, st)
    count_pos = f['states'][0]['_pos'] - 4
    new = raw[:count_pos] + struct.pack('<i', len(states)) + bytes(w.b) + raw[f['_afterStates']:]
    g = fsmparse.parse(new); assert '_err' not in g, g.get('_err'); assert len(g['states']) == len(states)
    return new
done = False
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytes(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    if gos.get((id(o.assets_file), struct.unpack_from('<q', raw, 4)[0])) != 't_Spawner': continue
    f = fsmparse.parse(raw); assert '_err' not in f
    assert any(x['name'] == 'ModMark' for x in f['variables']['float']) and not any(x['name'] == 'ModSpan' for x in f['variables']['float']), 'needs patch_roll.py, and not twice'
    rewired = rewire_spawns(f)
    states, split, holds = split_states(f)
    new = rebuild(raw, f, states)
    entries = []
    for pid, stem, _ in PIECES:
        flat, p, n_ = variants[pid]; vn = var_of[pid]; entries += [(vn, flat), (vn + 'Flat', flat), (vn + 'P', p), (vn + 'N', n_)]
    new = add_go_variables(new, entries); new = add_float_variable(new, 'ModSpan', 0.0)
    g2 = fsmparse.parse(new); assert '_err' not in g2, g2.get('_err')
    o.set_raw_data(new); done = True
    print('spawner: %d spawns read their piece variable, %d gated states cut into %d hold/spawn pairs (holds publish ModMark/ModSpan), %d GameObject variables + ModSpan added' % (rewired, split, holds, len(entries)))
assert done
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
