# Slope frame-pacing release handoff — 2026-10-26

User asked Codex to resolve stutters during normal movement, publish a numbered
version using the existing format, and leave this handoff for Claude sessions
resuming at 6pm. Work branch: `frame-pacing`. Integrated origin/mod through
`fe565a3` before applying the changes; preserve the leaderboard, prior shader
optimizations and dev-mode sandbox changes from those commits.

Release: **v90-framepacing**. Outgoing `fe565a3` is frozen as **v89-sandbox**;
the new implementation is also frozen under `versions/v90-framepacing/` and
listed with title/notes/date/commit/status. Root is the latest release. No shared
engine files, music, scene bundle or mesh geometry were modified.

## Changes

- `TemplateData/gl-state.js` (loaded first): mirror state setters used by Unity
  and overlays, returning cached state rather than synchronously querying the
  WebGL driver each frame. Track textures per unit, samplers, separate read/draw
  framebuffers, VAOs, enable bits, pixel-store flags and blend/depth state.
  Unknown and VAO-dependent parameters fall back to native queries. Query arrays
  are copied so callers cannot mutate the mirror. Deletion invalidates only
  bindings referencing that object; context loss/restoration clears the mirror.
  `SlopeGLState.audit(gl)` compares against native state, for diagnostics only.
- `TemplateData/performance.js`: default **Automatic** render quality. During
  live play start within ~1.2M pixels, lower scale after sustained overload and
  recover slowly, bounded to 50–100% per dimension. **Full resolution** opts out.
  Menus and stack construction stay at native resolution. CSS keeps the display
  size independent of the drawing buffer; Unity reads scaled client dimensions.
  No synthetic input events or modified input coordinates are used. Captures
  actual scene intervals for FPS, 1% low and p99 over the last 300 rendered frames.
- `TemplateData/mod.js`: pace straight-track spawn steps too; keep hidden-stack
  construction burst behavior. Extra render-distance laps wait for the spawn
  point to stop moving instead of interrupting a section every ten frames.
  Recycle draw-count arrays. Heap scanning uses 32K-word chunks / a 2ms budget,
  replacing 4M-word chunks that could greatly overrun their old 12ms budget.
  Show FPS now displays actual rendered FPS and the 1% low, rather than RAF count.
- `TemplateData/coins.js`: reuse view/object scratch matrices; retain independent
  snapshots for pieces and the ball camera. Origin already had the object scratch
  optimization; the additional view reuse preserves camera snapshot ownership.
- `TemplateData/ramps.js`: batch static world-space triangles into one draw and
  upload only after membership/context changes. Own VAO avoids per-frame
  attribute queries on WebGL2/OES. Keep no-VAO fallback. New upload/draw counters.
- `TemplateData/shaders.js`: reuse the scene hook's restored state snapshot for
  the following post pass; explicitly clear samplers. No-VAO path takes its own
  snapshot to preserve attribute setup. Existing shader early-outs preserved.
- `index.html` / `mod.css`: script ordering, canvas attachment, independent CSS
  size, Render quality setting. README documents behavior and measurement.

## Evidence and limits

The earlier Chromium RAF-only tests were insufficient: RAF can tick without a
Unity draw. `tools/frame_bench.py` now samples scene hooks directly and supports
Firefox, actual renderer reporting, baseline script routing, long-frame records,
GL counters, screenshots and optional Chromium CPU profiles.

Reproduced on headless Firefox with Intel GPU, 1920x1200, Night + Rainbow,
10-section render distance, two courses, autopilot:

| Metric | origin/mod baseline | final revised run |
|---|---:|---:|
| Mean rendered FPS | 47.3 | 60.0 |
| 1% low FPS | 24.3 | 40.8 |
| p99 frame interval | 38 ms | 24 ms |
| Worst frame interval | 50 ms | 27 ms |

Baseline sampled 20 seconds; final sampled 30 seconds. Random courses and run
length differ, so these are reproduction/smoke measurements, not an identical
recorded-scene benchmark or a promise of every device's FPS. Final live render
buffer was 1386x866 inside a 1920x1200 CSS display. Native-state audit was empty;
no page/GL errors. Only 86 native parameter queries occurred in 1800 rendered
intervals (including the final audit), versus tens of thousands before caching.
Raw JSON/profile evidence is in `/tmp/slope-*`; final results are
`/tmp/slope-release-pacing.json`, baseline `/tmp/slope-firefox-stress-before.json`.

Checks passed:

- Full shader harness: **26/26** across every style and light mode.
- Coin harness: **12/12**, including planted pickup and toggles.
- Runtime keyboard/music regressions: all pass.
- Native GL mirror checks: WebGL1 and WebGL2, texture/sampler units, separate
  framebuffers, buffers, deletion, array aliasing and real context loss/restore.
- Browser resolution/input checks on WebGL2 and WebGL1/OES: native title Play
  pointer input, automatic budget, Full resolution switching, steering, resize,
  lit overlay state audit and restart all pass.
- Deterministic adaptive-resolution and ramp-batch tests, JS syntax and diff
  checks pass. Camera sweep: 20 rolled samples through 27°, worst alignment
  error 0.08°, straight restored and native full-turn sweep passed.

Commands (one browser at a time):

```
nice -n 19 taskset -c 0-5 /tmp/slope-bugcheck-venv/bin/python tools/frame_bench.py . --browser firefox --gpu --seconds 30 --view-distance 10 --width 1920 --height 1200 --light night
node tools/performance_check.js
node tools/ramp_batch_check.js
nice -n 19 taskset -c 0-5 /tmp/slope-bugcheck-venv/bin/python tools/gl_state_check.py .
nice -n 19 taskset -c 0-5 /tmp/slope-bugcheck-venv/bin/python tools/performance_browser_check.py . --webgl1
```

Respect the existing coordination protocol: one low-priority browser at once,
small/short tests; never silently change CPU power caps. No CPU power settings
were changed. Preserve the pre-existing modified tracked
`tools/__pycache__/fsmparse.cpython-314.pyc`; it is excluded from this release.
