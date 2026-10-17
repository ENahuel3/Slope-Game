"""Let the course spawn one block per frame, switchable at runtime.
The spawner builds a whole run inside one frame: each section state is a straight list of
"Translate SpawnPos ..." / "Pmt Spawn ..." actions. This splits every such state at each spawn-point
translate into chained sub-states that each end with Wait(time = ModSectionDelay), a new FSM float
variable. 0 (the default) waits nothing, so the run still bursts; > 0 makes every block take a frame,
so a mod can rotate the spawn transform per block. usage: patch_sections.py <in data.unity3d> <out>"""
import sys, struct, os, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fsmparse, fsmwrite, UnityPy
src, dst = sys.argv[1], sys.argv[2]
VAR = 'ModSectionDelay'
WAIT = 'HutongGames.PlayMaker.Actions.Wait'
def ustr(s): b = s.encode(); return struct.pack('<i', len(b)) + b + b'\0' * ((4 - len(b) % 4) % 4)
def add_variable(raw):
    f = fsmparse.parse(raw); v = f['variables']
    assert not any(x['name'] == VAR for x in v['float']), 'already patched'
    end = v['float'][-1]['_valPos'] + 4
    entry = struct.pack('<i', 0) + ustr(VAR) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<f', 0.0)
    raw = raw[:end] + entry + raw[end:]
    return raw[:v['_pos']] + struct.pack('<i', len(v['float']) + 1) + raw[v['_pos'] + 4:]
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
def patch(raw):
    raw = add_variable(raw); report = ['added float variable ' + VAR]
    f = fsmparse.parse(raw); assert '_err' not in f
    wait_hash = next(st['actions']['hash'][i] for st in f['states'] for i, nm in enumerate(st['actions']['names']) if nm == WAIT)
    out, extra = [], []
    for st in f['states']:
        subs = split_state(st, wait_hash)
        if not subs: out.append(st); continue
        out.append(subs[0]); extra += subs[1:]
        report.append('%s -> %d sub-states' % (st['name'], len(subs)))
    w = fsmwrite.W()
    for st in out + extra: fsmwrite.write_state(w, st)
    count_pos = f['states'][0]['_pos'] - 4
    new = raw[:count_pos] + struct.pack('<i', len(out) + len(extra)) + bytes(w.b) + raw[f['_afterStates']:]
    g = fsmparse.parse(new); assert '_err' not in g, g.get('_err'); assert len(g['states']) == len(out) + len(extra)
    assert any(x['name'] == VAR for x in g['variables']['float'])
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
    new, report = patch(raw); print('\n'.join(report)); print('raw', len(raw), '->', len(new))
    o.set_raw_data(new); done = True
assert done
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
