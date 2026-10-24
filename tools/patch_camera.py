"""Add native world-space camera-follow actions for rolled tracks.
Usage: patch_camera.py input-data.unity3d output-data.unity3d
The camera reads the current Sphere position in Unity, then applies the mod's
rotated offset and world quaternion in LateUpdate. Menus/normal play retain
original states; the mod enters the added state only for track shaping.
"""
import copy
from pathlib import Path
import struct
import sys
import UnityPy
import fsmparse
import fsmwrite

STATE = 'Mod follow roll'
OFFSET = (0., 3.0560860633850098, -1.2071590423583984)
ROTATION = (.4355890154838562, 0., 0., .9001456499099731)

def vector(name): return b'\0'*12 + b'\1' + name.encode()
def quaternion(name): return b'\0'*16 + b'\1' + name.encode()
def nofloat(): return b'\0'*4 + b'\1'

def write_variable(w, v, kind):
    w.bool(v['use']); w.str(v['name']); w.str(v['tooltip']); w.bool(v['show']); w.bool(v['net'])
    for value in ([v['v']] if kind == 'float' else v['v']): w.f32(value)

def add_variable(raw, kind, name, value):
    f = fsmparse.parse(raw); variables = f['variables']; items = variables[kind]
    assert not any(v['name'] == name for v in items)
    pos = items[0]['_pos'] - 4 if items else variables['_quatPos']
    if kind == 'float': pos = variables['_pos']
    old = fsmwrite.W(); old.arr(items, lambda v: write_variable(old, v, kind))
    assert raw[pos:pos+len(old.b)] == bytes(old.b)
    v = dict(use=False, name=name, tooltip='', show=False, net=False, v=value)
    new = fsmwrite.W(); new.arr(items + [v], lambda v: write_variable(new, v, kind))
    return raw[:pos] + bytes(new.b) + raw[pos+len(old.b):]

def combine(template, specs):
    result = copy.deepcopy(template)
    for field, value in list(result.items()):
        if isinstance(value, list): result[field] = []
    result['bytes'] = b''
    for source, action, overrides, owner in specs:
        name = source['names'][action]
        result['names'].append(name); result['custom'].append(source['custom'][action])
        result['enabled'].append(True); result['open'].append(False); result['hash'].append(source['hash'][action])
        result['start'].append(len(result['pname']))
        start = source['start'][action]
        end = source['start'][action+1] if action+1 < len(source['names']) else len(source['pname'])
        for k in range(start,end):
            parameter, typ = source['pname'][k], source['ptype'][k]
            result['pname'].append(parameter); result['ptype'].append(typ)
            if typ in (19,20):
                field = 'gameObject' if typ == 19 else 'ownerDefault'
                obj = copy.deepcopy(source[field][source['ppos'][k]])
                if owner and parameter == 'gameObject':
                    assert typ == 20
                    obj['opt']=0; obj['go']['use']=False; obj['go']['name']=''; obj['go']['ptr']=(0,0)
                result['ppos'].append(len(result[field])); result['psize'].append(0); result[field].append(obj)
            else:
                assert source['psize'][k] > 0, (name,parameter,typ)
                data = overrides.get(parameter, source['bytes'][source['ppos'][k]:source['ppos'][k]+source['psize'][k]])
                result['ppos'].append(len(result['bytes'])); result['psize'].append(len(data)); result['bytes'] += data
    # A heartbeat lets JS recover if a normal global camera event changes state.
    result['start'].append(len(result['pname']))
    result['names'].append('HutongGames.PlayMaker.Actions.SetFloatValue'); result['custom'].append('')
    result['enabled'].append(True); result['open'].append(False); result['hash'].append(95634840)
    for name,typ,data in [('floatVariable',15,struct.pack('<fB',0,1)+b'ModCameraTick'),('floatValue',15,struct.pack('<fB',1,0)),('everyFrame',1,b'\1')]:
        result['pname'].append(name); result['ptype'].append(typ); result['ppos'].append(len(result['bytes'])); result['psize'].append(len(data)); result['bytes'] += data
    return result

def apply(env):
    level = next(o.assets_file for o in env.objects if o.assets_file.name == 'level0')
    obj = level.objects[282]; raw=bytes(obj.get_raw_data()); f=fsmparse.parse(raw)
    assert f['go']==(0,33) and not any(s['name']==STATE for s in f['states'])
    fsmwrite.roundtrip_check(raw,f)
    reset = next(s for s in f['states'] if s['name']=='reset rotation and pos')['actions']
    rig = fsmparse.parse(bytes(level.objects[255].get_raw_data()))
    get = next(s for s in rig['states'] if s['name']=='track sphere')['actions']
    translate = None
    for source in env.objects:
        if source.type.name!='MonoBehaviour':continue
        data=bytes(source.get_raw_data())
        if b'HutongGames.PlayMaker.Actions.Translate' not in data:continue
        parsed=fsmparse.parse(data)
        for state in parsed.get('states',[]):
            a=state['actions']
            for i,name in enumerate(a['names']):
                if name.endswith('.Translate'):translate=(a,i);break
            if translate:break
        if translate:break
    assert translate
    def index(a,suffix):return next(i for i,n in enumerate(a['names']) if n.endswith(suffix))
    common=dict(x=nofloat(),y=nofloat(),z=nofloat(),space=struct.pack('<i',0),everyFrame=b'\1',lateUpdate=b'\1')
    specs=[(get,index(get,'.GetPosition'),dict(common,vector=vector('ModCameraPosition')),False),
           (reset,index(reset,'.SetPosition'),dict(common,vector=vector('ModCameraPosition')),True),
           (translate[0],translate[1],dict(common,vector=vector('ModCameraOffset'),perSecond=b'\0'),True),
           (reset,index(reset,'.SetRotation'),dict(common,quaternion=quaternion('ModQCamera'),vector=vector(''),xAngle=nofloat(),yAngle=nofloat(),zAngle=nofloat()),True)]
    state=copy.deepcopy(next(s for s in f['states'] if s['name']=='do nothing'))
    state['name']=STATE; state['transitions']=[]; state['actions']=combine(state['actions'],specs)
    states=f['states']+[state]; writer=fsmwrite.W()
    for s in states:fsmwrite.write_state(writer,s)
    pos=f['states'][0]['_pos']-4
    new=raw[:pos]+struct.pack('<i',len(states))+bytes(writer.b)+raw[f['_afterStates']:]
    for kind,name,value in [('v3','ModCameraPosition',[5.,10.5,-4.]),('v3','ModCameraOffset',list(OFFSET)),('quat','ModQCamera',list(ROTATION)),('float','ModCameraTick',0.)]:
        new=add_variable(new,kind,name,value)
    parsed=fsmparse.parse(new);assert '_err' not in parsed,parsed.get('_err');fsmwrite.roundtrip_check(new,parsed)
    obj.set_raw_data(new)
    print('Main Camera: native Sphere GetPosition + world SetPosition/Translate/SetRotation in LateUpdate, frame heartbeat')

if __name__=='__main__':
    if len(sys.argv)!=3:sys.exit(__doc__)
    env=UnityPy.load(sys.argv[1]);apply(env)
    Path(sys.argv[2]).write_bytes(env.file.save(packer='original'))
