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
including menu visibility under both light modes. The 90-second three-course
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
