"""Skyline chunks follow the ball, not the spawner: the SpawnBuildingsPos FSM (level0) places each new chunk at the
x of SpawnPos, the track spawner's point. With a high render distance (TemplateData/mod.js stepAhead) the spawner is
laps ahead at the far end of the built track, so the chunks were centred on that far part and stood in the lane
where the ball actually is. 'Spawn More Buildings' now reads the x of the ball (Sphere) instead.
usage: patch_buildings_follow.py <in data.unity3d> <out data.unity3d>      (UnityPy)"""
import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import UnityPy, fsmparse, fsmwrite
src, dst = sys.argv[1], sys.argv[2]
env = UnityPy.load(src)
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
done = 0
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytes(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    if gos.get((id(o.assets_file), struct.unpack_from('<q', raw, 4)[0])) != 'SpawnBuildingsPos': continue
    sf = id(o.assets_file)
    spawn_pos = next(pid for (fid, pid), nm in gos.items() if fid == sf and nm == 'SpawnPos')
    sphere = next(pid for (fid, pid), nm in gos.items() if fid == sf and nm == 'Sphere')
    f = fsmparse.parse(raw); assert '_err' not in f, f.get('_err')
    st = next(s for s in f['states'] if s['name'] == 'Spawn More Buildings'); a = st['actions']
    for i in range(len(a['names'])):
        if not a['names'][i].endswith('.GetPosition'): continue
        end = a['start'][i + 1] if i + 1 < len(a['names']) else len(a['pname'])
        for k in range(a['start'][i], end):
            if a['pname'][k] != 'gameObject' or a['ptype'][k] != 20: continue
            e = a['ownerDefault'][a['ppos'][k]]
            assert e['opt'] == 1 and not e['go']['use'], e
            if e['go']['ptr'] == (0, sphere): print('already patched'); sys.exit(0)
            assert e['go']['ptr'] == (0, spawn_pos), e['go']['ptr']
            e['go']['ptr'] = (0, sphere); done += 1
    assert done == 1, done
    w = fsmwrite.W()
    for s in f['states']: fsmwrite.write_state(w, s)
    new = raw[:f['states'][0]['_pos']] + bytes(w.b) + raw[f['_afterStates']:]
    g = fsmparse.parse(new); assert '_err' not in g, g.get('_err')
    o.set_raw_data(new)
    print('SpawnBuildingsPos: Spawn More Buildings takes x from Sphere #%d (was SpawnPos #%d)' % (sphere, spawn_pos))
assert done == 1, 'SpawnBuildingsPos FSM not found'
out = env.file.save(packer="original"); open(dst, 'wb').write(out); print('wrote', dst, len(out))
