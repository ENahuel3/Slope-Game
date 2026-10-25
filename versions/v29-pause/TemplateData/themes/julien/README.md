# King Julien obstacle-face theme

Source PNG (downloaded 2026-10-24, retained unchanged):
https://www.pngall.com/wp-content/uploads/15/King-Julien.png

Source page: https://www.pngall.com/king-julien-png/
Character/artwork: King Julien, DreamWorks Animation / Madagascar.

`TemplateData/julien.js` selects the head and crown in texture space and stamps
it inside the existing red border at runtime. It recognizes exactly the four
shipped red obstacle textures by compressed or decoded byte fingerprints.
The small red PNGs here are decoded copies of the game's original textures,
used to preserve their borders. The Mod Menu's independent King Julien toggle
controls the effect with any soundtrack; switching it off uses the original GPU textures.
No obstacle mesh, collision, or external runtime download is changed.

Load order is shaders.js, julien.js, mod.js. The post-processing system captures
native GL functions before the theme hooks; the draw-counting mod wraps after
them. The theme restores every texture binding it changes after each draw so
Unity's cached state and the lighting/style passes remain consistent.

Checks: `python tools/julien_check.py .` and repeat with `--webgl1 --port 8773`.
