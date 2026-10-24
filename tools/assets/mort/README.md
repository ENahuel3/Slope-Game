# Mort V2 — textured skyline model

**Mort V2** by **calvinwil5782**, downloaded by the owner on 2026-10-24:
https://sketchfab.com/3d-models/mort-v2-763eecc8409145059cff213fa646d4cd

License listed by the creator: **Creative Commons Attribution 4.0 (CC BY 4.0)**.
https://creativecommons.org/licenses/by/4.0/
Character/franchise credit: **Madagascar © DreamWorks**.

This replaces Atherin's stylized Warehouse model from the previous releases.
The original OBJ/textures supplied in `mort-v2.zip` are kept under `v2/`, with
source metadata and the archive SHA-256 in `v2/source.json`. The OBJ references
an MTL missing from the download; material names unambiguously map `mort_tex`,
`tail_tex` and `hair_tex` to their correspondingly named PNGs.

`tools/import_mort.py` preserves the OBJ texture UVs, including repeated UVs,
and packs the original body/face, tail and hair PNGs into `atlas.png`. The
provided shadowmap is retained in `v2/` but is not used as the body color map.
`mesh.json` contains 1,786 position/UV vertices and 2,726 triangles. The model
is scaled to 180 units tall and faces the approaching player.

`tools/mort_shader.py` clones the game's Unlit/Texture shader for this material
only. The GLES 2 and GLES 3 fragments discard alpha below 0.25; backface culling
is disabled for fur/whisker cards, and depth writes stay on. This preserves the
original transparency without rectangular hair/tail backgrounds, while keeping
Sunny/Night depth capture working. Other materials/shaders are unchanged.

The crowd remains **87 figures per skyline chunk**: three staggered instances
of a 29-figure mesh. Each mesh has 51,794 vertices and stays below the engine's
16-bit index limit. Mort stands perpendicular to the lane, so the longer tail
follows the slope behind him. Both sides stand 240 units from the lane center
(x=5), and each figure turns 20° inward around the lane normal. The two extra renderers are children of the pooled
root and disappear with it on restart. The actual model uses fewer than half as
many triangles per figure as the previous double-sided placeholder.

Rebuild derived assets (Pillow):

```bash
python tools/import_mort.py
```

Update an already-patched Unity scene (UnityPy and Pillow):

```bash
mkdir -p /tmp/slope-data
python tools/unpack_webdata.py Build/slope_data.unityweb /tmp/slope-data
python tools/patch_mort.py /tmp/slope-data/data.unity3d /tmp/slope-data/mort-data.unity3d
python tools/pack_webdata.py Build/slope_data.unityweb data.unity3d /tmp/slope-data/mort-data.unity3d Build/slope_data.unityweb
```

`patch_buildings.py` also uses this model/material when building the music
prefabs from scratch. Geometry, atlas and shader are embedded in the scene;
there is no external model/texture fetch at runtime. Original pillars, zombies,
King Julien obstacles and game collisions retain their behavior. The Mod Menu
Mort toggle chooses this crowd independently of music, applying to newly spawned chunks.
