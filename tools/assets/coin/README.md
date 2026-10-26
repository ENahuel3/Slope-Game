# The coin

`source/` holds the downloaded model: **"cc0 - gold coin blank"** by plaggy (Marcel Plagmann),
https://opengameart.org/node/132629, CC0 1.0 — the glTF export (`scene.gltf`, `scene.bin`, 938 vertices,
1248 triangles) and its base-colour texture shrunk to 512 px (`baseColor-512.png`; the original is 4096 px).

`tools/import_coin.py` turns it into what the mod draws: `TemplateData/coins/coin.json` (positions centred and
scaled to a radius of 0.8 game units, normals, UVs, indices) and `TemplateData/coins/coin.png` (128 px). The mod
renders it with per-vertex lighting and an unfiltered texture, the way games around 2000 did, so the big PBR
texture set that comes with the model is not used.

```
python3 tools/import_coin.py              # rebuild coin.json + coin.png
python3 tools/import_coin.py --radius 1.0 --tex 256
```
