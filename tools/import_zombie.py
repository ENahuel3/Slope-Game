"""Build the Aria Math skyline zombie from Minecraft's own zombie model.
Run: python tools/import_zombie.py   (Pillow only)

Source (tools/assets/zombie/source/): `zombie.geo.json` and `zombie.png` from Mojang's Bedrock sample
pack (github.com/Mojang/bedrock-samples, resource_pack/models/entity/zombie.geo.json and
resource_pack/textures/entity/zombie/zombie.png): the in-game geometry (head 8x8x8, body 8x12x4, arms and
legs 4x12x4, in texture pixels) and the 64x32 skin. Each cube is UV-mapped the way Minecraft maps a box
(right / front / left / back strip under a top / bottom pair). The arms are raised 90 degrees about their
shoulder pivots into the zombie's walking pose. The skyline material is unlit, so Minecraft's directional
face shading is baked in: the atlas holds the skin four times at the brightness Minecraft gives top,
front/back, side and bottom faces, upscaled 8x with nearest-neighbour so the pixels stay sharp.
Writes tools/assets/zombie/mesh.json (positions in texture pixels, +y up, feet at y=0, facing -z) and
tools/assets/zombie/atlas.png.
"""
from pathlib import Path
import json
import math
from PIL import Image, ImageEnhance

ASSETS = Path(__file__).resolve().parent / 'assets' / 'zombie'
SRC = ASSETS / 'source'
UP = 8                                   # atlas upscale (nearest neighbour)
SHADE = {'top': 1.0, 'front': 0.8, 'side': 0.6, 'bottom': 0.5}   # Minecraft's face brightness
BAND = {'top': 0, 'front': 1, 'side': 2, 'bottom': 3}
ARM_RAISE = math.radians(-90)            # zombie pose: arms straight out in front


def main():
    geo = json.loads((SRC / 'zombie.geo.json').read_text())['geometry.zombie.v1.8']
    TW, TH = geo['texturewidth'], geo['textureheight']
    skin = Image.open(SRC / 'zombie.png').convert('RGBA')
    assert skin.size == (TW, TH), skin.size
    # atlas: four bands, each the skin at one face brightness
    band_w, band_h = TW * UP, TH * UP
    atlas = Image.new('RGBA', (band_w, band_h * 4), (0, 0, 0, 0))
    for name, k in BAND.items():
        big = skin.resize((band_w, band_h), Image.NEAREST)
        rgb = ImageEnhance.Brightness(big.convert('RGB')).enhance(SHADE[name]).convert('RGBA')
        rgb.putalpha(big.getchannel('A'))
        atlas.paste(rgb, (0, band_h * k))
    AW, AH = atlas.size

    verts, uvs, tris = [], [], []

    def uv(px, py, band):
        """skin pixel coordinates (from the top-left) -> atlas UV (Unity: v=1 at the top row)"""
        return (px * UP / AW, 1 - (py * UP + BAND[band] * band_h) / AH)

    def face(corners, rect, band, xform, flip=False):
        """corners: top-left, top-right, bottom-right, bottom-left as seen from outside;
        rect: (u, v, w, h) in skin pixels; flip mirrors the image horizontally (Minecraft's mirror flag).
        Inset a hair so bilinear filtering never reads a neighbouring texel."""
        u, v, w, h = rect; e = 0.02
        L, Rr = (u + e, u + w - e) if not flip else (u + w - e, u + e)
        tl, tr, br, bl = [xform(c) for c in corners]
        i = len(verts)
        verts.extend([tl, bl, br, tr])             # counter-clockwise from outside
        uvs.extend([uv(L, v + e, band), uv(L, v + h - e, band), uv(Rr, v + h - e, band), uv(Rr, v + e, band)])
        tris.extend([(i, i + 1, i + 2), (i, i + 2, i + 3)])

    def cube(origin, size, tex, xform, mirror=False):
        """Minecraft box UV, built in the final frame: the model faces -z, and seen from the front the viewer's
        left is +x. Bedrock geometry is mirrored in x, so the cube's x range is negated first."""
        ox, y0, z0 = origin; w, h, d = size
        x0, x1 = -(ox + w), -ox; y1, z1 = y0 + h, z0 + d
        u, v = tex
        right_strip, left_strip = (u, v + d, d, h), (u + d + w, v + d, d, h)
        if mirror: right_strip, left_strip = left_strip, right_strip
        f = mirror
        face([(x1, y1, z0), (x0, y1, z0), (x0, y0, z0), (x1, y0, z0)], (u + d, v + d, w, h), 'front', xform, f)          # -z, front
        face([(x0, y1, z1), (x1, y1, z1), (x1, y0, z1), (x0, y0, z1)], (u + 2 * d + w, v + d, w, h), 'front', xform, f)  # +z, back
        face([(x1, y1, z1), (x1, y1, z0), (x1, y0, z0), (x1, y0, z1)], right_strip, 'side', xform, f)                  # +x: front on the viewer's right
        face([(x0, y1, z0), (x0, y1, z1), (x0, y0, z1), (x0, y0, z0)], left_strip, 'side', xform, f)                   # -x: front on the viewer's left
        face([(x1, y1, z1), (x0, y1, z1), (x0, y1, z0), (x1, y1, z0)], (u + d, v, w, d), 'top', xform, f)               # top: image bottom meets the front
        face([(x1, y0, z0), (x0, y0, z0), (x0, y0, z1), (x1, y0, z1)], (u + d + w, v, w, d), 'bottom', xform, f)        # bottom: image top toward the front

    for bone in geo['bones']:
        if bone.get('neverRender') or not bone.get('cubes'): continue
        px, py, pz = bone['pivot']
        rot = ARM_RAISE if bone['name'] in ('rightArm', 'leftArm') else 0.0
        c, s = math.cos(rot), math.sin(rot)
        def xform(p, py=py, pz=pz, c=c, s=s):
            x, y, z = p
            y, z = y - py, z - pz                      # raise about the shoulder: the hand swings to -z (forward)
            y, z = y * c + z * s, -y * s + z * c
            return (x, y + py, z + pz)
        for cb in bone['cubes']:
            cube(cb['origin'], cb['size'], cb['uv'], xform, mirror=bool(bone.get('mirror')))

    ymin = min(v[1] for v in verts)
    verts = [(x, y - ymin, z) for x, y, z in verts]
    atlas.save(ASSETS / 'atlas.png')
    (ASSETS / 'mesh.json').write_text(json.dumps({'vertices': verts, 'uvs': uvs, 'triangles': tris}, separators=(',', ':')) + '\n')
    print('Minecraft zombie: %d vertices, %d triangles, atlas %s, %.0f px tall' % (len(verts), len(tris), atlas.size, max(v[1] for v in verts)))


if __name__ == '__main__':
    main()
