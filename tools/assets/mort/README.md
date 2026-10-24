# Mort (Madagascar)

Downloaded 2026-10-24 from **Mort (Madagascar)** by **Atherin**:
https://3dwarehouse.sketchup.com/model/b9f027d3-8e8a-4db1-a757-23fbb8a3a6b2/Mort-Madagascar

Character/franchise: DreamWorks Animation. The source listing credits Madagascar,
Escape 2 Africa, and Madagascar 3: Europe's Most Wanted. This is a downloaded,
static low-poly character model, not the earlier procedural mouse-lemur approximation.

Public GLB supplied by 3D Warehouse (saved byte-for-byte as `source.glb`):
https://download-warehouse.sketchup.com/warehouse/v1.0/content/public/61b9ee57-2f0f-4078-a86d-6c3e067463d2

Source SHA-256: 94d48253070a9ed5d05b3757b1efdc0db15681a8c323fc62f3d303f30ab7086e

`mesh.json` and `palette.png` are derived by `tools/import_mort.py`. The converter
applies the GLB scene transforms, rotates the character to face the player,
scales it to 180 game units tall, welds duplicate
position/material vertices, and bakes soft directional shading into a small
palette texture. Both triangle windings preserve the source's double-sided
materials in Unity, including the cream face/belly and yellow eyes. Original brown, cream, black, and yellow material colors are
retained. No animation or runtime external fetch is added.

The current crowd contains 29 figures per skyline chunk. Heads sit 80–150
world-height units above the lane at each row so faces stay visible. Solid
figures are kept at least 240 units to either side of the lane. Spacing is chosen to
keep the entire crowd below Unity's 65,535-vertex limit; this also works on
WebGL 1. The existing zombies, original pillars, music selector, and prefab
pointers are retained.

Rebuild the derived files (requires trimesh, numpy, Pillow):

```bash
python tools/import_mort.py
```

Update an already-patched Unity scene (requires UnityPy and Pillow):

```bash
python tools/unpack_webdata.py Build/slope_data.unityweb /tmp/slope-data
python tools/patch_mort.py /tmp/slope-data/data.unity3d /tmp/slope-data/mort-data.unity3d
python tools/pack_webdata.py Build/slope_data.unityweb data.unity3d /tmp/slope-data/mort-data.unity3d Build/slope_data.unityweb
```

Create the output directory before unpacking. `patch_buildings.py` also uses this
model/material for fresh scene builds. The color palette is embedded in the
scene bundle; the game does not need to load the GLB or JSON separately.

Source model remains attributed to Atherin and the character to DreamWorks.
3D Warehouse terms: https://3dwarehouse.sketchup.com/tos/
