# Minecraft zombie — Aria Math skyline model

The Aria Math skyline is a horde of Minecraft's own zombie: the geometry and skin are the game's,
taken from Mojang's Bedrock sample pack (https://github.com/Mojang/bedrock-samples):

- `source/zombie.geo.json` — `resource_pack/models/entity/zombie.geo.json` (`geometry.zombie.v1.8`): head
  8×8×8, body 8×12×4, arms and legs 4×12×4, in texture pixels, with Minecraft's box UV layout.
- `source/zombie.png` — `resource_pack/textures/entity/zombie/zombie.png`, the 64×32 skin.

Minecraft © Mojang / Microsoft; the files are used as-is for this fan mod.

`tools/import_zombie.py` builds the mesh from the geometry (every cube face mapped the way Minecraft maps a
box, the arms raised 90° about the shoulder pivots into the walking pose) and writes `mesh.json` (144
vertices, 72 triangles, feet at y=0, 32 px tall, facing −z) and `atlas.png`: the skin upscaled 8× with
nearest-neighbour so the pixels stay sharp under bilinear filtering, repeated in four bands at Minecraft's
face brightness (top 1.0, front/back 0.8, sides 0.6, bottom 0.5), because the skyline material is unlit.

`tools/patch_zombie.py` puts one zombie in every other pillar slot of each row (72 per skyline chunk),
170 units tall, 200 units from the lane's centre on both sides, facing the approaching ball and turned 15°
inward, with the same floor rule as the Mort crowd so the heads stay in view above the 45° lane. The
renderer gets its own material (`ZombieSkin`: the game's Unlit/Texture shader with `ZombieAtlas`).
`patch_buildings.py` uses the same geometry and material when it builds the music prefabs from scratch.

Rebuild (Pillow):

```bash
python tools/import_zombie.py
```

Update an already-patched scene (UnityPy and Pillow):

```bash
mkdir -p /tmp/slope-data
python tools/unpack_webdata.py Build/slope_data.unityweb /tmp/slope-data
python tools/patch_zombie.py /tmp/slope-data/data.unity3d /tmp/slope-data/zombie-data.unity3d
python tools/pack_webdata.py Build/slope_data.unityweb data.unity3d /tmp/slope-data/zombie-data.unity3d Build/slope_data.unityweb
```

This replaces the procedural box figure (six untextured boxes in the green-outline ground material) of the
earlier releases.
