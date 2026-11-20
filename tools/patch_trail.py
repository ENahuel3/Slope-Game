"""Add an "always show the speed trail" mode to the Sphere FSM.
usage: patch_trail.py <in data.unity3d> <out data.unity3d>
The ball's TrailRenderer (GameObject 27 "Trail") is shown only while its legacy Animation plays TrailOn /
TrailOnShort (m_Time 0.5); TrailOff (looping, m_Time 0) hides it. Added to the Sphere FSM (level0 #331):
  bool ModTrailAlways (false)
  "Mod Trail Always On"  : ModTrailAlways = true  -> FINISHED -> Mod Trail Hold A
  "Mod Trail Always Off" : ModTrailAlways = false -> FINISHED -> SpeedFXOff (normal fade out)
  "Mod Trail Hold A/B"   : replay TrailOn / TrailOnShort before either reaches its fade, alternately
  "Mod Trail Check"      : BoolTest ModTrailAlways -> Hold A
SpeedFXOff and SpeedFXOff Mini end with the same BoolTest; Restart Game waits 0.25 s (its delayed
destroySelf goes first) and then enters Mod Trail Check. JS switches the mode with SendMessage SetState."""
import copy, struct, sys
from pathlib import Path
import UnityPy
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fsmparse, fsmwrite

VAR = 'ModTrailAlways'
EV_HOLD, EV_A, EV_B, EV_CHECK = 'ModTrailHold', 'ModTrailA', 'ModTrailB', 'ModTrailCheck'
LISTS = {17: 'bool', 18: 'string', 19: 'gameObject', 20: 'ownerDefault', 31: 'eventTarget'}

def named(**kw):
    d = dict(use=False, name='', tooltip='', show=False, net=False); d.update(kw); return d

def find_action(env, suffix):
    for o in env.objects:
        if o.type.name != 'MonoBehaviour': continue
        data = bytes(o.get_raw_data())
        if suffix.encode() not in data: continue
        try: f = fsmparse.parse(data)
        except Exception: continue
        for st in f.get('states', []):
            a = st['actions']
            for i, n in enumerate(a['names']):
                if n.endswith('.' + suffix): return a, i
    raise SystemExit('no %s action found' % suffix)

def empty_actions(template):
    r = copy.deepcopy(template)
    for k, v in list(r.items()):
        if isinstance(v, list): r[k] = []
    r['bytes'] = b''
    return r

def append(result, source, i, over=None):
    """copy action i of source into result; over: {param: bytes | dict (list entry fields)}"""
    over = over or {}
    result['names'].append(source['names'][i]); result['custom'].append(source['custom'][i])
    result['enabled'].append(True); result['open'].append(False); result['hash'].append(source['hash'][i])
    result['start'].append(len(result['pname']))
    s = source['start'][i]; e = source['start'][i + 1] if i + 1 < len(source['names']) else len(source['pname'])
    for k in range(s, e):
        p, t = source['pname'][k], source['ptype'][k]
        result['pname'].append(p); result['ptype'].append(t)
        if source['psize'][k] == 0 and t in LISTS and not isinstance(over.get(p), bytes):
            field = LISTS[t]; obj = copy.deepcopy(source[field][source['ppos'][k]])
            if p in over: obj.update(over[p])
            obj.pop('_pos', None)
            result['ppos'].append(len(result[field])); result['psize'].append(0); result[field].append(obj)
        else:
            data = over.get(p, source['bytes'][source['ppos'][k]:source['ppos'][k] + source['psize'][k]])
            result['ppos'].append(len(result['bytes'])); result['psize'].append(len(data)); result['bytes'] += data

def fl(v): return struct.pack('<fB', v, 0)
def tr(event, to): return dict(event=dict(name=event, sys=event == 'FINISHED', glob=False), to=to, linkStyle=0, linkConstraint=0, color=False)

def apply(env):
    level = next(o.assets_file for o in env.objects if o.assets_file.name == 'level0')
    obj = level.objects[331]; raw = bytes(obj.get_raw_data()); f = fsmparse.parse(raw)
    assert f['go'] == (0, 74) and f['fsmName'] == 'FSM', (f['go'], f['fsmName'])
    assert not any(s['name'].startswith('Mod Trail') for s in f['states']), 'already patched'
    fsmwrite.roundtrip_check(raw, f)
    S = {s['name']: s for s in f['states']}
    off = S['SpeedFXOff']['actions']
    pa = next(i for i, n in enumerate(off['names']) if n.endswith('.PlayAnimation') and off['ownerDefault'][off['ppos'][off['start'][i]]]['go']['ptr'] == (0, 27))
    wait = find_action(env, 'Wait'); setb = find_action(env, 'SetBoolValue'); test = find_action(env, 'BoolTest')
    var = b'\0\1' + VAR.encode()                     # FsmBool in byte data: value, useVariable, name
    def boolTest(a): append(a, *test, over=dict(boolVariable=var, isTrue=EV_HOLD.encode(), isFalse=b'', everyFrame=b'\0'))
    def hold(name, clip, secs, ev, nxt):
        st = copy.deepcopy(S['SpeedFXOff']); st['name'] = name; st['transitions'] = [tr(ev, nxt)]
        a = empty_actions(off)
        append(a, off, pa, dict(animName=dict(use=False, name='', v=clip), blendTime=fl(0), finishEvent=b'', loopEvent=b'', stopOnExit=b'\0'))
        append(a, *wait, over=dict(time=fl(secs), finishEvent=ev.encode(), realTime=b'\1'))
        st['actions'] = a; return st
    def simple(name, build, trans):
        st = copy.deepcopy(S['SpeedFXOff']); st['name'] = name; st['transitions'] = trans
        a = empty_actions(off); build(a); st['actions'] = a; return st
    new_states = [
        simple('Mod Trail Always On', lambda a: append(a, *setb, over=dict(boolVariable=var, boolValue=b'\1\0', everyFrame=b'\0')), [tr('FINISHED', 'Mod Trail Hold A')]),
        simple('Mod Trail Always Off', lambda a: append(a, *setb, over=dict(boolVariable=var, boolValue=b'\0\0', everyFrame=b'\0')), [tr('FINISHED', 'SpeedFXOff')]),
        hold('Mod Trail Hold A', 'TrailOn', 0.6, EV_B, 'Mod Trail Hold B'),
        hold('Mod Trail Hold B', 'TrailOnShort', 0.3, EV_A, 'Mod Trail Hold A'),
        simple('Mod Trail Check', boolTest, [tr(EV_HOLD, 'Mod Trail Hold A')]),
    ]
    for n in ('SpeedFXOff', 'SpeedFXOff Mini'):
        boolTest(S[n]['actions']); S[n]['transitions'].append(tr(EV_HOLD, 'Mod Trail Hold A'))
    append(S['Restart Game']['actions'], *wait, over=dict(time=fl(0.25), finishEvent=EV_CHECK.encode(), realTime=b'\1'))
    S['Restart Game']['transitions'].append(tr(EV_CHECK, 'Mod Trail Check'))
    states = f['states'] + new_states
    w = fsmwrite.W(); w.i32(len(states))
    for s in states: fsmwrite.write_state(w, s)
    # events (+4 local events), then global transitions and variables unchanged up to the bool list
    old_ev = fsmwrite.W(); old_ev.arr(f['events'], lambda e: (old_ev.str(e['name']), old_ev.bool(e['sys']), old_ev.bool(e['glob'])))
    a0 = f['_afterStates']; assert raw[a0:a0 + len(old_ev.b)] == bytes(old_ev.b)
    events = f['events'] + [dict(name=n, sys=False, glob=False) for n in (EV_HOLD, EV_A, EV_B, EV_CHECK)]
    ev = fsmwrite.W(); ev.arr(events, lambda e: (ev.str(e['name']), ev.bool(e['sys']), ev.bool(e['glob'])))
    bp = f['variables']['_boolPos']; bools = f['variables']['bool']
    def wbools(x, items): x.arr(items, lambda v: (x.bool(v['use']), x.str(v['name']), x.str(v['tooltip']), x.bool(v['show']), x.bool(v['net']), x.bool(v['v'])))
    ob = fsmwrite.W(); wbools(ob, bools); assert raw[bp:bp + len(ob.b)] == bytes(ob.b)
    nb = fsmwrite.W(); wbools(nb, bools + [named(name=VAR, v=False)])
    pos = f['states'][0]['_pos'] - 4
    new = raw[:pos] + bytes(w.b) + bytes(ev.b) + raw[a0 + len(old_ev.b):bp] + bytes(nb.b) + raw[bp + len(ob.b):]
    p = fsmparse.parse(new); assert '_err' not in p, p.get('_err'); fsmwrite.roundtrip_check(new, p)
    assert [b['name'] for b in p['variables']['bool']][-1] == VAR and len(p['states']) == len(f['states']) + 5
    obj.set_raw_data(new)
    print('Sphere FSM: always-on speed trail states added (%d -> %d bytes)' % (len(raw), len(new)))

if __name__ == '__main__':
    if len(sys.argv) != 3: sys.exit(__doc__)
    env = UnityPy.load(sys.argv[1]); apply(env)
    Path(sys.argv[2]).write_bytes(env.file.save(packer='original'))
