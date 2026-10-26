"""Gandalf beside the lane for the Epic Sax Gandalf track: a fourth skyline prefab, 'buildingsGandalf', whose mesh
is one upright picture card per pillar slot (every other slot of each row, like the zombie horde), textured with a
cut-out picture of Gandalf (tools/assets/gandalf/gandalf.png, alpha = transparent background) through its own
material on the Mort cutout shader (alpha below 0.25 is discarded, both faces drawn). The card stands on the same
floor rule as the other figures (head in view above the 45-degree lane), 200 units from the lane's centre on both
sides, facing the approaching ball and turned 15 degrees inward. The SpawnBuildingsPos FSM gets one more
GameObject variable, ModBuildingGandalf, holding the prefab; TemplateData/mod.js writes it into ModBuilding while
the Epic Sax Gandalf track plays (syncBuilding).
usage: patch_gandalf.py <in data.unity3d> <out data.unity3d>      (UnityPy + Pillow; after patch_buildings.py)"""
import sys, os, struct, math, copy, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import UnityPy, fsmparse, fsmwrite, figures
from PIL import Image
from patch_mort import pillar_points, to_local, write_mesh, cutout_shader
src, dst = sys.argv[1], sys.argv[2]
PICTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets', 'gandalf', 'gandalf.png')
HEIGHT = 180.0              # units tall, like Mort; the card's width follows the picture
EVERY = 2                   # every other pillar slot of each row
BASE_TEXTURE, BASE_MATERIAL = 27, 3
C = math.sqrt(.5)
env = UnityPy.load(src)
sa = next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
gos = {(id(o.assets_file), o.path_id): o.read().m_Name for o in env.objects if o.type.name == "GameObject"}
BUILDINGS = next(pid for (fid, pid), nm in gos.items() if fid == id(sa) and nm == 'buildings')
assert not any(nm == 'buildingsGandalf' for nm in gos.values()), 'already patched'

# ---------------------------------------------------------------- the picture
img = Image.open(PICTURE).convert('RGBA')
bbox = img.getbbox(); img = img.crop(bbox)                     # trim transparent margins so the card is the figure
MAX_H = 420                                                     # pixels of height for a 180-unit card seen from the lane; RGBA32 stays small
if img.size[1] > MAX_H: img = img.resize((round(img.size[0] * MAX_H / img.size[1]), MAX_H), Image.LANCZOS)
w, h = img.size; aspect = w / h
pot = lambda n: 1 << max(5, math.ceil(math.log2(n)))
aw, ah = pot(w), pot(h)                                         # the smallest power-of-two atlas holding the picture top-left
atlas = Image.new('RGBA', (aw, ah), (0, 0, 0, 0)); atlas.paste(img, (0, 0))
u1, v1 = w / aw, h / ah
print('picture: %dx%d (aspect %.3f) in a %dx%d atlas' % (w, h, aspect, aw, ah))

# ---------------------------------------------------------------- the cards, in the pillar slots
def card_geometry(points, every=EVERY):
    rows = collections.defaultdict(list)
    for p in points: rows[round(p[2] / 10)].append(p)
    chosen = [p for r in sorted(rows) for k, p in enumerate(sorted(rows[r])) if k % every == 0]
    width = HEIGHT * aspect
    verts, uvs, tris = [], [], []
    for cx, top, cz in chosen:
        head_height = max(80, min(150, top + cz))
        floor_y = -cz + (head_height - HEIGHT) / C
        side = 1 if cx > 5 else -1
        cx = 5 + side * 200
        yaw = math.radians(side * 15); cy, sy = math.cos(yaw), math.sin(yaw)
        base = len(verts)
        # an upright card in the figure frame (+y up, facing -z), bottom centre at the origin; Unity's v runs bottom-up
        for (x, y), uv in (((-width / 2, 0), (0, 1 - v1)), ((width / 2, 0), (u1, 1 - v1)), ((width / 2, HEIGHT), (u1, 1)), ((-width / 2, HEIGHT), (0, 1))):
            z = 0.0
            x, z = x * cy + z * sy, -x * sy + z * cy
            verts.append(to_local((x + cx, (y - z) * C + floor_y, (y + z) * C + cz))); uvs.append(uv)
        tris += [(base, base + 2, base + 1), (base, base + 3, base + 2)]    # cw from the front; the cutout shader draws both faces
    print('Gandalf cards: %d, every %d slots' % (len(chosen), every))
    return verts, uvs, tris

# ---------------------------------------------------------------- objects: mesh, texture, material, prefab
def dup(pid, nid, patch=None):
    o = sa.objects[pid]; m = copy.copy(o); m.path_id = nid; m.data = None; sa.objects[nid] = m
    if patch: patch(m)
    return m
BASE = (max(sa.objects) // 100 + 1) * 100
GO = BASE; MESH_ID = BASE + 9; TEX_ID = BASE + 10; MAT_ID = BASE + 11
zombie_mesh = next(o.path_id for o in sa.objects.values() if o.type.name == 'Mesh' and o.read().m_Name == 'buildingsZombie')
dup(zombie_mesh, MESH_ID)
m = sa.objects[MESH_ID]; me = m.read(); me.m_Name = 'buildingsGandalf'; me.save()
write_mesh(sa.objects[MESH_ID], *card_geometry(pillar_points(sa)))
tex = dup(BASE_TEXTURE, TEX_ID).read(); tex.m_Name = 'GandalfCard'
tex.set_image(atlas, target_format=4, mipmap_count=1); tex.m_TextureSettings.m_FilterMode = 1; tex.save()
mat = dup(BASE_MATERIAL, MAT_ID).read(); mat.m_Name = 'GandalfCard'
mat.m_Shader.m_FileID = 0; mat.m_Shader.m_PathID = cutout_shader(sa)
for name, te in mat.m_SavedProperties.m_TexEnvs:
    if name == '_MainTex': te.m_Texture.m_FileID = 0; te.m_Texture.m_PathID = TEX_ID; te.m_Scale.x = te.m_Scale.y = 1.0; te.m_Offset.x = te.m_Offset.y = 0.0
mat.save()
def comp_ids(go_id):
    go = sa.objects[go_id].read(); return [(c.component if hasattr(c, 'component') else c).m_PathID for c in go.m_Components]
cids = comp_ids(BUILDINGS); newid = {cid: GO + 1 + i for i, cid in enumerate(cids)}
def go_patch(mm):
    g = mm.read(); g.m_Name = 'buildingsGandalf'
    for c in g.m_Components:
        pp = c.component if hasattr(c, 'component') else c; pp.m_PathID = newid[pp.m_PathID]
    g.save()
dup(BUILDINGS, GO, go_patch)
for cid in cids:
    kind = sa.objects[cid].type.name
    if kind == 'MonoBehaviour':
        raw = bytes(sa.objects[cid].get_raw_data()); mm = dup(cid, newid[cid]); mm.data = raw[:4] + struct.pack('<q', GO) + raw[12:]
    elif kind == 'MeshFilter':
        def mp(mm):
            x = mm.read(); x.m_GameObject.m_PathID = GO; x.m_Mesh.m_PathID = MESH_ID; x.m_Mesh.m_FileID = 0; x.save()
        dup(cid, newid[cid], mp)
    elif kind == 'MeshRenderer':
        def rp(mm):
            x = mm.read(); x.m_GameObject.m_PathID = GO; x.m_Materials[0].m_FileID = 0; x.m_Materials[0].m_PathID = MAT_ID; x.save()
        dup(cid, newid[cid], rp)
    else:
        def cp(mm):
            x = mm.read(); x.m_GameObject.m_PathID = GO; x.m_Children = [] if kind == 'Transform' else getattr(x, 'm_Children', None); x.save()
        dup(cid, newid[cid], cp)
print('prefab buildingsGandalf go#%d mesh#%d texture#%d material#%d' % (GO, MESH_ID, TEX_ID, MAT_ID))

# ---------------------------------------------------------------- the FSM variable
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
    assert any(x['name'] == 'ModBuilding' for x in f['variables']['gameObject']), 'run patch_buildings.py first'
    new = add_go_variables(raw, [('ModBuildingGandalf', GO)])
    g2 = fsmparse.parse(new); assert '_err' not in g2, g2.get('_err'); assert g2['variables']['gameObject'][-1]['name'] == 'ModBuildingGandalf'
    o.set_raw_data(new); done = True
assert done, 'SpawnBuildingsPos FSM not found'
data = env.file.save(packer='original'); open(dst, 'wb').write(data); print('wrote', dst, len(data))
print('wrote', dst)
