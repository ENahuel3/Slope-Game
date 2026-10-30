/* Slope mod: super ramps (loaded after coins.js, before mod.js).
 *
 * Every so often a lane block carries a super ramp: an orange wedge over the last 6.6 units of the block. A ball
 * that runs onto it is shoved to five times its speed and launched upward, flying a long way down the course before
 * it lands. The ramp lives entirely in the mod: coins.js already recognises every lane block the game draws (by its
 * vertex buffer and object-to-world matrix) and hands out its lane frame, so the ramp is laid out in that frame,
 * drawn into the game's frame (SlopeShaders.onScene, depth-tested like the coins), and the launch is a timed write of
 * the game's own push variables (SlopeMod.boost: zforce forward until the speed reaches the target, yforce upward).
 * Which blocks get a ramp is a hash of the block's key, so a ramp stays where it was first seen; a block under a
 * tunnel, a rolled block, or one too close to the ball or to the previous ramp never gets one.
 *
 * API: window.SlopeRamps = { enabled, setEnabled, stats, ramps, params }.
 */
(function () {
    "use strict";
    var KEY_ON = "slope-mod.ramps";
    var P = { every: 11, speedMul: 5, upMul: 4.0, maxMs: 350, upMs: 250, foot: 7.5, top: 14.0, rise: 2.8, inset: 0.6, minGap: 9, minAhead: 25, minS: 120 };
    var BLOCK = 14.1421;
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }
    function warn(msg) { if (window.console) console.warn("[slope-ramps] " + msg); }
    var enabled = lsGet(KEY_ON) !== "false";
    var ramps = {}, decided = {}, lastRampS = -1e9, launches = 0, errors = 0, drawnLast = 0, geometryVersion = 0, uploads = 0, drawCalls = 0;
    function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
    function hash(key) { var h = 2166136261; for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

    // ------------------------------------------------------------------ choosing and laying out the ramps
    var FWD0 = [0, -0.70710678, 0.70710678];
    function laneCoords(fr, wp) { var d = sub(wp, fr.org); return [dot(d, fr.right), dot(d, fr.fwd), dot(d, fr.up)]; }
    function rolled(fr) { return Math.abs(fr.right[1]) > 0.08 || Math.abs(fr.right[2]) > 0.08; }   // the lane's "right" leaves the world x axis once the course rolls
    function consider(frames, ballS) {
        var cands = frames.filter(function (f) { return decided[f.key] === undefined && f.lane && f.kind === "slope" && !f.hidden && !rolled(f); });
        cands.sort(function (a, b) { return dot(a.org, FWD0) - dot(b.org, FWD0); });
        for (var i = 0; i < cands.length; i++) {
            var f = cands[i]; if (decided[f.key] !== undefined) continue;
            var s0 = dot(f.org, FWD0);
            if (s0 < ballS + P.minAhead) { decided[f.key] = false; continue; }                  // already on top of the ball when first seen: no surprise ramps
            if (s0 < P.minS) { decided[f.key] = false; continue; }                             // not in or right after the start tunnel
            var mid = [f.org[0] + f.fwd[0] * 7 + f.up[0], f.org[1] + f.fwd[1] * 7 + f.up[1], f.org[2] + f.fwd[2] * 7 + f.up[2]];
            if (SlopeCoins.underTunnel && SlopeCoins.underTunnel(mid)) { decided[f.key] = false; continue; }   // no ramp under a roof
            var gap = s0 - lastRampS;
            var want = gap >= P.minGap * BLOCK && ((hash(f.key) % P.every) === 0 || gap >= 2 * P.every * BLOCK);   // a long dry spell forces one
            decided[f.key] = want;
            if (want) { lastRampS = s0; ramps[f.key] = makeRamp(f); geometryVersion++; if (window.SlopeCoins && SlopeCoins.muteBlock) SlopeCoins.muteBlock(f.key); }
        }
    }
    // A new run puts the ball back at the start, but lastRampS still held the previous run's last ramp far down the
    // course, so the min-gap rule refused every ramp until the ball passed that point again (ramps only on run one).
    var prevBallS = null;
    function resetOnRestart(ball, ballS) {
        if (!ball) return;
        if (prevBallS !== null && ballS < prevBallS - 4 * BLOCK) { lastRampS = -1e9; ramps = {}; decided = {}; geometryVersion++; }
        prevBallS = ballS;
    }
    function makeRamp(f) {
        // the wedge in the block's lane frame: x inset..10-inset, foot at s=foot (n 0) rising to s=top (n rise)
        var x0 = P.inset, x1 = 10 - P.inset, s0 = P.foot, s1 = P.top, h = P.rise;
        function W(x, s, n) { return [f.org[0] + f.right[0] * x + f.fwd[0] * s + f.up[0] * n, f.org[1] + f.right[1] * x + f.fwd[1] * s + f.up[1] * n, f.org[2] + f.right[2] * x + f.fwd[2] * s + f.up[2] * n]; }
        var A = W(x0, s0, 0), B = W(x1, s0, 0), C = W(x1, s1, h), D = W(x0, s1, h), E = W(x1, s1, 0), F = W(x0, s1, 0);
        var top = [1.0, 0.55, 0.08], edge = [1.0, 0.85, 0.3], back = [0.45, 0.12, 0.02], side = [0.75, 0.32, 0.05];
        var v = [];
        function tri(p, q, r, c) { v.push.apply(v, p.concat(c, q, c, r, c)); }
        tri(A, B, C, top); tri(A, C, D, top);                                 // the sloped top
        tri(D, C, E, back); tri(D, E, F, back);                               // the vertical back (faces the ball when it lands short)
        tri(A, D, F, side); tri(B, E, C, side);                               // the two sides
        // a bright lip stripe along the top edge, and three chevrons up the face
        var lip0 = W(x0, s1 - 0.5, h - 0.5 * h / (s1 - s0)), lip1 = W(x1, s1 - 0.5, h - 0.5 * h / (s1 - s0));
        tri(lip0, lip1, C, edge); tri(lip0, C, D, edge);
        for (var k = 0; k < 3; k++) {
            var sa = s0 + (s1 - s0) * (0.18 + 0.26 * k), sb = sa + 0.9, na = h * (sa - s0) / (s1 - s0) + 0.03, nb = h * (sb - s0) / (s1 - s0) + 0.03;
            var L0 = W(2.0, sa, na), L1 = W(5.0, sb, nb), L2 = W(5.0, sb - 0.55, nb - 0.55 * h / (s1 - s0)), L3 = W(2.0, sa - 0.55, na - 0.55 * h / (s1 - s0));
            tri(L0, L1, L2, edge); tri(L0, L2, L3, edge);
            var R0 = W(8.0, sa, na), R1 = W(5.0, sb, nb), R2 = W(5.0, sb - 0.55, nb - 0.55 * h / (s1 - s0)), R3 = W(8.0, sa - 0.55, na - 0.55 * h / (s1 - s0));
            tri(R1, R0, R3, edge); tri(R1, R3, R2, edge);
        }
        return { key: f.key, fr: f, data: new Float32Array(v), count: v.length / 6, fired: 0, s0: dot(f.org, FWD0) };
    }

    // ------------------------------------------------------------------ the launch
    var flash = null, flashAt = 0, audioCtx = null;
    function whoosh() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === "suspended") audioCtx.resume();
            var t0 = audioCtx.currentTime, g = audioCtx.createGain(); g.connect(audioCtx.destination);
            g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
            var o = audioCtx.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(180, t0); o.frequency.exponentialRampToValueAtTime(1400, t0 + 0.45);
            o.connect(g); o.start(t0); o.stop(t0 + 0.75);
        } catch (e) { /* no audio */ }
    }
    function showFlash() {
        if (!flash) { flash = document.createElement("div"); flash.className = "ramp-flash"; flash.textContent = "SUPER RAMP!"; document.body.appendChild(flash); }
        flash.classList.remove("on"); void flash.offsetWidth; flash.classList.add("on"); flashAt = performance.now();
    }
    function fire(r) {
        if (!window.SlopeMod || !SlopeMod.boost || !SlopeMod.boost(P.speedMul, P.upMul, P.maxMs, P.upMs)) return;
        r.fired = performance.now(); launches++; whoosh(); showFlash();
    }
    function check(ballPos) {
        if (!ballPos) return;
        for (var k in ramps) {
            var r = ramps[k]; if (r.fired) continue;
            var c = laneCoords(r.fr, ballPos);
            if (c[1] >= P.foot - 0.4 && c[1] <= P.top + 0.6 && c[0] > P.inset - 0.6 && c[0] < 10 - P.inset + 0.6 && c[2] > -1 && c[2] < P.rise + 1.5) fire(r);
        }
    }

    // ------------------------------------------------------------------ drawing
    var VS = "attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uVP; varying vec3 vCol; void main() { vCol = aCol; gl_Position = uVP * vec4(aPos, 1.0); }";
    var FS = "precision mediump float; varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.0); }";
    var res = null;
    function compile(g, gl, type, src) { var sh = g.createShader(type); g.shaderSource(sh, src); g.compileShader(sh); if (!g.getShaderParameter(sh, gl.COMPILE_STATUS)) { warn("shader: " + g.getShaderInfoLog(sh)); g.deleteShader(sh); return null; } return sh; }
    function ensure(h) {
        var g = h.g, gl = h.gl;
        if (res && res.gl === gl && !res.failed) return res.ok;
        res = { gl: gl, ok: false, failed: false, geometryVersion: -1, vertexCount: 0 };
        try {
            var vs = compile(g, gl, gl.VERTEX_SHADER, VS), fs = compile(g, gl, gl.FRAGMENT_SHADER, FS); if (!vs || !fs) { res.failed = true; return false; }
            var prog = g.createProgram(); g.attachShader(prog, vs); g.attachShader(prog, fs); g.bindAttribLocation(prog, 0, "aPos"); g.bindAttribLocation(prog, 1, "aCol"); g.linkProgram(prog);
            if (!g.getProgramParameter(prog, gl.LINK_STATUS)) { warn("program: " + g.getProgramInfoLog(prog)); res.failed = true; return false; }
            res.prog = prog; res.uVP = g.getUniformLocation(prog, "uVP"); res.vbo = g.createBuffer();
            res.vao = h.vaoMode === "gl2" ? g.createVertexArray() : h.vaoMode === "oes" ? h.vaoExt.createVertexArrayOES() : null;
            if (res.vao) {
                if (h.vaoMode === "gl2") g.bindVertexArray(res.vao); else h.vaoExt.bindVertexArrayOES(res.vao);
                g.bindBuffer(gl.ARRAY_BUFFER, res.vbo);
                g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
                g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
                if (h.vaoMode === "gl2") g.bindVertexArray(null); else h.vaoExt.bindVertexArrayOES(null);
            }
            res.ok = true;
        } catch (e) { warn("resources: " + e); res.failed = true; errors++; }
        return res.ok;
    }
    function onScene(h) {
        drawnLast = 0;
        if (!enabled || !window.SlopeCoins || !SlopeCoins.frames) return;
        var frames = SlopeCoins.frames(), live = {};
        for (var i = 0; i < frames.length; i++) live[frames[i].key] = true;
        for (var k in ramps) if (!live[k]) { delete ramps[k]; geometryVersion++; }                       // the block was passed and despawned
        for (var k2 in decided) if (!live[k2]) delete decided[k2];
        var ball = SlopeCoins.ballPos();
        var ballS = ball ? dot(ball, FWD0) : -1e9;
        resetOnRestart(ball, ballS);
        consider(frames, ballS);
        check(ball);
        var keys = Object.keys(ramps), vp = SlopeCoins.camera();
        if (!keys.length || !vp) return;
        if (window.SlopeMod && SlopeMod.overMenu && SlopeMod.overMenu()) return;   // the game-over screen stays empty
        if (!ensure(h)) return;
        var g = h.g, gl = h.gl;
        var keep = { depthFunc: g.getParameter(gl.DEPTH_FUNC), depthMask: g.getParameter(gl.DEPTH_WRITEMASK), cull: g.isEnabled(gl.CULL_FACE), blend: g.isEnabled(gl.BLEND) };
        if (!res.vao) keep.attribs = { elementBuf: g.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING), a1: g.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_ENABLED), a1buf: g.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
            a1size: g.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_SIZE), a1type: g.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_TYPE), a1norm: g.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED), a1stride: g.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_STRIDE), a1off: g.getVertexAttribOffset(1, gl.VERTEX_ATTRIB_ARRAY_POINTER) };
        try {
            if (res.vao) { if (h.vaoMode === "gl2") g.bindVertexArray(res.vao); else h.vaoExt.bindVertexArrayOES(res.vao); }
            g.useProgram(res.prog); g.uniformMatrix4fv(res.uVP, false, vp);
            g.enable(gl.DEPTH_TEST); g.depthFunc(gl.LESS); g.depthMask(true); g.disable(gl.CULL_FACE); g.disable(gl.BLEND); g.disable(gl.SCISSOR_TEST); g.colorMask(true, true, true, true);
            g.bindBuffer(gl.ARRAY_BUFFER, res.vbo);
            if (!res.vao) {
                g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
                g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
            }
            // Ramp vertices are already in world space and do not animate. Rebuild only when
            // the live set changes; all ramps share a shader and can use one draw on WebGL 1/2.
            if (res.geometryVersion !== geometryVersion) {
                var size = 0;
                for (var j = 0; j < keys.length; j++) size += ramps[keys[j]].data.length;
                var batch = new Float32Array(size), offset = 0;
                for (var n = 0; n < keys.length; n++) { var data = ramps[keys[n]].data; batch.set(data, offset); offset += data.length; }
                g.bufferData(gl.ARRAY_BUFFER, batch, gl.STATIC_DRAW);
                res.vertexCount = size / 6;
                res.geometryVersion = geometryVersion;
                uploads++;
            }
            g.drawArrays(gl.TRIANGLES, 0, res.vertexCount);
            drawCalls++;
            drawnLast = keys.length;
        } catch (e) { errors++; }
        finally {
            g.depthFunc(keep.depthFunc); g.depthMask(keep.depthMask); if (keep.cull) g.enable(gl.CULL_FACE); if (keep.blend) g.enable(gl.BLEND);
            if (keep.attribs) {
                var a = keep.attribs;
                if (a.a1buf) { g.bindBuffer(gl.ARRAY_BUFFER, a.a1buf); g.vertexAttribPointer(1, a.a1size, a.a1type, a.a1norm, a.a1stride, a.a1off); }
                if (!a.a1) g.disableVertexAttribArray(1);
                g.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, a.elementBuf);
            }
            if (res.vao) { if (h.vaoMode === "gl2") g.bindVertexArray(null); else h.vaoExt.bindVertexArrayOES(null); }
        }
    }
    if (window.SlopeShaders && SlopeShaders.onScene) SlopeShaders.onScene(onScene); else warn("shaders.js is not loaded before ramps.js; ramps cannot draw");

    // ------------------------------------------------------------------ settings and API
    var menuBox = null;
    function setEnabled(on) {
        enabled = !!on; lsSet(KEY_ON, enabled);
        if (!enabled) { ramps = {}; decided = {}; geometryVersion++; }
        if (!menuBox) menuBox = document.getElementById("hud-ramps");
        if (menuBox && menuBox.checked !== enabled) menuBox.checked = enabled;
    }
    function wireHud() {
        menuBox = document.getElementById("hud-ramps");
        if (menuBox) { menuBox.checked = enabled; menuBox.addEventListener("change", function () { setEnabled(menuBox.checked); }); }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireHud); else wireHud();
    window.SlopeRamps = {
        enabled: function () { return enabled; },
        setEnabled: setEnabled,
        params: P,
        ramps: function () { var o = []; for (var k in ramps) o.push({ key: k, s0: +ramps[k].s0.toFixed(1), fired: !!ramps[k].fired }); return o; },
        stats: function () { return { enabled: enabled, ramps: Object.keys(ramps).length, decided: Object.keys(decided).length, launches: launches, drawn: drawnLast, uploads: uploads, drawCalls: drawCalls, errors: errors, gl: !!(res && res.ok) }; }
    };
})();
