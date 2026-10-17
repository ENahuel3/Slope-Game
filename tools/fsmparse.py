"""PlayMaker 1.8-era PlayMakerFSM MonoBehaviour raw-data parser (Unity 2017.4 WebGL, no typetree)."""
import struct
class R:
    def __init__(s, b, p=0): s.b = b; s.p = p
    def i32(s): v = struct.unpack_from('<i', s.b, s.p)[0]; s.p += 4; return v
    def u8(s): v = s.b[s.p]; s.p += 1; return v
    def f32(s): v = struct.unpack_from('<f', s.b, s.p)[0]; s.p += 4; return v
    def align(s): s.p = (s.p + 3) & ~3
    def str(s): n = s.i32(); v = s.b[s.p:s.p+n].decode('utf-8', 'replace'); s.p += n; s.align(); return v
    def bool(s): v = s.u8(); s.align(); return bool(v)
    def bools(s): n = s.i32(); v = [bool(x) for x in s.b[s.p:s.p+n]]; s.p += n; s.align(); return v
    def bytes_(s): n = s.i32(); v = s.b[s.p:s.p+n]; s.p += n; s.align(); return v
    def ints(s): n = s.i32(); v = list(struct.unpack_from('<%di' % n, s.b, s.p)); s.p += 4*n; return v
    def arr(s, fn): n = s.i32(); return [fn() for _ in range(n)]
    def pptr(s): fid = s.i32(); pid = struct.unpack_from('<q', s.b, s.p)[0]; s.p += 8; return (fid, pid)
def parse(b):
    r = R(b)
    def named():
        d = {'_pos': r.p}; d['use'] = r.bool(); d['name'] = r.str(); d['tooltip'] = r.str(); d['show'] = r.bool(); d['net'] = r.bool(); return d
    def fsmGO(): d = named(); d['ptr'] = r.pptr(); return d
    def ownerDef(): return {'opt': r.i32(), 'go': fsmGO()}
    def fsmString(): d = named(); d['v'] = r.str(); return d
    def fsmObject(): d = named(); d['type'] = r.str(); d['ptr'] = r.pptr(); return d
    def fsmFloat(): d = named(); d['_valPos'] = r.p; d['v'] = r.f32(); return d
    def fsmInt(): d = named(); d['_valPos'] = r.p; d['v'] = r.i32(); return d
    def fsmBool(): d = named(); d['_valPos'] = r.p; d['v'] = r.bool(); return d
    def fsmV2(): d = named(); d['v'] = [r.f32(), r.f32()]; return d
    def fsmV3(): d = named(); d['v'] = [r.f32(), r.f32(), r.f32()]; return d
    def fsm4(): d = named(); d['v'] = [r.f32() for _ in range(4)]; return d
    def fsmEnum(): d = named(); d['enum'] = r.str(); d['v'] = r.i32(); return d
    def fsmEvent(): return {'name': r.str(), 'sys': r.bool(), 'glob': r.bool()}
    def eventTarget(): return {'target': r.i32(), 'excludeSelf': fsmBool(), 'go': ownerDef(), 'fsmName': fsmString(), 'sendToChildren': fsmBool(), 'comp': r.pptr()}
    def transition():
        d = {'event': fsmEvent()}; d['_toPos'] = r.p; d['to'] = r.str(); d['linkStyle'] = r.i32(); d['linkConstraint'] = r.i32(); d['color'] = r.bool(); return d
    def zero(label):
        n = r.i32()
        if n: raise ValueError('unsupported non-empty list %s (%d) at %d' % (label, n, r.p - 4))
        return []
    def actionData():
        a = {'_pos': r.p}
        a['names'] = r.arr(r.str); a['custom'] = r.arr(r.str); a['_enabledPos'] = r.p; a['enabled'] = r.bools(); a['open'] = r.bools(); a['start'] = r.ints(); a['hash'] = r.ints()
        a['unityObject'] = r.arr(r.pptr); a['gameObject'] = r.arr(fsmGO); a['ownerDefault'] = r.arr(ownerDef)
        zero('animCurve'); zero('functionCall'); zero('templateControl'); a['eventTarget'] = r.arr(eventTarget); zero('fsmProperty'); zero('layoutOption')
        a['string'] = r.arr(fsmString); a['object'] = r.arr(fsmObject); zero('fsmVar'); zero('fsmArray'); a['enum'] = r.arr(fsmEnum)
        a['float'] = r.arr(fsmFloat); a['int'] = r.arr(fsmInt); a['bool'] = r.arr(fsmBool); a['v2'] = r.arr(fsmV2); a['v3'] = r.arr(fsmV3); a['color'] = r.arr(fsm4); a['rect'] = r.arr(fsm4); a['quat'] = r.arr(fsm4)
        a['stringParams'] = r.arr(r.str); a['_bytesPos'] = r.p; a['bytes'] = r.bytes_()
        a['arrayParamSizes'] = r.ints(); a['arrayParamTypes'] = r.arr(r.str); a['customTypeSizes'] = r.ints(); a['customTypeNames'] = r.arr(r.str)
        a['ptype'] = r.ints(); a['pname'] = r.arr(r.str); a['_pposPos'] = r.p; a['ppos'] = r.ints(); a['_psizePos'] = r.p; a['psize'] = r.ints()
        a['_end'] = r.p
        return a
    def state():
        st = {'_pos': r.p}
        st['name'] = r.str(); st['desc'] = r.str(); st['color'] = r.bool(); st['rect'] = [r.f32() for _ in range(4)]
        st['isBreak'] = r.bool(); st['isSeq'] = r.bool(); st['hideUnused'] = r.bool()
        st['transitions'] = r.arr(transition); st['actions'] = actionData(); st['_end'] = r.p
        return st
    f = {'go': r.pptr(), 'enabled': r.bool(), 'script': r.pptr(), 'mname': r.str(), 'dataVersion': r.i32(), 'owner': r.pptr(), 'fsmName': r.str(), 'startState': r.str()}
    f['states'] = r.arr(state)
    f['_afterStates'] = r.p
    try:
        f['events'] = r.arr(fsmEvent); f['globalTransitions'] = r.arr(transition)
        v = {'_pos': r.p}
        v['float'] = r.arr(fsmFloat); v['int'] = r.arr(fsmInt); v['bool'] = r.arr(fsmBool); v['string'] = r.arr(fsmString); v['v2'] = r.arr(fsmV2); v['v3'] = r.arr(fsmV3)
        v['color'] = r.arr(fsm4); v['rect'] = r.arr(fsm4); v['quat'] = r.arr(fsm4); v['gameObject'] = r.arr(fsmGO); v['object'] = r.arr(fsmObject)
        f['variables'] = v; f['_afterVars'] = r.p
    except Exception as e:
        f['_err'] = str(e)
    return f
TYPES = {0: 'int', 1: 'bool', 2: 'float', 3: 'string', 7: 'enum', 15: 'FsmFloat', 16: 'FsmInt', 17: 'FsmBool', 18: 'FsmString', 19: 'FsmGameObject', 20: 'FsmOwnerDefault', 23: 'FsmEvent', 24: 'FsmObject', 28: 'FsmVector3', 31: 'FsmEventTarget'}
def decode_param(a, k):
    if k >= len(a['ptype']): return ('?', 'out-of-range')
    t, nm, pos, sz = a['ptype'][k], a['pname'][k], a['ppos'][k], a['psize'][k]; d = a['bytes'][pos:pos+sz]
    if t == 15: return nm, ('var', d[5:].decode()) if (sz > 4 and d[4]) else ('%.4g' % struct.unpack_from('<f', d)[0] if sz >= 4 else '?')
    if t == 16: return nm, ('var', d[5:].decode()) if (sz > 4 and d[4]) else (struct.unpack_from('<i', d)[0] if sz >= 4 else '?')
    if t == 17: return nm, ('var', d[2:].decode()) if (sz > 1 and d[1]) else bool(d[0]) if sz else '?'
    if t == 1: return nm, bool(d[0]) if sz else '?'
    if t == 0: return nm, struct.unpack_from('<i', d)[0] if sz >= 4 else '?'
    if t == 2: return nm, '%.4g' % struct.unpack_from('<f', d)[0] if sz >= 4 else '?'
    if t == 7: return nm, ('enum', struct.unpack_from('<i', d)[0] if sz >= 4 else '?')
    if t == 28: return nm, ('var', d[13:].decode()) if (sz > 12 and d[12]) else tuple('%.4g' % x for x in struct.unpack_from('<3f', d)) if sz >= 12 else '?'
    if t == 23: return nm, ('event', d.decode())
    if t == 18: e = a['string'][pos]; return nm, ('strvar', e['name']) if e['use'] else ('str', e['v'])
    if t == 19: e = a['gameObject'][pos]; return nm, ('govar', e['name']) if e['use'] else ('go', e['ptr'])
    if t == 20: e = a['ownerDefault'][pos]; return nm, ('owner' if e['opt'] == 0 else ('govar', e['go']['name']) if e['go']['use'] else ('go', e['go']['ptr']))
    if t == 31: e = a['eventTarget'][pos]; return nm, ('target', e['target'], e['fsmName']['v'])
    if t == 24: e = a['object'][pos]; return nm, ('obj', e['name'] if e['use'] else e['ptr'])
    return nm, ('t%d' % t, sz)
def dump(f, out):
    w = out.write
    w('FSM %s start=%s states=%d\n' % (f['fsmName'], f['startState'], len(f['states'])))
    if 'variables' in f:
        for kind in ['float', 'int', 'bool', 'string', 'v3', 'gameObject']:
            w('VARS %s: %s\n' % (kind, ', '.join('%s=%s' % (v['name'], v.get('v', v.get('ptr'))) for v in f['variables'][kind])))
    for st in f['states']:
        w('\nSTATE %s%s\n' % (st['name'], ' [SEQ]' if st['isSeq'] else ''))
        for t in st['transitions']: w('   on %s -> %s\n' % (t['event']['name'], t['to']))
        a = st['actions']; nA = len(a['names'])
        for i in range(nA):
            s0, e0 = a['start'][i], (a['start'][i+1] if i + 1 < nA else len(a['pname']))
            params = [decode_param(a, k) for k in range(s0, e0)]
            w('   %s%s %s: %s\n' % ('' if a['enabled'][i] else 'X ', a['custom'][i] or '-', a['names'][i].split('.')[-1], ', '.join('%s=%s' % p for p in params)))
if __name__ == '__main__':
    import sys
    f = parse(open(sys.argv[1], 'rb').read())
    if '_err' in f: print('ERR', f['_err'])
    dump(f, sys.stdout)
