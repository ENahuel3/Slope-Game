"""Obstacles follow the roll of the course.
The moving red blocks (obsticleMover, obsticleMoveUpDown1-3) are driven by an iTweenMoveBy in their own FSM
that tweens in WORLD space (the mover +10 along world x, the up/down blocks +20 along world y), so on a rolled
lane (tools/patch_roll.py) they slide along axes that are no longer the lane's. The spawner also places things
in world space: the death towers are moved +-20 x / +10 y after spawning, the easy obstacle is offset along
world x, and the mover / the second and third up/down blocks are spawned at a world-space offset of the spawn
point (PmtSpawn's OrSpawnPosition). Every spawned piece copies the spawn point's rotation, whose local axes are
the lane's: x across the lane, z up from it, y backwards along it (the rest rotation is -90 degrees about x).
So: the tweens and translates move to Self space with their vectors re-expressed in that frame (world (x, y, z)
-> local (x, -z, y)), the OrSpawnPosition offsets become a Self-space Translate of the spawned object right after
its spawn (stored in the spawner's unused `obsticle` variable), and the death tower's own SetRotation(270, world),
which flattened its roll, is disabled: 270 about x is the spawn point's rest rotation anyway.
usage: patch_obstacles.py <in data.unity3d> <out data.unity3d>"""
import sys, os, struct, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import UnityPy, fsmparse, fsmwrite
src, dst = sys.argv[1], sys.argv[2]
env = UnityPy.load(src)
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
TRANSLATE = 'HutongGames.PlayMaker.Actions.Translate'; MOVEBY = 'HutongGames.PlayMaker.Actions.iTweenMoveBy'
SETROT = 'HutongGames.PlayMaker.Actions.SetRotation'; PMT = 'PmtSpawn'
OFFSET_VAR = 'obsticle'            # an FsmGameObject variable of the spawner that nothing reads after its own Translate
def pend(a, i): return a['start'][i + 1] if i + 1 < len(a['names']) else len(a['pname'])
def params(a, i): return {a['pname'][k]: k for k in range(a['start'][i], pend(a, i))}
def fconst(a, k):
    """an inline FsmFloat param: (value, is_constant)"""
    pos, sz = a['ppos'][k], a['psize'][k]; d = a['bytes'][pos:pos + sz]
    return struct.unpack_from('<f', d)[0], not (sz > 4 and d[4])
def set_fconst(a, k, v):
    pos = a['ppos'][k]; assert a['psize'][k] >= 4 and not a['bytes'][pos + 4]; a['bytes'][pos:pos + 4] = struct.pack('<f', v)
def enum(a, k): return struct.unpack_from('<i', a['bytes'], a['ppos'][k])[0]
def set_enum(a, k, v): a['bytes'][a['ppos'][k]:a['ppos'][k] + 4] = struct.pack('<i', v)
def v3const(a, k):
    pos, sz = a['ppos'][k], a['psize'][k]; d = a['bytes'][pos:pos + sz]
    return (None if (sz > 12 and d[12]) else struct.unpack_from('<3f', d))
def set_v3(a, k, v):
    """a constant vector, or None for 'no value' (use-variable flag with no name)"""
    pos = a['ppos'][k]; assert a['psize'][k] == 13
    a['bytes'][pos:pos + 13] = (struct.pack('<3f', *v) + b'\x00') if v else (b'\x00' * 12 + b'\x01')
def to_local(x, y, z): return x, -z, y        # world (x, y, z) -> the spawn frame's (x, -z, y)
def localize_translate(a, i, what):
    """a world-space Translate of a spawned object -> Self space, the constant components re-expressed"""
    p = params(a, i)
    if enum(a, p['space']) != 0: return 0
    x, xc = fconst(a, p['x']); y, yc = fconst(a, p['y']); z, zc = fconst(a, p['z'])
    assert xc or (y == 0 and z == 0) or not (yc and zc), what         # a variable x with constant y/z is fine; other mixes are not handled
    if yc and zc: ny, nz = -z, y; set_fconst(a, p['y'], ny); set_fconst(a, p['z'], nz)
    set_enum(a, p['space'], 1)
    return 1
def clone_translate(a, i_src, go_name, vec):
    """a new Translate action record (names/params) built from an existing one: Self space, constant x/y/z, on the
    FsmGameObject variable go_name; returns the pieces to splice in (name, custom, hash, pname, ptype, ppos, psize)"""
    p = params(a, i_src); pn, pt, pp, ps = [], [], [], []
    for k in range(a['start'][i_src], pend(a, i_src)):
        nm, ty, pos, sz = a['pname'][k], a['ptype'][k], a['ppos'][k], a['psize'][k]
        if ty == 20:                                                                   # FsmOwnerDefault -> a new entry naming the variable
            od = copy.deepcopy(a['ownerDefault'][pos]); od['opt'] = 1; od['go']['use'] = True; od['go']['name'] = go_name; od['go']['ptr'] = (0, 0)
            a['ownerDefault'].append(od); pos = len(a['ownerDefault']) - 1
        else:                                                                           # inline bytes: copied, then overridden
            d = bytearray(a['bytes'][pos:pos + sz])
            if nm in ('x', 'y', 'z'): d = bytearray(struct.pack('<f', vec['xyz'.index(nm)]) + b'\x00')
            elif nm == 'vector': d = bytearray(b'\x00' * 12 + b'\x01')
            elif nm == 'space': d = bytearray(struct.pack('<i', 1))
            elif ty == 1: d = bytearray(b'\x00')
            pos = len(a['bytes']); a['bytes'] += d; sz = len(d)
        pn.append(nm); pt.append(ty); pp.append(pos); ps.append(sz)
    return (a['names'][i_src], 'Mod: offset in the lane frame', a['hash'][i_src], pn, pt, pp, ps)
def splice_actions(a, inserts):
    """inserts: {after_index: record}; rebuilds the per-action arrays with each record placed after that action"""
    names, custom, enabled, opened, hashes, starts, pn, pt, pp, ps = [], [], [], [], [], [], [], [], [], []
    for i in range(len(a['names'])):
        starts.append(len(pn)); s0, e0 = a['start'][i], pend(a, i)
        pn += a['pname'][s0:e0]; pt += a['ptype'][s0:e0]; pp += a['ppos'][s0:e0]; ps += a['psize'][s0:e0]
        names.append(a['names'][i]); custom.append(a['custom'][i]); enabled.append(a['enabled'][i]); opened.append(a['open'][i]); hashes.append(a['hash'][i])
        if i in inserts:
            nm, cu, h, n2, t2, p2, s2 = inserts[i]
            starts.append(len(pn)); pn += n2; pt += t2; pp += p2; ps += s2
            names.append(nm); custom.append(cu); enabled.append(True); opened.append(False); hashes.append(h)
    a['names'] = names; a['custom'] = custom; a['enabled'] = enabled; a['open'] = opened; a['hash'] = hashes
    a['start'] = starts; a['pname'] = pn; a['ptype'] = pt; a['ppos'] = pp; a['psize'] = ps
def spawner(f):
    assert any(v['name'] == OFFSET_VAR for v in f['variables']['gameObject']), OFFSET_VAR + ' variable missing'
    n_tr = n_off = 0
    for st in f['states']:
        a = st['actions']; a['bytes'] = bytearray(a['bytes']); inserts = {}
        tr_src = next((i for i, nm in enumerate(a['names']) if nm == TRANSLATE), None)
        for i, nm in enumerate(a['names']):
            if not a['enabled'][i]: continue
            if nm == TRANSLATE:
                p = params(a, i); od = a['ownerDefault'][a['ppos'][p['gameObject']]]
                if od['opt'] == 1 and od['go']['use'] and od['go']['name']:                 # a spawned object held in a variable (Tower, obsticle)
                    n_tr += localize_translate(a, i, st['name'] + ': ' + a['custom'][i])
            elif nm.endswith('.' + PMT):
                p = params(a, i); v = v3const(a, p['OrSpawnPosition'])
                if v and any(abs(c) > 1e-6 for c in v):
                    assert tr_src is not None, st['name']
                    set_v3(a, p['OrSpawnPosition'], None)
                    e = a['gameObject'][a['ppos'][p['spawnedGameObject']]]; e['use'] = True; e['name'] = OFFSET_VAR
                    inserts[i] = clone_translate(a, tr_src, OFFSET_VAR, to_local(*v)); n_off += 1
        if inserts: splice_actions(a, inserts)
    return n_tr, n_off
def prefab_fsm(f, name):
    hits = 0
    for st in f['states']:
        a = st['actions']; a['bytes'] = bytearray(a['bytes'])
        for i, nm in enumerate(a['names']):
            if nm == MOVEBY and name.startswith('obsticle'):
                p = params(a, i); v = v3const(a, p['vector']); assert v and enum(a, p['space']) == 0, (name, v)
                set_v3(a, p['vector'], to_local(*v)); set_enum(a, p['space'], 1); hits += 1
            elif nm == SETROT and name == 'deathTower' and a['enabled'][i]:
                p = params(a, i); x, xc = fconst(a, p['xAngle']); assert xc and abs(x - 270) < 1e-3 and enum(a, p['space']) == 0, (x, xc)
                a['enabled'][i] = False; hits += 1
    return hits
def rewrite(o, raw, f):
    w = fsmwrite.W()
    for st in f['states']: fsmwrite.write_state(w, st)
    new = raw[:f['states'][0]['_pos']] + bytes(w.b) + raw[f['_afterStates']:]
    g = fsmparse.parse(new); assert '_err' not in g, g.get('_err')
    o.set_raw_data(new)
report = {}
for o in list(env.objects):
    if o.type.name != 'MonoBehaviour': continue
    raw = bytes(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    name = gos.get((id(o.assets_file), struct.unpack_from('<q', raw, 4)[0]))
    if name == 't_Spawner':
        f = fsmparse.parse(raw); assert '_err' not in f
        report['spawner'] = spawner(f); rewrite(o, raw, f)
    elif name in ('obsticleMover', 'obsticleMoveUpDown1', 'obsticleMoveUpDown2', 'obsticleMoveUpDown3', 'deathTower') and o.assets_file.name.endswith('sharedassets0.assets'):
        f = fsmparse.parse(raw); assert '_err' not in f
        hits = prefab_fsm(f, name); assert hits == 1, (name, hits); report[name] = hits; rewrite(o, raw, f)
assert report.get('spawner') and len(report) == 6, report
print('spawner: %d translates of spawned objects -> Self space, %d spawn offsets -> Self-space translates; prefabs: %s' % (report['spawner'][0], report['spawner'][1], sorted(k for k in report if k != 'spawner')))
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
