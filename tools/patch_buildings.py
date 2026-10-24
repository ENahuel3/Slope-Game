"""Background pillars as figures: the skyline prefab ('buildings', sharedassets0 GameObject 104, one mesh of 145
pillars 60x60x3000 beside the track) gets two siblings whose mesh puts a figure on every pillar: a Minecraft-style
zombie and a downloaded Mort model (tools/assets/mort/README.md). Zombies use the neon-outline material;
Mort uses its source colors and baked shading, scaled/spaced for clear faces
and an unobstructed lane. Zombies sit at the pillar tops. The SpawnBuildingsPos FSM (level0) spawns its chunks from a new FSM
GameObject variable ModBuilding instead of the fixed prefab; ModBuildingFlat / ModBuildingZombie / ModBuildingMort
hold the three prefabs so the mod can read their object pointers from the heap and write the one matching the
music into ModBuilding (TemplateData/mod.js syncBuilding).
usage: patch_buildings.py <in data.unity3d> <out data.unity3d>"""
import sys, os, struct, math, copy, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import UnityPy, fsmparse, fsmwrite, figures
from patch_mort import mort_geometry, configure_renderer
src, dst = sys.argv[1], sys.argv[2]
BUILDINGS = 104; MESH = 45
env = UnityPy.load(src)
sa = next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
assert gos[(id(sa), BUILDINGS)] == 'buildings'
# ---------------------------------------------------------------- the pillars, in the prefab's world frame
d = sa.objects[MESH].read_typetree(); vd = d['m_VertexData']; data = bytes(vd['m_DataSize']); n = vd['m_VertexCount']
assert len(data) == n * 20 and [c['dimension'] for c in vd['m_Channels'][:4]] == [3, 0, 0, 2], 'unexpected vertex layout'
pos = [struct.unpack_from('<3f', data, i * 20) for i in range(n)]
tri = struct.unpack('<%dH' % (len(d['m_IndexBuffer']) // 2), bytes(d['m_IndexBuffer']))
par = list(range(n))
def find(a):
    while par[a] != a: par[a] = par[par[a]]; a = par[a]
    return a
for t in range(0, len(tri), 3): par[find(tri[t])] = find(tri[t + 1]); par[find(tri[t + 1])] = find(tri[t + 2])
bypos = collections.defaultdict(list)
for i, p in enumerate(pos): bypos[tuple(round(c, 1) for c in p)].append(i)
for ids in bypos.values():
    for i in ids[1:]: par[find(ids[0])] = find(i)
C, SN = math.cos(math.radians(45)), math.sin(math.radians(45))
def to_world(p): x, y, z = p; return (x, y * C + z * SN, -y * SN + z * C)        # the prefab is rotated -45 degrees about x at spawn
def to_local(p): x, y, z = p; return (x, y * C - z * SN, y * SN + z * C)
comps = collections.defaultdict(list)
for i in range(n): comps[find(i)].append(i)
pillars = []
for ids in comps.values():
    W = [to_world(pos[i]) for i in ids]
    if len(ids) < 8: continue
    xs, ys, zs = [w[0] for w in W], [w[1] for w in W], [w[2] for w in W]
    pillars.append(((min(xs) + max(xs)) / 2, max(ys), (min(zs) + max(zs)) / 2))
pillars.sort(key=lambda p: (p[2], p[0]))
print('pillars:', len(pillars))
# ---------------------------------------------------------------- figure meshes
def skyline(fig, every=1):
    """one figure per pillar (every `every`-th slot of each row for wide figures), feet 'height' below the pillar's
    top, facing -z (the ball comes from -z)"""
    ys = [v[1] for v in fig.v]; h = max(ys) - min(ys)
    rows = collections.defaultdict(list)
    for p in pillars: rows[round(p[2] / 10)].append(p)
    chosen = [p for r in sorted(rows) for k, p in enumerate(sorted(rows[r])) if k % every == 0]
    verts, uvs, tris = [], [], []
    for (cx, top, cz) in chosen:
        base = len(verts)
        verts += [to_local((v[0] + cx, v[1] - min(ys) + top - h, v[2] + cz)) for v in fig.v]
        uvs += fig.uv; tris += [(a + base, b + base, c + base) for a, b, c in fig.t]
    assert len(verts) < 65535, len(verts)
    return verts, uvs, tris
def dup(pid, nid, patch=None):
    o = sa.objects[pid]; m = copy.copy(o); m.path_id = nid; m.data = None; sa.objects[nid] = m
    if patch: patch(m)
    return m
def make_mesh(nid, name, fig, every=1, geometry=None):
    verts, uvs, tris = geometry if geometry is not None else skyline(fig, every)
    vdata = b''.join(struct.pack('<5f', *verts[i], *uvs[i]) for i in range(len(verts)))
    idata = b''.join(struct.pack('<3H', *t) for t in tris)
    xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
    def patch(m):
        me = m.read(); me.m_Name = name
        me.m_VertexData.m_VertexCount = len(verts); me.m_VertexData.m_DataSize = vdata; me.m_IndexBuffer = idata
        sm = me.m_SubMeshes[0]; sm.indexCount = len(tris) * 3; sm.vertexCount = len(verts); sm.firstByte = 0; sm.firstVertex = 0
        for box in (sm.localAABB, me.m_LocalAABB):
            box.m_Center.x, box.m_Center.y, box.m_Center.z = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
            box.m_Extent.x, box.m_Extent.y, box.m_Extent.z = (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2, (max(zs) - min(zs)) / 2
        me.m_BakedConvexCollisionMesh = b''; me.m_BakedTriangleCollisionMesh = b''
        me.save()
    dup(MESH, nid, patch); return len(verts), len(tris)
def comp_ids(go_id):
    go = sa.objects[go_id].read(); return [(c.component if hasattr(c, 'component') else c).m_PathID for c in go.m_Components]
def make_prefab(base, name, mesh_id):
    cids = comp_ids(BUILDINGS); newid = {cid: base + 1 + i for i, cid in enumerate(cids)}; GO = base
    def go_patch(m):
        g = m.read(); g.m_Name = name
        for c in g.m_Components:
            pp = c.component if hasattr(c, 'component') else c; pp.m_PathID = newid[pp.m_PathID]
        g.save()
    dup(BUILDINGS, GO, go_patch)
    for cid in cids:
        kind = sa.objects[cid].type.name
        if kind == 'MonoBehaviour':
            raw = bytes(sa.objects[cid].get_raw_data()); m = dup(cid, newid[cid]); m.data = raw[:4] + struct.pack('<q', GO) + raw[12:]
        elif kind == 'MeshFilter':
            def mp(m):
                x = m.read(); x.m_GameObject.m_PathID = GO; x.m_Mesh.m_PathID = mesh_id; x.m_Mesh.m_FileID = 0; x.save()
            dup(cid, newid[cid], mp)
        else:
            def cp(m):
                x = m.read(); x.m_GameObject.m_PathID = GO; x.m_Children = [] if kind == 'Transform' else getattr(x, 'm_Children', None); x.save()
            dup(cid, newid[cid], cp)
    return GO
BASE = (max(sa.objects) // 100 + 1) * 100
GO_Z = BASE; GO_M = BASE + 20
nz = make_mesh(GO_Z + 9, 'buildingsZombie', figures.zombie('ccw'), every=2)   # every other slot: the figures are wider than a pillar
nm = make_mesh(GO_M + 9, 'buildingsMort', figures.mort('ccw'), geometry=mort_geometry(pillars))
make_prefab(GO_Z, 'buildingsZombie', GO_Z + 9); make_prefab(GO_M, 'buildingsMort', GO_M + 9)
print('prefabs: buildingsZombie go#%d (%d verts, %d tris), buildingsMort go#%d (%d verts, %d tris)' % (GO_Z, nz[0], nz[1], GO_M, nm[0], nm[1]))
# ---------------------------------------------------------------- the SpawnBuildingsPos FSM: prefab from the ModBuilding variable
def ustr(s): b = s.encode(); return struct.pack('<i', len(b)) + b + b'\0' * ((4 - len(b) % 4) % 4)
def add_go_variables(raw, entries):
    f = fsmparse.parse(raw); v = f['variables']; assert not any(x['name'] in dict(entries) for x in v['gameObject'])
    p0, end = v['_goPos'], v['_objPos']
    blob = b''.join(struct.pack('<i', 0) + ustr(nm) + ustr('') + struct.pack('<ii', 0, 0) + struct.pack('<iq', 2, pid) for nm, pid in entries)
    return raw[:p0] + struct.pack('<i', len(v['gameObject']) + len(entries)) + raw[p0 + 4:end] + blob + raw[end:]
done = False
for o in list(env.objects):
    if o.type.name != "MonoBehaviour": continue
    raw = bytes(o.get_raw_data())
    if scripts.get(struct.unpack_from('<q', raw, 20)[0]) != 'PlayMakerFSM': continue
    if gos.get((id(o.assets_file), struct.unpack_from('<q', raw, 4)[0])) != 'SpawnBuildingsPos': continue
    f = fsmparse.parse(raw); assert '_err' not in f, f.get('_err')
    assert not any(x['name'] == 'ModBuilding' for x in f['variables']['gameObject']), 'already patched'
    spawns = 0
    for st in f['states']:
        a = st['actions']
        for i in range(len(a['names'])):
            if not a['names'][i].endswith('.PmtSpawn'): continue
            gk = next((k for k in range(a['start'][i], (a['start'][i + 1] if i + 1 < len(a['names']) else len(a['pname']))) if a['pname'][k] == 'gameObject'), None)
            if gk is None or a['ptype'][gk] != 19: continue
            e = a['gameObject'][a['ppos'][gk]]
            if not e['use'] and e['ptr'] == (2, BUILDINGS): e['use'] = True; e['name'] = 'ModBuilding'; spawns += 1
    assert spawns == 2, spawns
    w = fsmwrite.W()
    for st in f['states']: fsmwrite.write_state(w, st)
    new = raw[:f['states'][0]['_pos']] + bytes(w.b) + raw[f['_afterStates']:]
    new = add_go_variables(new, [('ModBuilding', BUILDINGS), ('ModBuildingFlat', BUILDINGS), ('ModBuildingZombie', GO_Z), ('ModBuildingMort', GO_M)])
    g2 = fsmparse.parse(new); assert '_err' not in g2, g2.get('_err'); assert [x['name'] for x in g2['variables']['gameObject']][-4:] == ['ModBuilding', 'ModBuildingFlat', 'ModBuildingZombie', 'ModBuildingMort']
    o.set_raw_data(new); done = True; print('SpawnBuildingsPos: %d spawns take the ModBuilding variable; 4 GameObject variables added' % spawns)
assert done
# UnityPy reads objects from their original reader until a saved bundle is
# reloaded; make the newly cloned Mort prefab visible before assigning color.
env = UnityPy.load(env.file.save(packer="original"))
sa = next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
configure_renderer(sa)
out = env.file.save(packer="original"); open(dst, 'wb').write(out); print('wrote', dst, len(out))
