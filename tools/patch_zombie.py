"""Put Minecraft's zombie (tools/import_zombie.py) on the Aria Math skyline of a patched Unity scene.
Usage: patch_zombie.py INPUT-data.unity3d OUTPUT-data.unity3d      (UnityPy + Pillow)
Rewrites the 'buildingsZombie' mesh with one zombie per used pillar slot and gives its renderer a material of
its own: the game's Unlit/Texture shader with the zombie atlas (the zombies used to share the green-outline
ground material). patch_buildings.py calls the same helpers when building the music prefabs from scratch.
"""
from pathlib import Path
import collections
import copy
import math
import sys
import UnityPy
from PIL import Image
import figures
from patch_mort import pillar_points, to_local, write_mesh

UNLIT_TEXTURE = 67          # the game's Unlit/Texture shader
BASE_TEXTURE, BASE_MATERIAL = 27, 3
HEIGHT = 170.0              # units tall (Mort is 180): a horde at near-human scale beside the lane, not towers
SCALE = HEIGHT / 32.0       # units per skin pixel
EVERY = 2                   # every other pillar slot in a row
C = math.sqrt(.5)

def zombie_geometry(points, every=EVERY, scale=SCALE):
    """A zombie in every `every`-th pillar slot of each row, standing beside the lane at the same distance
    and height rule as the Mort crowd (patch_mort.mort_geometry): feet on a floor that keeps the head in
    view above the 45-degree lane, 200 units from the lane's centre on both sides, facing the approaching
    ball and turned 15 degrees inward so the raised arms reach toward the track."""
    fig = figures.zombie('ccw', u=scale)
    height = max(v[1] for v in fig.v)
    rows = collections.defaultdict(list)
    for p in points: rows[round(p[2] / 10)].append(p)
    chosen = [p for r in sorted(rows) for k, p in enumerate(sorted(rows[r])) if k % every == 0]
    verts, uvs, tris = [], [], []
    for cx, top, cz in chosen:
        head_height = max(80, min(150, top + cz))
        floor_y = -cz + (head_height - height) / C
        side = 1 if cx > 5 else -1
        cx = 5 + side * 200
        yaw = math.radians(side * 15); cy, sy = math.cos(yaw), math.sin(yaw)
        base = len(verts)
        for x, y, z in fig.v:
            x, z = x * cy + z * sy, -x * sy + z * cy
            verts.append(to_local((x + cx, (y - z) * C + floor_y, (y + z) * C + cz)))
        uvs.extend(fig.uv)
        tris.extend(tuple(i + base for i in t) for t in fig.t)
    assert len(verts) < 65535, len(verts)
    print('Zombie horde: %d zombies, %d vertices, %d triangles (every %d slots)' % (len(chosen), len(verts), len(tris), every))
    return verts, uvs, tris

def zombie_material(sa):
    def duplicate(pid, nid):
        obj = copy.copy(sa.objects[pid]); obj.path_id = nid; obj.data = None; sa.objects[nid] = obj
        return obj
    existing = next((o for o in sa.objects.values() if o.type.name == 'Material' and o.read().m_Name == 'ZombieSkin'), None)
    if existing:
        mat = existing.read(); material_id = existing.path_id
        texture_id = next(env.m_Texture.m_PathID for name, env in mat.m_SavedProperties.m_TexEnvs if name == '_MainTex')
        tex = sa.objects[texture_id].read()
    else:
        texture_id = max(sa.objects) + 1; tex = duplicate(BASE_TEXTURE, texture_id).read()
        material_id = max(sa.objects) + 1; mat = duplicate(BASE_MATERIAL, material_id).read()
    tex.m_Name = 'ZombieAtlas'
    tex.set_image(Image.open(Path(__file__).resolve().parent / 'assets/zombie/atlas.png'), target_format=4, mipmap_count=1)
    tex.m_TextureSettings.m_FilterMode = 1          # bilinear over an 8x nearest-upscaled skin: sharp pixels, no shimmer
    tex.save()
    mat.m_Name = 'ZombieSkin'
    mat.m_Shader.m_FileID = 0; mat.m_Shader.m_PathID = UNLIT_TEXTURE
    for name, env in mat.m_SavedProperties.m_TexEnvs:
        if name == '_MainTex':
            env.m_Texture.m_FileID = 0; env.m_Texture.m_PathID = texture_id
            env.m_Scale.x = env.m_Scale.y = 1.0; env.m_Offset.x = env.m_Offset.y = 0.0
    mat.save()
    return material_id

def configure_renderer(sa):
    material = zombie_material(sa)
    go = next(o.path_id for o in sa.objects.values() if o.type.name == 'GameObject' and o.read().m_Name == 'buildingsZombie')
    for obj in list(sa.objects.values()):
        if obj.type.name != 'MeshRenderer': continue
        r = obj.read()
        if r.m_GameObject.m_PathID == go:
            r.m_Materials[0].m_FileID = 0; r.m_Materials[0].m_PathID = material; r.save()
    return material

def apply(env):
    sa = next(o.assets_file for o in env.objects if o.assets_file.name.endswith('sharedassets0.assets'))
    target = next(o for o in sa.objects.values() if o.type.name == 'Mesh' and o.read().m_Name == 'buildingsZombie')
    write_mesh(target, *zombie_geometry(pillar_points(sa)))
    configure_renderer(sa)

if __name__ == '__main__':
    if len(sys.argv) != 3: sys.exit(__doc__)
    env = UnityPy.load(sys.argv[1]); apply(env)
    Path(sys.argv[2]).write_bytes(env.file.save(packer='original'))
    print('Wrote', sys.argv[2])
