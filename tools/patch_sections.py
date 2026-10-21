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
REPATCH = '--repatch' in sys.argv     # a bundle already patched by this script: only apply the lone-slope wrap (the earlier pipeline stages' inputs are not kept)
src, dst = [x for x in sys.argv[1:] if not x.startswith('--')][:2]
VAR = 'ModSectionDelay'
WAIT = 'HutongGames.PlayMaker.Actions.Wait'
SUB = int(os.environ.get('SUB', '3'))                      # sub-steps per lane block
SCALE_PREFAB = os.environ.get('NOSCALE') is None
UNCHAINED = True              # the K sub-steps live inside one state (chained sub-states hung the game at game over)
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
def subdivide(st):
    """st = a split sub-state [Translate SpawnPos Fwd(y=-10, z=BlockLength), Pmt Spawn slope, ..., Wait]"""
    a = st['actions']; n = len(a['names'])
    if n < 3 or not a['names'][0].endswith('.Translate') or not a['custom'][0].startswith('Translate SpawnPos') or not a['names'][1].endswith('.PmtSpawn') or not a['enabled'][1]: return None
    pend = lambda i: a['start'][i + 1] if i + 1 < n else len(a['pname'])
    p0, p1 = a['start'][0], pend(0); names0 = {a['pname'][k]: k for k in range(p0, p1)}
    if inline_float(a, names0['y']) != -10.0 or inline_float(a, names0['z']) != ('var', 'BlockLength'): return None
    gk = next(k for k in range(a['start'][1], pend(1)) if a['pname'][k] == 'gameObject')
    go = a['gameObject'][a['ppos'][gk]]
    if go['use'] or go['ptr'] != SLOPE_PREFAB: return None
    if UNCHAINED:
        t = copy.deepcopy(st); b = t['actions']
        # [Translate, Spawn] repeated SUB times (translate consts -10/SUB), then the other actions and the Wait
        keep = [0, 'R', 1] * SUB + list(range(2, n))          # translate, SetRotation(ModQj), spawn; ... ; wait
        go_k = next(k for k in range(a['start'][0], pend(0)) if a['pname'][k] == 'gameObject')   # the spawn transform (owner-default index)
        data = bytes(a['bytes']); val = struct.pack('<f', -10.0 / SUB) + b'\x00'
        pn, pt, pp, ps, starts, names, custom, enabled, opened, hashes = [], [], [], [], [], [], [], [], [], []
        j = 0
        for i in keep:
            starts.append(len(pn))
            if i == 'R':
                j += 1
                qb = b'\x00' * 16 + b'\x01' + QVARS[j - 1].encode(); none3 = b'\x00' * 12 + b'\x01'; nonef = b'\x00' * 4 + b'\x01'
                for nm, ty, bts in [('gameObject', 20, None), ('quaternion', 35, qb), ('vector', 28, none3), ('xAngle', 15, nonef), ('yAngle', 15, nonef), ('zAngle', 15, nonef), ('space', 7, struct.pack('<i', 0)), ('everyFrame', 1, b'\x00'), ('lateUpdate', 1, b'\x00')]:
                    pn.append(nm); pt.append(ty)
                    if bts is None: pp.append(a['ppos'][go_k]); ps.append(0)
                    else: pp.append(len(data)); ps.append(len(bts)); data += bts
                names.append(SETROT); custom.append(''); enabled.append(True); opened.append(False); hashes.append(SETROT_HASH)
                continue
            s0, e0 = a['start'][i], pend(i)
            pn += a['pname'][s0:e0]; pt += a['ptype'][s0:e0]; pp += a['ppos'][s0:e0]; ps += a['psize'][s0:e0]
            names.append(a['names'][i]); custom.append(a['custom'][i]); enabled.append(a['enabled'][i]); opened.append(a['open'][i]); hashes.append(a['hash'][i])
        b['names'] = names; b['custom'] = custom; b['enabled'] = enabled; b['open'] = opened; b['hash'] = hashes
        b['start'] = starts; b['pname'] = pn; b['ptype'] = pt; b['ppos'] = pp; b['psize'] = ps
        for jj in range(SUB):                                   # the translates' y and z become constants of -10/SUB
            t0 = starts[3 * jj]
            for nm in ('y', 'z'):
                k = next(k for k in range(t0, starts[3 * jj + 1]) if pn[k] == nm)
                pp[k] = len(data); ps[k] = len(val); data += val
        b['bytes'] = data
        return [t]
    subs = []
    for j in range(SUB):
        t = copy.deepcopy(st); b = t['actions']
        last = j == SUB - 1
        keep = list(range(0, n)) if last else [0, 1, n - 1]          # translate, spawn, (others), wait
        # rebuild action arrays from the kept indices
        pn, pt, pp, ps, starts = [], [], [], [], []
        for i in keep:
            starts.append(len(pn)); s0, e0 = a['start'][i], pend(i)
            pn += a['pname'][s0:e0]; pt += a['ptype'][s0:e0]; pp += a['ppos'][s0:e0]; ps += a['psize'][s0:e0]
        b['names'] = [a['names'][i] for i in keep]; b['custom'] = [a['custom'][i] for i in keep]; b['enabled'] = [a['enabled'][i] for i in keep]; b['open'] = [a['open'][i] for i in keep]; b['hash'] = [a['hash'][i] for i in keep]
        b['start'] = starts; b['pname'] = pn; b['ptype'] = pt; b['ppos'] = pp; b['psize'] = ps
        # the translate's y and z become constants of -10/SUB
        data = bytes(a['bytes']); val = struct.pack('<f', -10.0 / SUB) + b'\x00'
        for nm in ('y', 'z'):
            try: k = next(k for k in range(starts[0], starts[1]) if pn[k] == nm)
            except StopIteration: raise RuntimeError('%s: %s not in %s (starts %s, keep %s, n %d, names %s)' % (st['name'], nm, pn[starts[0]:starts[1]], starts, keep, n, [x.split('.')[-1] for x in a['names']]))
            pp[k] = len(data); ps[k] = len(val); data += val
        b['bytes'] = data
        if j > 0: t['name'] = '%s.%d' % (st['name'], j)
        if not last: t['transitions'] = [{'event': {'name': 'FINISHED', 'sys': True, 'glob': False}, 'to': '%s.%d' % (st['name'], j + 1), 'linkStyle': 0, 'linkConstraint': 0, 'color': False}]
        subs.append(t)
    return subs
SLAB_LABEL = 'Mod slab step'
def wrap_lone_slopes(st):
    """A spawn of the (now 1/SUB long) slope prefab that is not one of a lane step's SUB sub-steps still has to
    cover a full block: the first block of every section, spawned after the gap between sections, left a hole
    2/SUB of a block long. Spawn it SUB times: step back 2/SUB of a block along the block's own axis first
    (self space: one block is (0, -10, -10)) and forward 1/SUB between the slabs, so the spawn point ends up
    where it was. Returns the number of spawns wrapped; a second run finds nothing to do."""
    a = st['actions']; n = len(a['names'])
    pend = lambda i: a['start'][i + 1] if i + 1 < n else len(a['pname'])
    def prefab(i):
        gk = next((k for k in range(a['start'][i], pend(i)) if a['pname'][k] == 'gameObject'), None)
        return a['gameObject'][a['ppos'][gk]] if gk is not None and a['ptype'][gk] == 19 else None
    lone = []
    for i in range(n):
        if not a['names'][i].endswith('.PmtSpawn') or not a['enabled'][i]: continue
        go = prefab(i)
        if not go or go['use'] or go['ptr'] != SLOPE_PREFAB: continue
        if i and (a['names'][i - 1] == SETROT or a['custom'][i - 1] == SLAB_LABEL): continue
        lone.append(i)
    if not lone: return 0
    src = next(i for i in range(n) if a['names'][i].endswith('.Translate') and a['custom'][i].startswith('Translate SpawnPos'))
    step = 10.0 / SUB; items = []
    for i in range(n):
        items += ([('T', 2 * step), i] + [('T', -step), i] * (SUB - 1)) if i in lone else [i]
    data = bytes(a['bytes']); nonef = b'\x00' * 4 + b'\x01'
    pn, pt, pp, ps, starts, names, custom, enabled, opened, hashes = [], [], [], [], [], [], [], [], [], []
    for it in items:
        starts.append(len(pn)); new = isinstance(it, tuple); i = src if new else it
        for k in range(a['start'][i], pend(i)):
            pn.append(a['pname'][k]); pt.append(a['ptype'][k])
            if new and a['pname'][k] in ('x', 'y', 'z'):
                bts = nonef if a['pname'][k] == 'x' else struct.pack('<f', it[1]) + b'\x00'
                pp.append(len(data)); ps.append(len(bts)); data += bts
            else: pp.append(a['ppos'][k]); ps.append(a['psize'][k])
        names.append(a['names'][i]); custom.append(SLAB_LABEL if new else a['custom'][i]); enabled.append(True if new else a['enabled'][i]); opened.append(False if new else a['open'][i]); hashes.append(a['hash'][i])
    a['names'] = names; a['custom'] = custom; a['enabled'] = enabled; a['open'] = opened; a['hash'] = hashes
    a['start'] = starts; a['pname'] = pn; a['ptype'] = pt; a['ppos'] = pp; a['psize'] = ps; a['bytes'] = data
    return len(lone)
def rebuild(raw, f, states):
    w = fsmwrite.W()
    for st in states: fsmwrite.write_state(w, st)
    count_pos = f['states'][0]['_pos'] - 4
    new = raw[:count_pos] + struct.pack('<i', len(states)) + bytes(w.b) + raw[f['_afterStates']:]
    g = fsmparse.parse(new); assert '_err' not in g, g.get('_err'); assert len(g['states']) == len(states)
    return new
def repatch(raw):
    """--repatch: only the lone-slope wrap, on a bundle this script patched before that pass existed"""
    f = fsmparse.parse(raw); assert '_err' not in f
    assert any(x['name'] == VAR for x in f['variables']['float']), 'not a patched bundle'
    wrapped = sum(wrap_lone_slopes(st) for st in f['states'])
    return rebuild(raw, f, f['states']), ['wrapped %d lone slope spawns' % wrapped]
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
