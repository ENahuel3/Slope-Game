"""Serializer matching fsmparse.parse()'s layout."""
import struct
class W:
    def __init__(s): s.b = bytearray()
    def i32(s, v): s.b += struct.pack('<i', v)
    def f32(s, v): s.b += struct.pack('<f', v)
    def align(s): s.b += b'\0' * ((4 - len(s.b) % 4) % 4)
    def str(s, v): e = v.encode(); s.i32(len(e)); s.b += e; s.align()
    def bool(s, v): s.b += bytes([1 if v else 0]); s.align()
    def bools(s, v): s.i32(len(v)); s.b += bytes(1 if x else 0 for x in v); s.align()
    def bytes_(s, v): s.i32(len(v)); s.b += v; s.align()
    def ints(s, v): s.i32(len(v)); s.b += struct.pack('<%di' % len(v), *v)
    def arr(s, v, fn): s.i32(len(v)); [fn(x) for x in v]
    def pptr(s, v): s.i32(v[0]); s.b += struct.pack('<q', v[1])
def write_state(w, st):
    def named(d): w.bool(d['use']); w.str(d['name']); w.str(d['tooltip']); w.bool(d['show']); w.bool(d['net'])
    def fsmGO(d): named(d); w.pptr(d['ptr'])
    def ownerDef(d): w.i32(d['opt']); fsmGO(d['go'])
    def fsmString(d): named(d); w.str(d['v'])
    def fsmObject(d): named(d); w.str(d['type']); w.pptr(d['ptr'])
    def fsmFloat(d): named(d); w.f32(d['v'])
    def fsmInt(d): named(d); w.i32(d['v'])
    def fsmBool(d): named(d); w.bool(d['v'])
    def fsmVn(d): named(d); [w.f32(x) for x in d['v']]
    def fsmEnum(d): named(d); w.str(d['enum']); w.i32(d['v'])
    def fsmEvent(d): w.str(d['name']); w.bool(d['sys']); w.bool(d['glob'])
    def eventTarget(d): w.i32(d['target']); fsmBool(d['excludeSelf']); ownerDef(d['go']); fsmString(d['fsmName']); fsmBool(d['sendToChildren']); w.pptr(d['comp'])
    def transition(t): fsmEvent(t['event']); w.str(t['to']); w.i32(t['linkStyle']); w.i32(t['linkConstraint']); w.bool(t['color'])
    w.str(st['name']); w.str(st['desc']); w.bool(st['color']); [w.f32(x) for x in st['rect']]
    w.bool(st['isBreak']); w.bool(st['isSeq']); w.bool(st['hideUnused'])
    w.arr(st['transitions'], transition)
    a = st['actions']
    w.arr(a['names'], w.str); w.arr(a['custom'], w.str); w.bools(a['enabled']); w.bools(a['open']); w.ints(a['start']); w.ints(a['hash'])
    w.arr(a['unityObject'], w.pptr); w.arr(a['gameObject'], fsmGO); w.arr(a['ownerDefault'], ownerDef)
    w.i32(0); w.i32(len(a.get('functionCall', []))); assert not a.get('functionCall'); w.i32(0); w.arr(a['eventTarget'], eventTarget); assert not a.get('fsmProperty'); w.i32(0); w.i32(0)
    w.arr(a['string'], fsmString); w.arr(a['object'], fsmObject); assert not a.get('fsmVar') and not a.get('fsmArray'); w.i32(0); w.i32(0); w.arr(a['enum'], fsmEnum)
    w.arr(a['float'], fsmFloat); w.arr(a['int'], fsmInt); w.arr(a['bool'], fsmBool); w.arr(a['v2'], fsmVn); w.arr(a['v3'], fsmVn); w.arr(a['color'], fsmVn); w.arr(a['rect'], fsmVn); w.arr(a['quat'], fsmVn)
    w.arr(a['stringParams'], w.str); w.bytes_(bytes(a['bytes']))
    w.ints(a['arrayParamSizes']); w.arr(a['arrayParamTypes'], w.str); w.ints(a['customTypeSizes']); w.arr(a['customTypeNames'], w.str)
    w.ints(a['ptype']); w.arr(a['pname'], w.str); w.ints(a['ppos']); w.ints(a['psize'])
def roundtrip_check(raw, f):
    """Re-serialize every state and compare with the original bytes."""
    for st in f['states']:
        w = W(); write_state(w, st)
        orig = raw[st['_pos']:st['_end']]
        if bytes(w.b) != orig:
            n = next((i for i in range(min(len(w.b), len(orig))) if w.b[i] != orig[i]), min(len(w.b), len(orig)))
            raise AssertionError('state %r differs at %d (%d vs %d bytes)' % (st['name'], n, len(w.b), len(orig)))
    return True
