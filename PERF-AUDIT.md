# Per-frame audit: Intel Arc integrated GPU, 1920 × 1200

Scope: branch perf-audit, base origin/mod 502d544. Read README shader/coin sections,
shaders.js, coins.js and mod.js draw hooks/frameLoop. Only shaders.js is changed.
Ranking below is by static work and likely bottleneck, not measured Arc timings.
F = 2,304,000 full-resolution fragments; H = 576,000 half-resolution fragments.
At 60 Hz the whole frame has 16.67 ms. Counts are upper bounds before sky,
material, facing, hit and screen-exit branches; they must not be added as if every
pixel traversed every branch. SIMD divergence can reduce the benefit of early exits.

## Ranked costs and fixes

1. **Full-resolution lighting and reflection rays, all three lit modes.**
   `FRAG.sunny/night/sunset`, `reflectRay`, `shadowRay`: even Sunny reflects
   (the README's Night-only description is stale). Each eligible surface can take
   96 depth samples plus eight binary-refinement samples and one residual sample
   **per candidate hit**, and a colour fetch per accepted hit. Thus F × 96 =
   **221.184 million** coarse depth lookups/frame (13.27 billion/s at 60 Hz);
   multiple rejected refinement candidates can add more. Normal reconstruction
   adds four neighbouring depth samples per surface; shadows add up to 16,
   F × 16 = **36.864 million** depth lookups/frame. Shadow hits already stop at
   softness (2 Night, 3 Sunny/Sunset); both marches already stop at near-plane
   and screen exits. Sky pixels already return before these marches.

   **Implemented:** Sunny/Sunset return black immediately for non-sky geometry
   with linear view depth >= 22 and max RGB <= .12. Existing `bgBlack` is exactly
   one there, so the final RGB and alpha are already zero. Saves normal recovery,
   all shadows/reflections, sky arithmetic and fog for those pixels. Per eligible
   pixel this removes up to 116 coarse/normal/shadow depth reads, plus refinement;
   e.g. 10% screen coverage removes up to **26.7264 million** such reads/frame.
   This is a conditional estimate, not a measured coverage or speedup.
   All three modes also skip shadows when emission is exactly one: all terms
   using that shadow are multiplied by zero; up to 16 reads saved per such pixel.

   **Deferred quality option:** half-resolution lighting would reduce lighting
   invocations from F to H (75%, up to 165.888 million coarse reflection reads
   removed) plus an upsample. Plain bilinear upsampling changes thin neon, ball
   silhouettes, normals, UI and reflection detail. Requires depth-aware upsampling
   and matched-camera screenshot approval; not safe under the default-look rule.
   Reducing the 96 steps or eight refinement steps can restore reflection slits
   explicitly mentioned in the source. Keep existing steps and sampling positions.

2. **Sky procedural arithmetic, especially Sunny clouds.**
   `fbm` has four noise octaves, each four sine-based hashes: 16 hashes per
   invocation, up to F × 16 = **36.864 million hashes/frame**. Previously Sunny
   computed clouds on geometry too, although its geometry fog uses `hazeCol`,
   not `skyCol`. **Implemented:** cloud evaluation requires `sky`. Exact RGB
   preservation; savings are 16 hashes per non-sky pixel with up > .02 that
   reaches this code. Night haze still contributes to geometry fog and is retained.

3. **Half-resolution shafts and bloom bandwidth.**
   `rays`: H × 32 = **18.432 million** alpha lookups/frame. **Implemented:**
   evaluate the frame-uniform edge fade before the march and return black when
   it or weight is zero; saves all 18.432 million lookups when light is sufficiently
   far offscreen. Existing behind-camera early-out remains. Do not stop on the
   first zero alpha: later samples can reach sky. Do not truncate the decay tail:
   .955^32 is still about .229, not negligible.

   `bloom`: threshold H × 1 plus four H × 9 blurs = **21.312 million**
   lookups/frame. Neon has five half passes + one full finish, **5.184 million**
   fragment invocations; finish has five source texture expressions (11.52 million
   fetch expressions, compiler may combine duplicates). Synthwave and CRT add a
   full pass. Night/Sunset use two bloom blurs: H × (1 + 18) = **10.944 million**
   bloom reads plus shafts. Sunny uses three total passes (2F + H = 5.184 million
   invocations), Night/Sunset six (2F + 4H = 6.912 million). Light + style chains
   add their costs. **Implemented:** at FX intensity zero built-in styles are
   omitted entirely; Normal needs no capture/post pass, lit modes keep lighting.
   Saves 1–7 style draws depending on style, including all bloom. Object identity
   checks preserve custom `define()` replacement semantics. Default intensity is
   unaffected. Further bloom step/resolution reductions need screenshot evidence.

4. **Scene transfer, render targets and state-query overhead.**
   Normal + an active style copies F pixels with `copyTexSubImage2D`: 9.216 MB
   RGBA-equivalent/frame, 552.96 MB/s at 60 Hz in one direction, potentially twice
   that internal read/write traffic. **Already avoided** in steady lit modes:
   `present()` reads `res.main` colour/depth directly. No redundant-copy fix needed.
   Normal + Classic already bypasses post work. `program()` already caches linked
   programs and all 17 uniform locations, including across resize: no per-frame
   relink/getUniformLocation exists. Preserve those caches.

   **Implemented:** omit uploads to inactive (null) uniform locations. Previously
   every pass issued 13 unconditional uniform calls plus up to four camera/light
   uploads. A blur only needs uTex/uTexel/uP: 3 uploads instead of 13, so Neon’s
   four blurs alone save 40 JS-to-WebGL calls/frame. No GPU arithmetic change.
   Each pass also has 8 texture activation/binding calls, framebuffer/viewport/
   program/draw calls. `saveState`/`restoreState` run around scene hooks and post
   separately: WebGL2+VAO saveState has 20 getParameter and 8 isEnabled calls,
   plus restore traffic (without VAOs, queries scale with MAX_VERTEX_ATTRIBS).
   Proposed future fix: one shared state scope around scene hooks + post; removes
   one full save/restore per processed frame, but needs failure/resize/switch tests
   because Unity caches state. Not implemented without browser verification.

5. **Per-draw JS interception and matrix allocation (coins.js/mod.js).**
   Each ordinary draw crosses three wrappers: coins sawDraw, mod frameDraws.push,
   shaders dirty tracking, then native GL; sawDraw also calls state/attribTable
   for each draw with a captured matrix and scans attributes until a mesh matches.
   Each relevant matrix upload crosses coin and shader wrappers; coins allocates
   a Float32Array(16) and copies 16 floats, even for unrecognised meshes. For D
   draws with object matrices, this is at least **64D bytes/frame** plus object
   overhead (D=500 gives 32 KB/frame, 1.92 MB/s at 60 Hz). Proposed patch below
   reuses the transient object matrix; makePiece already copies persistent data.
   Keep VP copies: camVP may retain a previous perspective upload.

   Coins draw C separate drawElements calls, 3C per-coin uniform calls, trig/bob/
   distance calculations and model writes. `liveCoins` scans all coins and builds
   an array; collection scans it again; piece expiry scans pieces. Hidden tests
   are generation-cached already (not a per-frame quadratic search in steady
   state). Proposed future instancing with ANGLE/WebGL2 would turn C draws into
   one plus a streamed instance buffer; gain roughly C-1 submissions, but requires
   transparent pop ordering and WebGL1 fallback. Restore dynamic batching only
   after replacing draw-based piece recognition; it currently deliberately relies
   on individual scene draws. No Build changes made.

6. **mod frameLoop bookkeeping and game logic.**
   One new draw-count array/frame, full draw-list scan in examineFrame for the
   5190-index skyline signature; syncBuilding/stepAhead/stepTrack also execute
   every frame. Work depends on course count, spawning and track mode, not pixels.
   Avoid optimising those gameplay functions blindly. Proposed two-array recycling
   below removes 60 array allocations/s at 60 Hz and retains lastDraws diagnostics.
   Gains are small compared with lighting, but lower allocation/GC pressure.

## Proposed patches for other owners (not applied)

These are independent reviewable changes. They preserve the current per-draw
protocol; they do not attempt instancing or scene recognition redesign.

```diff
--- a/TemplateData/coins.js
+++ b/TemplateData/coins.js
@@ -99,6 +99,7 @@
     var count = 0, collectedTotal = 0, errors = 0, drawnLast = 0, seenKinds = {};
     function state(ctx) { var s = ctx.__slopeCoins; if (!s) { s = ctx.__slopeCoins = { ab: null, attribBuf: {}, vao: null, vaoAttribs: (bufKind ? new WeakMap() : null) }; } return s; }
     function attribTable(s) { if (s.vao && s.vaoAttribs) { var t = s.vaoAttribs.get(s.vao); if (!t) { t = {}; s.vaoAttribs.set(s.vao, t); } return t; } return s.attribBuf; }
+    var o2wScratch = new Float32Array(16); // consumed synchronously by sawDraw
     function hookProto(P) {
         if (!P || !P.bufferData || P.__slopeCoinsHooked) return;
         P.__slopeCoinsHooked = true;
@@ -135,7 +136,7 @@
         };
         function note(loc, v, off) {
             if (!loc || !v || v.length - (off || 0) < 16) return;
-            var a = new Float32Array(16); for (var i = 0; i < 16; i++) a[i] = v[(off || 0) + i];
+            var a = loc.__coinO2W ? o2wScratch : new Float32Array(16); for (var i = 0; i < 16; i++) a[i] = v[(off || 0) + i];
             if (loc.__coinO2W) o2wLast = a; else vpLast = a;
         }
         P.uniform4fv = function (loc, v, srcOffset) { if (loc && (loc.__coinO2W || loc.__coinVP)) note(loc, v, srcOffset); return oU4.apply(this, arguments); };
```

```diff
--- a/TemplateData/mod.js
+++ b/TemplateData/mod.js
@@ -159,6 +159,7 @@
     // that the world has been cleared (count drops to 0) or is in a run.
     var COURSE_BATCH = 5190;
 
+    var spareDraws = [];
     var frameDraws = [];          // index counts of draws in the frame being rendered
 
     function hookContext(P) {
@@ -499,7 +500,9 @@
         var nowL = performance.now(); if (lastLoopT) { var gapL = nowL - lastLoopT; if (gapL > worstGap) { worstGap = gapL; worstGapFrame = frameNo; } if (gapL > 300) { bigGaps.push([frameNo, Math.round(gapL)]); if (bigGaps.length > 60) bigGaps.shift(); }
             perfWin.n++; perfWin.sum += gapL; if (gapL > perfWin.max) perfWin.max = gapL; if (!perfWin.t0) perfWin.t0 = nowL;
             else if (nowL - perfWin.t0 >= 1000) { perf = { fps: Math.round(perfWin.n * 1000 / (nowL - perfWin.t0)), frameMs: +(perfWin.sum / perfWin.n).toFixed(1), worstMs: Math.round(perfWin.max) }; perfWin = { n: 0, sum: 0, max: 0, t0: nowL }; } } lastLoopT = nowL;
-        var draws = frameDraws; frameDraws = [];
+        var draws = frameDraws;
+        frameDraws = spareDraws; frameDraws.length = 0;
+        spareDraws = draws;
         lastDraws = draws;
         try { examineFrame(draws); } catch (e) { /* never break the game loop */ }
         try { syncBuilding(); } catch (e) { /* diagnostics only */ }
```

## Verification and limits

- `node --check TemplateData/shaders.js` and `git diff --check` pass.
- Codex wrote the audit and the shaders.js edits in a sandbox that denied sockets
  and the git index lock, so the harness and the commit were run afterwards by the
  reviewing session (ncasares-64), after rebasing onto origin/mod 604a252:
  `nice -n 19 taskset -c 0-5 python tools/shader_check.py . --width 640 --height 400 --settle 0.35`
  -> SUMMARY ok=26 fail=0: Classic, the seven colours, Rainbow, Neon, Synthwave, CRT,
  Hyperspeed, Pixel, Noir, Matrix, Sunny, Sunset, Night, Night+colour, back to Off;
  menu visibility under all three lit modes; GL error and shader-failure counters 0.
  Separately, a 40 s autopilot A/B of the current mod head (ab_fps.py) read 60 fps /
  16.7 ms / worst 27-31 ms, so the mod's frameLoop itself is not the limit in headless.
- Not verified: pixel-exact before/after screenshots at a matched camera (the harness
  compares each style with a moving Classic frame); the WebGL 1 path at runtime (the
  edits keep ES 1.00 syntax and constant loop bounds); any Arc GPU timing. Every
  saving above is an arithmetic bound from pixels x steps, not a measured fps gain.
- `SlopeMod.stats()` reports fps/frameMs/worstMs over completed ~1 s windows of the
  mod's frameLoop (frame gaps included, CPU side); `SlopeShaders.stats().lastPassMs`
  is CPU submission time of the whole post chain, not GPU time. Neither establishes
  Arc timings: for that, read the counters in Firefox at 1920x1200 over several
  windows, Normal+Classic against Sunny/Night, with the machine otherwise idle.
