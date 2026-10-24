"""Import the downloaded Mort V2 OBJ and its original textures into the skyline.
Requires Pillow only. Run: python tools/import_mort.py
Source/credit: tools/assets/mort/README.md. Keeps OBJ UVs (including repeated
hair UVs), packs body/tail/hair into one atlas, and faces the model toward -z.
"""
from pathlib import Path
import json
import math
from PIL import Image

ASSETS = Path(__file__).resolve().parent / 'assets' / 'mort'
SOURCE = ASSETS / 'v2'

def main():
    vertices, uvs, groups = [], [], {}
    material = None
    for line in (SOURCE / 'mort.obj').read_text().splitlines():
        fields = line.split()
        if not fields: continue
        if fields[0] == 'v': vertices.append(tuple(map(float, fields[1:4])))
        elif fields[0] == 'vt': uvs.append(tuple(map(float, fields[1:3])))
        elif fields[0] == 'usemtl': material = fields[1]; groups.setdefault(material, [])
        elif fields[0] == 'f':
            assert material is not None
            face = [tuple(int(x) for x in token.split('/')[:2]) for token in fields[1:]]
            assert all(v > 0 and t > 0 for v, t in face)
            groups[material].append(face)
    expected = {'mort_tex': 'mort.png', 'tail_tex': 'tail.png', 'hair_tex': 'hair.png'}
    assert set(groups) == set(expected), set(groups)
    atlas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    slots, cursor = {}, 4
    for material, filename in expected.items():
        image = Image.open(SOURCE / filename).convert('RGBA')
        coords = [uvs[t - 1] for face in groups[material] for _, t in face]
        u0 = math.floor(min(u for u, v in coords)); v0 = math.floor(min(v for u, v in coords))
        nx = math.ceil(max(u for u, v in coords) - u0); ny = math.ceil(max(v for u, v in coords) - v0)
        width, height = image.size; tw, th = width * nx, height * ny
        assert cursor + tw + 4 <= atlas.width and th + 8 <= atlas.height
        # One-pixel wrapped gutters protect bilinear sampling at UV seams.
        for iy in range(ny):
            for ix in range(nx): atlas.paste(image, (cursor + ix * width, 4 + iy * height))
        atlas.paste(atlas.crop((cursor + tw - 1, 4, cursor + tw, 4 + th)), (cursor - 1, 4))
        atlas.paste(atlas.crop((cursor, 4, cursor + 1, 4 + th)), (cursor + tw, 4))
        atlas.paste(atlas.crop((cursor - 1, 4 + th - 1, cursor + tw + 1, 4 + th)), (cursor - 1, 3))
        atlas.paste(atlas.crop((cursor - 1, 4, cursor + tw + 1, 5)), (cursor - 1, 4 + th))
        slots[material] = (cursor, 4, width, height, th, u0, v0)
        cursor += tw + 8
    ymin = min(p[1] for p in vertices); ymax = max(p[1] for p in vertices)
    scale = 180 / (ymax - ymin)
    # The OBJ is +y up and faces +z. A 180-degree yaw preserves winding.
    verts = [(-x * scale, (y - ymin) * scale, -z * scale) for x, y, z in vertices]
    result_v, result_uv, triangles, lookup = [], [], [], {}
    for material, faces in groups.items():
        x, y, width, height, th, u0, v0 = slots[material]
        for face in faces:
            indices = []
            for vi, ti in face:
                key = (vi, ti, material)
                if key not in lookup:
                    lookup[key] = len(result_v)
                    result_v.append(verts[vi - 1])
                    u, v = uvs[ti - 1]
                    # OBJ v=0 is at the bottom; PNG rows start at the top.
                    result_uv.append(((x + (u - u0) * width) / atlas.width,
                                      1 - (y + th - (v - v0) * height) / atlas.height))
                indices.append(lookup[key])
            for i in range(1, len(indices) - 1): triangles.append((indices[0], indices[i], indices[i + 1]))
    atlas.save(ASSETS / 'atlas.png')
    payload = {'vertices': result_v, 'uvs': result_uv, 'triangles': triangles}
    (ASSETS / 'mesh.json').write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    print(f'Mort V2: {len(result_v)} vertices, {len(triangles)} triangles, original RGBA texture atlas {atlas.size}, height 180')

if __name__ == '__main__': main()
