"""Replace the existing Mort skyline mesh/material in a patched Unity scene.
Usage: patch_mort.py INPUT-data.unity3d OUTPUT-data.unity3d
Requires UnityPy and Pillow. The source OBJ/texture conversion is tools/import_mort.py.
Also exports helpers used by patch_buildings.py when creating a scene from scratch.
"""
from pathlib import Path
import collections
import copy
import math
import struct
import sys
import UnityPy
from PIL import Image
import figures
from mort_shader import cutout_shader

C = math.sqrt(.5)
def to_world(p):
    x, y, z = p
    return x, (y + z) * C, (-y + z) * C

def to_local(p):
    x, y, z = p
    return x, (y - z) * C, (y + z) * C

def pillar_points(sa):
    mesh = next(o.read_typetree() for o in sa.objects.values() if o.type.name == 'Mesh' and o.read().m_Name == 'Buildings')
    data = bytes(mesh['m_VertexData']['m_DataSize'])
    assert len(data) == mesh['m_VertexData']['m_VertexCount'] * 20
    positions = [to_world(struct.unpack_from('<3f', data, i * 20)) for i in range(mesh['m_VertexData']['m_VertexCount'])]
    # Original pillars have disjoint x/z footprints. Their duplicated face
    # vertices share the same two x coordinates and z coordinates.
    triangles = struct.unpack('<%dH' % (len(mesh['m_IndexBuffer']) // 2), bytes(mesh['m_IndexBuffer']))
    parent = list(range(len(positions)))
    def find(a):
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for i in range(0, len(triangles), 3):
        a,b,c=triangles[i:i+3]; parent[find(a)] = find(b); parent[find(b)] = find(c)
    bypos = collections.defaultdict(list)
    for i, p in enumerate(positions): bypos[tuple(round(c, 1) for c in p)].append(i)
    for ids in bypos.values():
        for i in ids[1:]: parent[find(ids[0])] = find(i)
    groups = collections.defaultdict(list)
    for i,p in enumerate(positions): groups[find(i)].append(p)
    points = []
    for group in groups.values():
        if len(group) < 8: continue
        xs,ys,zs = zip(*group)
        points.append(((min(xs)+max(xs))/2, max(ys), (min(zs)+max(zs))/2))
    return sorted(points, key=lambda p:(p[2],p[0]))

def mort_geometry(points):
    # Mort's cutout material is double-sided for the source's fur cards.
    fig = figures.mort('cw')
    rows = collections.defaultdict(list)
    for p in points: rows[round(p[2]/10)].append(p)
    # Keep a complete downloaded model in every slot we use while staying below
    # Unity's 16-bit mesh-index limit on both WebGL 1 and 2.
    every = 5  # preserve the 29-figure layout / 87 figures across three instances
    while True:
        chosen = [p for r in sorted(rows) for k,p in enumerate(sorted(rows[r])) if k % every == 0]
        if len(chosen) * len(fig.v) < 65535: break
        every += 1
    verts,uvs,tris = [],[],[]
    height = max(p[1] for p in fig.v)
    for cx,top,cz in chosen:
        # The old pillars have arbitrary skyscraper heights. Keep the face
        # visible above the local 45-degree lane instead of filling the view
        # with a torso or putting the head entirely above the camera.
        head_height = max(80, min(150, top + cz))
        floor_y = -cz + (head_height - height) / C
        cx = math.copysign(max(abs(cx), 240), cx)  # keep solid bodies well clear of the lane
        base=len(verts)
        # Stand perpendicular to the 45-degree lane, with the tail following
        # the lane behind Mort rather than forming a wall above his head.
        verts.extend(to_local((x+cx, (y-z)*C+floor_y, (y+z)*C+cz)) for x,y,z in fig.v)
        uvs.extend(fig.uv)
        tris.extend(tuple(i+base for i in t) for t in fig.t)
    print(f'Mort crowd: {len(chosen)} figures, {len(verts)} vertices, {len(tris)} triangles (every {every} slots)')
    return verts,uvs,tris

def write_mesh(obj, verts, uvs, tris):
    mesh = obj.read()
    mesh.m_VertexData.m_VertexCount = len(verts)
    mesh.m_VertexData.m_DataSize = b''.join(struct.pack('<5f',*p,*uv) for p,uv in zip(verts,uvs))
    mesh.m_IndexBuffer = b''.join(struct.pack('<3H',*t) for t in tris)
    sub = mesh.m_SubMeshes[0]
    sub.firstByte=0; sub.firstVertex=0; sub.indexCount=len(tris)*3; sub.vertexCount=len(verts)
    axes = list(zip(*verts))
    for box in (sub.localAABB, mesh.m_LocalAABB):
        for axis, values in zip(('x','y','z'),axes):
            setattr(box.m_Center,axis,(min(values)+max(values))/2)
            setattr(box.m_Extent,axis,(max(values)-min(values))/2)
    mesh.m_BakedConvexCollisionMesh=b''; mesh.m_BakedTriangleCollisionMesh=b''
    mesh.save()

def mort_material(sa):
    existing = next((o for o in sa.objects.values() if o.type.name=='Material' and o.read().m_Name=='MortPalette'),None)
    shader_id = cutout_shader(sa)
    def duplicate(pid,nid):
        obj=copy.copy(sa.objects[pid]); obj.path_id=nid; obj.data=None; sa.objects[nid]=obj
        return obj
    if existing:
        mat = existing.read(); material_id = existing.path_id
        texture_id = next(env.m_Texture.m_PathID for name,env in mat.m_SavedProperties.m_TexEnvs if name=='_MainTex')
        tex = sa.objects[texture_id].read()
    else:
        texture_id = max(sa.objects)+1
        tex = duplicate(27,texture_id).read()
        material_id = max(sa.objects)+1
        mat = duplicate(3,material_id).read()
    tex.m_Name='MortV2Atlas'
    tex.set_image(Image.open(Path(__file__).resolve().parent/'assets/mort/atlas.png'), target_format=4, mipmap_count=1)
    tex.m_TextureSettings.m_FilterMode=1
    tex.save()
    mat.m_Name='MortPalette'
    mat.m_Shader.m_FileID=0; mat.m_Shader.m_PathID=shader_id
    for name,env in mat.m_SavedProperties.m_TexEnvs:
        if name=='_MainTex': env.m_Texture.m_FileID=0; env.m_Texture.m_PathID=texture_id
    mat.save()
    return material_id

def apply(env):
    sa=next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
    target=next(o for o in sa.objects.values() if o.type.name=='Mesh' and o.read().m_Name=='buildingsMort')
    write_mesh(target,*mort_geometry(pillar_points(sa)))
    material = configure_renderer(sa)
    configure_crowd(sa, material)
    return target.path_id

def configure_renderer(sa):
    material=mort_material(sa)
    go=next(o.path_id for o in sa.objects.values() if o.type.name=='GameObject' and o.read().m_Name=='buildingsMort')
    for obj in list(sa.objects.values()):
        if obj.type.name!='MeshRenderer': continue
        renderer=obj.read()
        if renderer.m_GameObject.m_PathID==go:
            renderer.m_Materials[0].m_FileID=0; renderer.m_Materials[0].m_PathID=material; renderer.save()
    return material

def configure_crowd(sa, material=None):
    """Three staggered instances of the mesh: 87 figures without 32-bit indices.
    Children inherit the pooled root's enable/despawn lifetime; only the root
    keeps a pool FSM. Reusing the same mesh also avoids tripling download size.
    """
    if material is None: material = mort_material(sa)
    go = next(o for o in sa.objects.values() if o.type.name == 'GameObject' and o.read().m_Name == 'buildingsMort')
    root = go.read_typetree()
    parts = {sa.objects[c['component']['m_PathID']].type.name: c['component']['m_PathID'] for c in root['m_Component']}
    transform = sa.objects[parts['Transform']].read_typetree()
    existing = {o.read().m_Name for o in sa.objects.values() if o.type.name == 'GameObject'}
    def ptr(pid): return {'m_FileID': 0, 'm_PathID': pid}
    def clone(source, pid, data):
        obj = copy.copy(sa.objects[source]); obj.path_id = pid; obj.data = None
        sa.objects[pid] = obj; obj.save_typetree(data)
    for number, advance in [(1, 40), (2, 80)]:
        name = 'MortCrowd' + str(number)
        if name in existing: continue
        base = max(sa.objects) + 1
        child = copy.deepcopy(root); child['m_Name'] = name
        child['m_Component'] = [{'component': ptr(base + i)} for i in (1, 2, 3)]
        clone(go.path_id, base, child)
        tr = copy.deepcopy(transform)
        tr['m_GameObject'] = ptr(base); tr['m_Father'] = ptr(parts['Transform']); tr['m_Children'] = []
        tr['m_LocalPosition'] = {'x': 0., 'y': -advance / C, 'z': 0.}
        tr['m_LocalRotation'] = {'x': 0., 'y': 0., 'z': 0., 'w': 1.}
        clone(parts['Transform'], base + 1, tr)
        for key, offset in [('MeshFilter', 2), ('MeshRenderer', 3)]:
            data = sa.objects[parts[key]].read_typetree()
            data['m_GameObject'] = ptr(base)
            # The renderer's newly assigned palette is in saved data until
            # the bundle is reloaded; use the material explicitly here.
            if key == 'MeshRenderer':
                data['m_Materials'][0] = ptr(material)
            clone(parts[key], base + offset, data)
        transform['m_Children'].append(ptr(base + 1))
    sa.objects[parts['Transform']].save_typetree(transform)
    print('Mort crowd: 3 staggered mesh instances, 87 figures per chunk')

if __name__=='__main__':
    if len(sys.argv)!=3: sys.exit(__doc__)
    env=UnityPy.load(sys.argv[1]); apply(env)
    Path(sys.argv[2]).write_bytes(env.file.save(packer='original'))
    print('Wrote',sys.argv[2])
