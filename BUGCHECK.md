# Bug-check handoff — 2026-10-24

Reviewed GitHub `mod` at `b1fdef6`. The laptop was fast-forwarded from
`7d63ab3` before testing. The owner requested publication of the changes documented below. The pre-existing edit to
`edit-server/slope-edit.service` was preserved.

## Fixed in `TemplateData/mod.js`

- **Dev-panel shortcuts never reached their handlers.** The window capture
  listener stopped events before password Enter, prompt Ctrl/Cmd+Enter, and
  Escape could reach target/document listeners. Handle these shortcuts inside
  the input shield, retaining ordinary textarea Enter and button activation.
- **Style, Light, and intensity keys leaked into Unity.** The shield listed
  individual older HUD controls and omitted the newer shader controls. Shield
  the whole HUD and editor instead, preserving browser default control actions.
- **Original music could continue after death and overlap later runs.**
  Original → custom → Original creates a replacement AudioBufferSourceNode;
  Unity still stops the original source. Track that Unity-owned source
  separately and stop its active replacement when Unity ends the run.
- **Changing music after death could start playback on the game-over screen.**
  Mark stopped sources dead and defer selection changes until the next run.

## Regression checks

`tools/runtime_check.py` uses Chromium keyboard events and native Web Audio
sources, with a minimal HUD, a simulated Unity capture listener, and stubbed
editor responses/media playback. No Claude calls, credentials, Pi access, or
publishing are involved. The nine bug-specific checks failed against the
original `b1fdef6` runtime and pass with the fix. An additional check verifies
HUD buttons retain Enter activation.

```bash
/tmp/slope-bugcheck-venv/bin/python tools/runtime_check.py .
node --check TemplateData/mod.js
git diff --check
```

The temporary virtualenv contains Playwright and Pillow. On another machine,
install those packages and Playwright Chromium in your preferred environment.

Additional checks: 17/17 shader checks passed on WebGL 2 and 17/17 on WebGL 1,
including menu visibility under both light modes. The initial three-course
stack test reported no stalls or page errors. A combined curves/twists smoke
test advanced into the rolled track and reached a normal death/game-over;
the remaining observation time checks the game-over loop, not continued play.

Browser logs/screenshots are in
`/tmp/slope-bugcheck-*`. The existing shader and soak tools were used. Rendering
checks run in headless Chromium with SwiftShader; timings are not a measure of
hardware GPU performance. Normal deaths during these tests are expected.

Frozen versions were left untouched. The owner explicitly requires every
published change to receive a new version and date, following the existing
version-history format. Before publishing, freeze the outgoing root using the
existing snapshot workflow and update the latest-version title, notes, and
date; the pre-push hook requires preservation of the outgoing version.
The Pi editing service was read for context but was not
deployed or comprehensively security-audited.

## Mort follow-up — 2026-10-24

Replaced the procedural sphere/box Mort approximation with Atherin's downloaded
**Mort (Madagascar)** model from 3D Warehouse. Source, credit, hash, and rebuild
instructions are in `tools/assets/mort/README.md`. The scene embeds the new
mesh and a small shaded color palette. Mort Jackson still selects it through
the same prefab; original pillars and zombies retain their existing objects.
The source uses double-sided materials; both triangle windings are embedded so
Unity preserves its cream face/belly as well as its yellow eyes. Its size and distance from
the lane were adjusted after in-game screenshot checks so solid figures do not
obscure the track. There are 29 figures per skyline chunk, under the 16-bit
vertex limit on both WebGL versions.

Both an existing-scene replacement and a fresh `patch_buildings.py` build were
checked. Comparing the existing-scene replacement with the original scene
showed only the Mort mesh/renderer changed, plus one new material and texture.
A UnityPy read-after-save issue in the fresh build is handled by reloading the
bundle before assigning the new prefab's material.

Rendering checks with `--music billie --styles classic,rainbow,synthwave` passed
11/11 on WebGL 2 and 11/11 on WebGL 1, including Sunny/Night lighting. The 10
keyboard/audio regressions also passed. In-game smoke runs loaded the new scene,
played Mort Jackson, and produced no page errors. Logs/screenshots live under
`/tmp/slope-mort-*`. The compressed data bundle grows by about 0.9 MB.

The outgoing GitHub version is now preserved as `versions/v18-reviewfix/`
(commit `b1fdef6`, dated 2026-10-24). `versions/index.json` describes the new
root as **Mort model and runtime fixes**, dated 2026-10-24. This is the dated version history for the Mort model and runtime-fixes release.
The original service-file edit remains intact.

## Starting-tunnel reset protection — 2026-10-24

Published the Mort/runtime release as `4fdc5eb`; GitHub Pages deployment succeeded.
Its complete dated copy is now `versions/v19-mort/` before this next release.

Reproduced the reported starting-tunnel reset pattern in full Chromium/Unity by
introducing five 1.8-second main-thread delays at a high refresh rate. The old
version restarted twice at course progress around -1 and 7, with zero deaths;
the patched version progressed through the tunnel with zero watchdog resets
under the same delays. Both runs had zero page errors. Details are in
`/tmp/slope-pause-check.log` and the reproduction script is
`/tmp/slope-pause-check.py` (local server on port 8769, old runtime supplied from
`/tmp/slope-before-tunnel.js`).

Changes in `TemplateData/mod.js`:

- Startup grace is four real seconds instead of 240 animation frames, so fast
  monitors do not shorten the wait at the beginning of a run.
- Hidden tabs and gaps longer than 500 ms clear the stuck observation. A paused
  or delayed physics update is not treated as 1.5 seconds of confirmed jamming.
- A late/duplicate music-start confirmation cannot start another stack build
  while the run is already live. New runs after actual deaths still build stacks.

`node tools/restart_check.js` checks these cases using the actual watchdog and
run-signal functions with controlled time/state. Four checks failed against the
old runtime; all eight pass after the fix, including real jam recovery, sideways
steering during a jam, forward movement, and starting again after death. The
existing ten keyboard/audio browser regressions also pass. A full 60-second
three-course run completed with four normal death/restart cycles, zero watchdog
resets, zero stalls, and zero page errors.

The new latest-version entry is **Starting-tunnel reset protection**, dated
2026-10-24. The pre-existing local service-file edit remains outside these commits.

## More Morts / King Julien blocks — 2026-10-24

- Increased the crowd from 29 to 87 per skyline chunk by attaching two staggered
  child renderers that reuse the existing mesh. The children follow the pooled
  root's lifetime and each draw stays below the 16-bit vertex limit. Download
  size for the Unity scene is essentially unchanged.
- Added `TemplateData/julien.js` and local PNG assets. All four red obstacle
  textures are recognized by their compressed/decoded data fingerprints. During
  Mort Jackson, each draw temporarily uses a texture with Julien's PNG head and
  crown inside the original red border, then restores Unity's binding. Switching
  to Original or Aria Math restores plain obstacles immediately. No collision or
  obstacle geometry changed. Source credit is in the theme directory's README.
- While checking the rebuilt scene, found the ball selector could pick a changed
  position copy in raw asset memory. Ball candidates now use the same live-memory
  filter as other tracked scene transforms. A regression verifies that raw asset
  copies cannot steer the autopilot or drive the stuck watchdog.
- `tools/julien_check.py` passes 9 checks on WebGL 2 and 9 on WebGL 1, including all
  four red textures, immediate music switching, Night/Rainbow, restored GL texture
  bindings, and zero GL/page errors. Restart/heap regressions and prior keyboard/
  audio regressions also pass. Both existing-scene and fresh-scene crowd builders
  were checked. Screenshots/logs are in `/tmp/slope-julien-*`.
- Preserved the prior published root (`dd3c6d4`) as dated `v20-tunnel` before this
  release; the new latest-version title/notes/date describe these changes.

Accurate model replacement is still pending an accessible source archive. The
more accurate **Mort V2 by calvinwil5782** on Sketchfab was visually checked, but
its archive download requires a Sketchfab login (the download API returns 401).
The original-game Models Resource downloads also return a Cloudflare challenge.
The existing model remains in use; another available Warehouse model was checked
and rejected because it was less accurate. Candidate/source details are in
`tools/assets/mort/README.md`; do not describe this release as a new Mort model.
