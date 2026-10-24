"""Convert Atherin's Mort GLB into the compact mesh/palette used by figures.py.
Requires trimesh, numpy, Pillow. Run from any directory; source/outputs live in tools/assets/mort.
The source uses flat material colors, so its materials fit in one shaded palette
and the crowd needs only one draw call. Coordinates: +y up, face toward -z.
"""
from pathlib import Path
import json
import numpy as np
import trimesh
from PIL import Image

ASSETS = Path(__file__).resolve().parent / 'assets' / 'mort'

def main():
    scene = trimesh.load(ASSETS / 'source.glb', force='scene')
    colors, verts, faces, rows, lookup = [], [], [], [], {}
    for name in sorted(scene.graph.nodes_geometry):
        transform, geometry = scene.graph[name]
        mesh = scene.geometry[geometry]
        material = getattr(mesh.visual, 'material', None)
        color = tuple(int(c) for c in getattr(material, 'baseColorFactor', (255, 255, 255, 255))[:3])
        if color not in colors: colors.append(color)
        row = colors.index(color)
        indices = []
        for point in trimesh.transform_points(mesh.vertices, transform):
            key = tuple(np.round(point, 8)) + (row,)
            if key not in lookup:
                lookup[key] = len(verts); verts.append(point); rows.append(row)
            indices.append(lookup[key])
        faces.extend(tuple(indices[i] for i in face) for face in mesh.faces)
    verts = np.asarray(verts)
    # Source faces -x. Rotate about y so it faces -z, preserving winding.
    center = (verts.min(axis=0) + verts.max(axis=0)) / 2
    verts = np.column_stack((-(verts[:, 2] - center[2]), verts[:, 1] - verts[:, 1].min(), verts[:, 0] - center[0]))
    verts *= 180 / verts[:, 1].max()  # readable skyline characters, clear of the lane
    faces = np.asarray([f for f in faces if len(set(f)) == 3])
    # Bake soft directional shading into UVs; the game's existing unlit shader
    # samples a palette row. No new shaders, normals, or runtime downloads.
    light = np.asarray((-.4, .75, -.6)); light /= np.linalg.norm(light)
    face_normals = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    normals = np.zeros_like(verts)
    for corner in range(3): np.add.at(normals, faces[:, corner], face_normals)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    shade = .58 + .42 * np.maximum(0, normals @ light)
    uv = np.column_stack(((shade * 63 + .5) / 64, 1 - (np.asarray(rows) + .5) / len(colors)))
    image = Image.new('RGB', (64, len(colors)))
    for y, color in enumerate(colors):
        for x in range(64): image.putpixel((x, y), tuple(round(c * x / 63) for c in color))
    image.save(ASSETS / 'palette.png')
    # The GLB's colored materials are explicitly double-sided (SketchUp faces
    # include mixed winding). Preserve that with both windings while reusing
    # vertices, rather than losing the cream face/belly or the yellow eyes.
    faces = np.vstack((faces, faces[:, ::-1]))
    payload = {'vertices': np.round(verts, 5).tolist(), 'uvs': np.round(uv, 6).tolist(), 'triangles': faces.tolist()}
    (ASSETS / 'mesh.json').write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    print(f'Mort: {len(verts)} vertices, {len(faces)} triangles, {len(colors)} palette colors, height 180')

if __name__ == '__main__': main()
