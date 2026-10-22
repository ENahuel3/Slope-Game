"""Let the course spawn one block per frame, switchable at runtime.
The spawner builds a whole run inside one frame: each section state is a straight list of
"Translate SpawnPos ..." / "Pmt Spawn ..." actions. This splits every such state at each spawn-point
translate into chained sub-states that each end with Wait(time = ModSectionDelay), a new FSM float
variable. 0 (the default) waits nothing, so the run still bursts; > 0 makes every block take a frame,
so a mod can rotate the spawn transform per block. Each plain lane-block step (Translate y=-10 z=BlockLength + Pmt Spawn slope) is further cut into SUB
sub-steps with the slope prefab shortened to 1/SUB, so a rolling course is faceted every 4.7 units
instead of every 14; the lone slope spawns that open each section are spawned SUB times too (wrap_lone_slopes).
usage: patch_sections.py <in data.unity3d> <out>   |   patch_sections.py --repatch <patched data.unity3d> <out>"""
import sys, struct, os, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fsmparse, fsmwrite, UnityPy
REPATCH = '--repatch' in sys.argv     # a bundle already patched by this script (the earlier pipeline stages' inputs are not kept)
src, dst = [x for x in sys.argv[1:] if not x.startswith('--')][:2]
VAR = 'ModSectionDelay'
WAIT = 'HutongGames.PlayMaker.Actions.Wait'
SUB = int(os.environ.get('SUB', '3'))                      # sub-steps per lane block
SCALE_PREFAB = os.environ.get('NOSCALE') is None
# the SUB sub-steps live inside one state (chained sub-states hung the game at game over)
SETROT = 'HutongGames.PlayMaker.Actions.SetRotation'
SETROT_HASH = 71409303       # copied from the game's own SetRotation actions
REST_Q = (-0.70710678, 0.0, 0.0, 0.70710678)
QVARS = ['ModQ1', 'ModQ2', 'ModQ3'][:3]
SLOPE_PREFAB = (2, 118)      # the 'slope' prefab in sharedassets0
def ustr(s): b = s.encode(); return struct.pack('<i', len(b)) + b + b'\0' * ((4 - len(b) % 4) % 4)
def add_variable(raw):
    f = fsmparse.parse(raw); v = f['variables']
    assert not any(x['name'] == VAR for x in v['float']), 'already patched'
    end = v['float'][-1]['_valPos'] + 4
    entry = struct.pack('<i', 0) + ustr(VAR) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<f', 0.0)
    raw = raw[:end] + entry + raw[end:]
    raw = raw[:v['_pos']] + struct.pack('<i', len(v['float']) + 1) + raw[v['_pos'] + 4:]
    # quaternion variables ModQ1..SUB, resting at the spawn transform's rest rotation (vanilla behaviour when untouched)
    f = fsmparse.parse(raw); v = f['variables']; assert not v['quat']
    qp = v['_quatPos']; entries = b''.join(struct.pack('<i', 0) + ustr(nm) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<4f', *REST_Q) for nm in QVARS[:SUB])
    return raw[:qp] + struct.pack('<i', SUB) + entries + raw[qp + 4:]
def split_state(st, wait_hash):
    a = st['actions']; n = len(a['names'])
    tr = [i for i in range(n) if a['custom'][i].startswith('Translate SpawnPos') and a['names'][i].endswith('.Translate')]
    bounds = tr[1:]
    if not bounds: return None
    cuts = [0] + bounds + [n]
    pend = lambda i: a['start'][i] if i < n else len(a['pname'])
    subs = []
    for k in range(len(cuts) - 1):
        lo, hi = cuts[k], cuts[k + 1]
        s = copy.deepcopy(st); b = s['actions']
        p0, p1 = pend(lo), pend(hi)
        b['names'] = a['names'][lo:hi]; b['custom'] = a['custom'][lo:hi]; b['enabled'] = a['enabled'][lo:hi]; b['open'] = a['open'][lo:hi]
        b['start'] = [x - p0 for x in a['start'][lo:hi]]; b['hash'] = a['hash'][lo:hi]
        b['ptype'] = a['ptype'][p0:p1]; b['pname'] = a['pname'][p0:p1]; b['ppos'] = a['ppos'][p0:p1]; b['psize'] = a['psize'][p0:p1]
        # the Wait: time -> variable, no finish event, game time
        data = bytes(a['bytes']); tpos = len(data); tbytes = struct.pack('<f', 0.0) + b'\x01' + VAR.encode()
        b['bytes'] = data + tbytes + b'\x00'
        b['names'].append(WAIT); b['custom'].append(''); b['enabled'].append(True); b['open'].append(False); b['start'].append(len(b['pname'])); b['hash'].append(wait_hash)
        b['ptype'] += [15, 23, 1]; b['pname'] += ['time', 'finishEvent', 'realTime']; b['ppos'] += [tpos, tpos + len(tbytes), tpos + len(tbytes)]; b['psize'] += [len(tbytes), 0, 1]
        if k > 0: s['name'] = '%s #%d' % (st['name'], k); s['rect'] = [st['rect'][0], st['rect'][1] + 40 * k, st['rect'][2], st['rect'][3]]
        if k < len(cuts) - 2:
            s['transitions'] = [{'event': {'name': 'FINISHED', 'sys': True, 'glob': False}, 'to': '%s #%d' % (st['name'], k + 1), 'linkStyle': 0, 'linkConstraint': 0, 'color': False}]
        subs.append(s)
    return subs
def inline_float(a, k):
    """value of inline FsmFloat param k: ('var', name) or float"""
    pos, sz = a['ppos'][k], a['psize'][k]; d = a['bytes'][pos:pos+sz]
    return ('var', d[5:].decode()) if (sz > 4 and d[4]) else struct.unpack_from('<f', d)[0]
STEP = 10.0 / SUB            # one slab along the block's axis, in the spawn transform's self space: a block is (0, -10, -10)
SLAB_LABEL = 'Mod slab step'
# A block covers the BLOCK_LEN ahead of the spawn point it was spawned at (the slope prefab's collision plane
# is centred 7 along the course in front of its root). So a lane step [Translate(block), Spawn] becomes
# [Translate(block), Spawn, Translate(slab), Spawn, Translate(slab), Spawn, Translate(-2 slabs)]: three slabs
# covering the same block, the spawn point back where the step left it. (The first version translated a
# slab before each spawn, which put the three slabs one slab late: every section's lane ended 9.4 short.)
def pend_of(a, i): n = len(a['names']); return a['start'][i + 1] if i + 1 < n else len(a['pname'])
def rebuild_actions(a, items, src_tr):
    """Rebuild the action arrays from items: an int keeps that action; ('T', y, z) is a copy of the translate
    action src_tr with x cleared and constants y, z; ('T0', i, y, z) is action i with y, z replaced by constants;
    ('R', j) is SetRotation(quaternion = ModQj, world) on the spawn transform."""
    data = bytes(a['bytes']); nonef = b'\x00' * 4 + b'\x01'
    go_k = next(k for k in range(a['start'][src_tr], pend_of(a, src_tr)) if a['pname'][k] == 'gameObject')
    pn, pt, pp, ps, starts, names, custom, enabled, opened, hashes = [], [], [], [], [], [], [], [], [], []
    for it in items:
        starts.append(len(pn))
        if isinstance(it, tuple) and it[0] == 'R':
            qb = b'\x00' * 16 + b'\x01' + QVARS[it[1] - 1].encode(); none3 = b'\x00' * 12 + b'\x01'
            for nm, ty, bts in [('gameObject', 20, None), ('quaternion', 35, qb), ('vector', 28, none3), ('xAngle', 15, nonef), ('yAngle', 15, nonef), ('zAngle', 15, nonef), ('space', 7, struct.pack('<i', 0)), ('everyFrame', 1, b'\x00'), ('lateUpdate', 1, b'\x00')]:
                pn.append(nm); pt.append(ty)
                if bts is None: pp.append(a['ppos'][go_k]); ps.append(0)
                else: pp.append(len(data)); ps.append(len(bts)); data += bts
            names.append(SETROT); custom.append(''); enabled.append(True); opened.append(False); hashes.append(SETROT_HASH)
            continue
        if isinstance(it, tuple): i = src_tr if it[0] == 'T' else it[1]; over = {'y': it[-2], 'z': it[-1]}; clearx = it[0] == 'T'
        else: i = it; over = {}; clearx = False
        for k in range(a['start'][i], pend_of(a, i)):
            pn.append(a['pname'][k]); pt.append(a['ptype'][k])
            if a['pname'][k] in over: bts = struct.pack('<f', over[a['pname'][k]]) + b'\x00'; pp.append(len(data)); ps.append(len(bts)); data += bts
            elif clearx and a['pname'][k] == 'x': pp.append(len(data)); ps.append(len(nonef)); data += nonef
            else: pp.append(a['ppos'][k]); ps.append(a['psize'][k])
        names.append(a['names'][i]); custom.append(SLAB_LABEL if (isinstance(it, tuple) and it[0] == 'T') else a['custom'][i]); enabled.append(a['enabled'][i]); opened.append(a['open'][i]); hashes.append(a['hash'][i])
    a['names'] = names; a['custom'] = custom; a['enabled'] = enabled; a['open'] = opened; a['hash'] = hashes
    a['start'] = starts; a['pname'] = pn; a['ptype'] = pt; a['ppos'] = pp; a['psize'] = ps; a['bytes'] = data
def slab_items(spawn_i):
    """after a spawn of the slope prefab at the spawn point: two more slabs ahead, then back"""
    return [('T', -STEP, -STEP), spawn_i, ('T', -STEP, -STEP), spawn_i, ('T', 2 * STEP, 2 * STEP)]
def subdivide(st):
    """st = a split sub-state [Translate SpawnPos Fwd(y=-10, z=BlockLength), Pmt Spawn slope, ..., Wait]"""
    a = st['actions']; n = len(a['names'])
    if n < 3 or not a['names'][0].endswith('.Translate') or not a['custom'][0].startswith('Translate SpawnPos') or not a['names'][1].endswith('.PmtSpawn') or not a['enabled'][1]: return None
    p0, p1 = a['start'][0], pend_of(a, 0); names0 = {a['pname'][k]: k for k in range(p0, p1)}
    if inline_float(a, names0['y']) != -10.0 or inline_float(a, names0['z']) != ('var', 'BlockLength'): return None
    gk = next(k for k in range(a['start'][1], pend_of(a, 1)) if a['pname'][k] == 'gameObject')
    go = a['gameObject'][a['ppos'][gk]]
    if go['use'] or go['ptr'] != SLOPE_PREFAB: return None
    t = copy.deepcopy(st); b = t['actions']
    items = [0, ('R', 1), 1, ('T', -STEP, -STEP), ('R', 2), 1, ('T', -STEP, -STEP), ('R', 3), 1, ('T', 2 * STEP, 2 * STEP)] + list(range(2, n))
    rebuild_actions(b, items, 0)
    return [t]
def spawn_prefab(a, i):
    gk = next((k for k in range(a['start'][i], pend_of(a, i)) if a['pname'][k] == 'gameObject'), None)
    if gk is None or a['ptype'][gk] != 19: return None
    go = a['gameObject'][a['ppos'][gk]]; return None if go['use'] else go['ptr']
def wrap_lone_slopes(st):
    """A spawn of the (now 1/SUB long) slope prefab outside a lane step (the first block of every section, after
    the drop between sections) still has to cover a full block: two more slabs ahead of it, then the spawn
    point back where it was. Returns the number wrapped; a second run finds nothing to do."""
    a = st['actions']; n = len(a['names'])
    lone = [i for i in range(n) if a['names'][i].endswith('.PmtSpawn') and a['enabled'][i] and spawn_prefab(a, i) == SLOPE_PREFAB
            and not (i and a['names'][i - 1] == SETROT) and not (i + 1 < n and a['custom'][i + 1] == SLAB_LABEL)]
    if not lone: return 0
    src = next(i for i in range(n) if a['names'][i].endswith('.Translate') and a['custom'][i].startswith('Translate SpawnPos'))
    items = []
    for i in range(n): items += ([i] + slab_items(i)) if i in lone else [i]
    rebuild_actions(a, items, src)
    return len(lone)
def fixup_old_slabs(st):
    """Bundles patched by the first version: lane steps were [T(slab) R S] x3 (slabs one slab late) and lone
    spawns [T(+2 slabs) S T(slab) S T(slab) S] (two slabs early). Move them to the forward convention."""
    a = st['actions']; n = len(a['names']); items = []; fixed = 0; i = 0
    def isT(i, y): return i < n and a['names'][i].endswith('.Translate') and all(abs(inline_float(a, k) - y) < 1e-3 if a['pname'][k] in ('y', 'z') and not isinstance(inline_float(a, k), tuple) else True for k in range(a['start'][i], pend_of(a, i))) and any(a['pname'][k] == 'y' and not isinstance(inline_float(a, k), tuple) and abs(inline_float(a, k) - y) < 1e-3 for k in range(a['start'][i], pend_of(a, i)))
    isS = lambda i: i < n and a['names'][i].endswith('.PmtSpawn') and spawn_prefab(a, i) == SLOPE_PREFAB
    while i < n:
        if isT(i, -STEP) and i + 8 < n and a['names'][i + 1] == SETROT and isS(i + 2) and isT(i + 3, -STEP) and a['names'][i + 4] == SETROT and isT(i + 6, -STEP) and a['names'][i + 7] == SETROT and isS(i + 8):
            items += [('T0', i, -10.0, -10.0)] + list(range(i + 1, i + 9)) + [('T', 2 * STEP, 2 * STEP)]; i += 9; fixed += 1; continue
        if isT(i, 2 * STEP) and a['custom'][i] == SLAB_LABEL and i + 5 < n and isS(i + 1) and isT(i + 2, -STEP) and isS(i + 3) and isT(i + 4, -STEP) and isS(i + 5):
            items += list(range(i + 1, i + 6)) + [('T', 2 * STEP, 2 * STEP)]; i += 6; fixed += 1; continue
        items.append(i); i += 1
    if fixed:
        src = next(j for j in range(n) if a['names'][j].endswith('.Translate') and a['custom'][j].startswith('Translate SpawnPos'))
        rebuild_actions(a, items, src)
    return fixed
def rebuild(raw, f, states):
    w = fsmwrite.W()
    for st in states: fsmwrite.write_state(w, st)
    count_pos = f['states'][0]['_pos'] - 4
    new = raw[:count_pos] + struct.pack('<i', len(states)) + bytes(w.b) + raw[f['_afterStates']:]
    g = fsmparse.parse(new); assert '_err' not in g, g.get('_err'); assert len(g['states']) == len(states)
    return new
def repatch(raw):
    """--repatch: on a bundle this script patched before: move old slab groups to the forward convention and wrap lone spawns"""
    f = fsmparse.parse(raw); assert '_err' not in f
    assert any(x['name'] == VAR for x in f['variables']['float']), 'not a patched bundle'
    fixed = sum(fixup_old_slabs(st) for st in f['states'])
    wrapped = sum(wrap_lone_slopes(st) for st in f['states'])
    return rebuild(raw, f, f['states']), ['moved %d old slab groups to the forward convention' % fixed, 'wrapped %d lone slope spawns' % wrapped]
def patch(raw):
    raw = add_variable(raw); report = ['added float variable ' + VAR]
    f = fsmparse.parse(raw); assert '_err' not in f
    wait_hash = next(st['actions']['hash'][i] for st in f['states'] for i, nm in enumerate(st['actions']['names']) if nm == WAIT)
    out, extra = [], []
    for st in f['states']:
        subs = split_state(st, wait_hash)
        if not subs: out.append(st); continue
        fine = []
        for sub in subs:
            d = subdivide(sub); fine += d if d else [sub]
        out.append(fine[0]); extra += fine[1:]
        report.append('%s -> %d sub-states, %d with lane sub-steps' % (st['name'], len(subs), len(fine)))
    report.append('wrapped %d lone slope spawns' % sum(wrap_lone_slopes(st) for st in out + extra))
    new = rebuild(raw, f, out + extra)
    assert any(x['name'] == VAR for x in fsmparse.parse(new)['variables']['float'])
    return new, report
env = UnityPy.load(src)
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
done = False
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytes(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    if gos.get((id(o.assets_file), struct.unpack_from('<q', raw, 4)[0])) != 't_Spawner': continue
    new, report = repatch(raw) if REPATCH else patch(raw); print('\n'.join(report)); print('raw', len(raw), '->', len(new))
    o.set_raw_data(new); done = True
assert done
# the slope prefab: 1/SUB as long (its collision plane and neon slab scale with the root; the lane stays 10 wide)
for o in (env.objects if SCALE_PREFAB and not REPATCH else []):
    if o.type.name == 'GameObject' and o.path_id == SLOPE_PREFAB[1] and o.assets_file.name.endswith('sharedassets0.assets'):
        go = o.read(); assert go.m_Name == 'slope', go.m_Name
        for c in go.m_Components:
            pp = c.component if hasattr(c, 'component') else c; co = o.assets_file.objects[pp.path_id]
            if co.type.name == 'Transform':
                tr = co.read(); tr.m_LocalScale.y = 1.0 / SUB; tr.m_LocalScale.z = 1.0 / SUB; tr.save(); print('slope prefab scale ->', (tr.m_LocalScale.x, tr.m_LocalScale.y, tr.m_LocalScale.z))
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
