/* Slope mod: collectable 3D coins (loaded after shaders.js, before mod.js).
 *
 * The coins sit on the course's own pieces in the places that are hard to reach but reachable: on top of the tunnels
 * (a ball lands there off a gap lip), on the lip of the jumps and just past it in the air, at the edges of the thin
 * lanes, on the uphill side of the tilted lanes, at the outer corners of the doglegs, and at the very edge of some lane
 * blocks (not under a tunnel, where the edge is inside the wall; the start tunnel has none at all). Every position
 * was derived from the piece meshes and the ball physics (tools/coin_layout.py): the ball's centre rides 0.5 above a
 * walkable floor, so a floor coin sits 1.0 above the floor and the 1.25 pick radius always catches it; an air coin sits
 * where the trajectories of every speed (8..40 u/s) and push (zforce 24..110) pass within the pick radius. Each coin
 * collected adds one point to the game's own score (SlopeMod.addScore). Nothing in the scene data is changed for them.
 *
 * How the coins know where the pieces are: the game draws every track piece with its own draw call, after uploading
 * the piece's object-to-world matrix (unity_ObjectToWorld) and with the piece's mesh in the bound vertex buffer. The
 * vertex buffers are uploaded once, byte for byte from the scene data, so each mesh is recognised by the size and a
 * hash of its upload (the table below, from tools/mesh_fingerprints.py). Each frame the draw calls are watched: a
 * known mesh plus its matrix is a piece at a known place; the first time a piece is seen its coins are generated from
 * the layout for that mesh (positions in the piece's lane frame: x across the lane, s along it, n above its floor),
 * transformed by the matrix, so coins follow a rolled or shifted piece exactly. The ball is a draw call too (the
 * Sphere mesh), which gives its position for collecting and the camera's view-projection for drawing the coins.
 *
 * Drawing: the coin is plaggy's CC0 "gold coin blank" (tools/assets/coin, converted by tools/import_coin.py), rendered
 * the way games did around 2000: per-vertex Gouraud lighting with a hard specular, a tiny texture with no filtering,
 * spinning and bobbing in place. It is drawn into the game's own frame right after the game's draws and before the
 * post-processing (SlopeShaders.onScene), with the depth test on so the lane and the tunnels occlude it properly.
 *
 * API: window.SlopeCoins = { enabled, setEnabled, count, best, reset, stats, pieces, plant, layouts }.
 */
(function () {
    "use strict";
    var R2 = 0.70710678;
    var KEY_ON = "slope-mod.coins", KEY_BEST = "slope-mod.coins.best";
    var PICK_RADIUS = 1.25;            // ball radius 0.5 + coin radius 0.8, less a hair
    var EXPIRE_FRAMES = 300;           // a piece not drawn for this many frames is gone (behind, or despawned)
    var SPIN = 1.1, BOB = 0.15, POP_MS = 320;
    var ASSET_DIR = "TemplateData/coins/";
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }
    function warn(msg) { if (window.console) console.warn("[slope-coins] " + msg); }
    var enabled = lsGet(KEY_ON) !== "false";
    var best = parseInt(lsGet(KEY_BEST), 10) || 0;

    // ------------------------------------------------------------------ meshes: vertex-buffer fingerprints
    // "<bytes>/<FNV-1a of the first 256 bytes>" of each mesh's vertex upload (tools/mesh_fingerprints.py)
    var MESHES = {
        "8240/77d6994d": "tunnelArc",       // TunnelNarrow: the red-striped arch of the speed-up tunnel (hard run)
        "8240/e3bf3a74": "tunnelArcLong",   // TunnelNarrowLong: the arch of the start tunnel
        "8160/3a9e10bc": "tunnelRoof",      // TunnelRoof: the stepped roof of the death tunnel (medium run)
        "11680/080fadf8": "deathTunnel",    // DeathTunnel: its walls
        "800/8d9aef7e": "jump",             // Jump: the lip at the end of a tunnel run
        "1600/b58fd81a": "jumpGapMid",      // JumpGapMid: the lip before the gap at the end of a death tunnel
        "1640/c5256df5": "thin",            // Thin: the 5-wide lane
        "1120/5acc1114": "thinNoJump",      // ThinNoJump: the 5-wide lane of the thin switch and the doglegs
        "3020/bc4080c1": "dogleg",          // ThinS: the weaving thin lane
        "560/76e3c522": "slope",            // Slope: the lane block
        // twisted variants of the course pieces (tools/patch_roll.py / the peers' twist tools): a base kind plus P or N,
        // the cross-section rotating +/-4.5 degrees per 14.1421 along the piece about the lane's centre line
        "2400/4b0eeb65": "slopeP", "2400/85cb55e3": "slopeN",
        "12460/f523fe8b": "thinP", "12460/e7a5eb4a": "thinN",
        "11420/f523fe8b": "thinNoJumpP", "11420/e7a5eb4a": "thinNoJumpN",
        "23600/15630fae": "doglegP", "23600/b94db466": "doglegN",
        "3360/c27550a2": "jumpP", "3360/5e3a4a4f": "jumpN",
        "5340/0c02c36f": "jumpGapMidP", "5340/78d55776": "jumpGapMidN",
        "43880/5c7aa8f6": "tunnelArcP", "43880/c3e53f53": "tunnelArcN",
        "64680/5c7aa8f6": "tunnelArcLongP", "64680/c3e53f53": "tunnelArcLongN",
        "16260/b44246fe": "tunnelRoofP", "16300/a3a796c5": "tunnelRoofN",
        "23940/f6580af1": "deathTunnelP", "24000/eaa16814": "deathTunnelN",
        "560/8c0596f5": "tiltLeft",         // slopeWideTiltLeft: the wide lane tilted up on the right
        "560/75ca3d9b": "tiltRight",        // slopeWideTiltRight: tilted up on the left
        "28840/9cb76e50": "ball"            // Sphere
    };
    var LENGTH = { tunnelArc: 56.6, tunnelArcLong: 84.8, tunnelRoof: 41, deathTunnel: 42.5, jump: 42.4, jumpGapMid: 42.4, thin: 78, thinNoJump: 78, dogleg: 151, slope: 14.1, tiltLeft: 14.1, tiltRight: 14.1 };
    // a twisted piece: base kind and direction. Every piece twists about the spawn frame's x = 5 line in its own frame (the
    // 5-wide pieces included: the mod keeps that line fixed as the roll changes, so consecutive pieces meet only that way)
    var TWIST_RATE = 4.5 * Math.PI / 180 / 14.1421, TWIST_AXIS_X = 5;
    function baseKind(kind) { var m = /^(.*)(P|N)$/.exec(kind); return m && (LENGTH[m[1]] !== undefined || LAYOUTS[m[1]]) ? m[1] : kind; }
    function twistDir(kind) { var b = baseKind(kind); return b === kind ? 0 : (kind.slice(-1) === "P" ? 1 : -1); }
    function twisted(c, dir, base) {            // a layout coin (x, s, n) on the cross-section at s, rotated right-handed about the forward axis
        if (!dir) return c;
        var ax = TWIST_AXIS_X, th = dir * TWIST_RATE * c[1], cs = Math.cos(th), sn = Math.sin(th), dx = c[0] - ax, n = c[2];
        return [ax + dx * cs - n * sn, c[1], dx * sn + n * cs];
    }

    // ------------------------------------------------------------------ layouts: [x, s, n] per piece, in its lane frame
    // x across the lane (the lane blocks span 0..10), s along the course from the piece's origin, n above its floor.
    // n is the walkable floor under the coin plus 1.0 (the ball centre rides at +0.5), except the air coins past the lips.
    var LAYOUTS = {
        tunnelArc: [[5, 20, 5.92], [5, 28, 5.92], [5, 36, 5.92], [5, 44, 5.81]],   // the ridge of the arch (4.92): a ball lands up there after a gap lip
        tunnelArcLong: [],   // the start tunnel: no coins (the ball starts inside it)
        tunnelRoof: [[5, 14, 5.46], [5, 22, 5.45], [5, 30, 5.43]],   // the centre beam of the stepped death-tunnel roof (4.45 at x 4..6)
        jumpGapMid: [[5.0, 12.5, 3.73], [5.0, 15.1, 3.32]],   // on the lip (top 2.73 at s 12.7, 32.6-degree ramp) and 2.4 past it, inside the band of every trajectory
        jump: [[5.0, 12.5, 2.36], [5.0, 15.3, 1.59]],   // on the lip (top 1.36 at s 12.7, 24-degree ramp) and 2.6 past it
        thin: [[1.7, 15, 1.0], [-1.7, 30, 1.0], [1.7, 45, 1.0], [-1.7, 60, 1.0], [1.7, 74, 1.0]],   // the edges: the ball centre can reach |x| 2.0 on the 5-wide lane
        thinNoJump: [[1.7, 15, 1.0], [-1.7, 30, 1.0], [1.7, 45, 1.0], [-1.7, 60, 1.0], [1.7, 74, 1.0]],   // same lane under the thin switch and the doglegs
        dogleg: [[-4.2, 34, 1.0], [-0.4, 76, 1.0], [4.4, 118, 1.0]],   // the outer corners of the two bends and the crossing, inside the reachable spans
        tiltLeft: [[8.9, 7, 1.22]],   // the uphill side of the regular lane width (the floor there is 0.22); higher needs more than the 16 u/s^2 of steering once zforce passes ~94
        tiltRight: [[1.1, 7, 4.07]]   // mirror: x 1.1 is uphill, floor 3.07
    };
    function laneBlockLayout(key) {        // one block in three: a coin at the very edge of the lane (the ball's centre can reach x 0.5 / 9.5)
        var h = 0; for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        if (h % 3) return [];
        return [[(h >> 2) & 1 ? 0.9 : 9.1, 7, 1.0]];
    }
    function toLocal(x, s, n) { return [x, -R2 * (s + n), -R2 * (s - n)]; }   // lane frame -> the piece's own space (its floor descends along -y,-z)
    var FWD_LOCAL = [0, -R2, -R2], UP_LOCAL = [0, -R2, R2];

    // ------------------------------------------------------------------ small vector helpers
    function m4mulp(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]; }
    function m4mulv(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]; }
    function norm3(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
    function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function fnv(u8, n) { var h = 0x811c9dc5; n = Math.min(n, u8.length); for (var i = 0; i < n; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); }

    // ------------------------------------------------------------------ watching the game's draw calls
    var bufKind = (typeof WeakMap === "function") ? new WeakMap() : null;   // WebGLBuffer -> mesh name
    var pieces = {}, pieceCount = 0, loose = [];       // key -> piece; loose: planted coins (debug)
    var TUNNELS = { tunnelArc: 56.6, tunnelArcLong: 84.8, tunnelRoof: 41, deathTunnel: 42.5 };   // kinds whose span hides lane-block coins
    var tunnelGen = 0, hiddenGen = -1;
    var frame = 0, ballPos = null, ballPrev = null, camVP = null, vpLast = null, o2wLast = null;
    var objectMatrix = new Float32Array(16), viewMatrix = new Float32Array(16);
    var count = 0, collectedTotal = 0, errors = 0, drawnLast = 0, seenKinds = {};
    function state(ctx) { var s = ctx.__slopeCoins; if (!s) { s = ctx.__slopeCoins = { ab: null, attribBuf: {}, vao: null, vaoAttribs: (bufKind ? new WeakMap() : null) }; } return s; }
    function attribTable(s) { if (s.vao && s.vaoAttribs) { var t = s.vaoAttribs.get(s.vao); if (!t) { t = {}; s.vaoAttribs.set(s.vao, t); } return t; } return s.attribBuf; }
    function hookProto(P) {
        if (!P || !P.bufferData || P.__slopeCoinsHooked) return;
        P.__slopeCoinsHooked = true;
        var oBB = P.bindBuffer, oBD = P.bufferData, oVAP = P.vertexAttribPointer, oBVA = P.bindVertexArray, oGUL = P.getUniformLocation, oU4 = P.uniform4fv, oM4 = P.uniformMatrix4fv, oDE = P.drawElements, oDA = P.drawArrays;
        P.bindBuffer = function (target, buf) { if (target === 34962) state(this).ab = buf; return oBB.apply(this, arguments); };
        if (oBVA) P.bindVertexArray = function (vao) { state(this).vao = vao; return oBVA.apply(this, arguments); };
        P.bufferData = function (target, data, usage, srcOffset, length) {
            var r = oBD.apply(this, arguments);
            if (target === 34962 && bufKind && data && typeof data === "object") {
                try {
                    var buf = state(this).ab; if (!buf) return r;
                    var u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                    if (srcOffset) { var el = data.BYTES_PER_ELEMENT || 1; u8 = u8.subarray(srcOffset * el, length ? (srcOffset + length) * el : undefined); }
                    var kind = MESHES[u8.length + "/" + fnv(u8, 256)];
                    if (kind) bufKind.set(buf, kind); else if (bufKind.has(buf)) bufKind.delete(buf);
                } catch (e) { errors++; }
            }
            return r;
        };
        P.vertexAttribPointer = function (index) { var s = state(this); attribTable(s)[index] = s.ab; return oVAP.apply(this, arguments); };
        var oGE = P.getExtension;
        P.getExtension = function (name) {               // WebGL 1 vertex arrays come from an extension object: track its binds too
            var ext = oGE.apply(this, arguments), ctx = this;
            if (ext && /OES_vertex_array_object/i.test(String(name)) && !ext.__slopeCoinsHooked && ext.bindVertexArrayOES) {
                ext.__slopeCoinsHooked = true; var oB = ext.bindVertexArrayOES;
                ext.bindVertexArrayOES = function (vao) { state(ctx).vao = vao; return oB.apply(ext, arguments); };
            }
            return ext;
        };
        P.getUniformLocation = function (program, name) {
            var loc = oGUL.apply(this, arguments);
            if (loc && typeof name === "string") { if (/ObjectToWorld/.test(name)) loc.__coinO2W = true; else if (/MatrixVP/.test(name)) loc.__coinVP = true; }
            return loc;
        };
        function note(loc, v, off) {
            if (!loc || !v || v.length - (off || 0) < 16) return;
            // Reuse transient uploads; pieces and the ball camera own snapshots.
            var a = loc.__coinO2W ? objectMatrix : viewMatrix;
            for (var i = 0; i < 16; i++) a[i] = v[(off || 0) + i];
            if (loc.__coinO2W) o2wLast = a; else vpLast = a;
        }
        P.uniform4fv = function (loc, v, srcOffset) { if (loc && (loc.__coinO2W || loc.__coinVP)) note(loc, v, srcOffset); return oU4.apply(this, arguments); };
        P.uniformMatrix4fv = function (loc, transpose, v, srcOffset) { if (loc && !transpose && (loc.__coinO2W || loc.__coinVP)) note(loc, v, srcOffset); return oM4.apply(this, arguments); };
        function sawDraw(ctx) {
            var m = o2wLast; o2wLast = null;                  // the matrix uploaded for this draw, whatever it draws
            if (!enabled || !bufKind || !m) return;
            var s = state(ctx), tab = attribTable(s), kind = null, buf;
            for (var a in tab) { buf = tab[a]; if (buf && (kind = bufKind.get(buf))) break; }   // the mesh is whichever attribute reads a known vertex buffer (position is not always attribute 0)
            if (!kind && s.ab) kind = bufKind.get(s.ab);
            if (!kind) return;
            if (kind === "ball") {
                ballPrev = ballPos; ballPos = [m[12], m[13], m[14]];
                if (vpLast && Math.hypot(vpLast[3], vpLast[7], vpLast[11]) > 1e-6) { if (!camVP) camVP = new Float32Array(16); camVP.set(vpLast); }   // a perspective matrix: the camera that drew the ball
                return;
            }
            var key = kind + "@" + m[12].toFixed(1) + "," + m[13].toFixed(1) + "," + m[14].toFixed(1);
            var p = pieces[key];
            if (!p) { p = pieces[key] = makePiece(kind, key, m); pieceCount++; seenKinds[kind] = (seenKinds[kind] || 0) + 1; if (TUNNELS[baseKind(kind)]) tunnelGen++; }
            p.seen = frame;
        }
        P.drawElements = function () { try { sawDraw(this); } catch (e) { errors++; } return oDE.apply(this, arguments); };
        P.drawArrays = function () { try { sawDraw(this); } catch (e) { errors++; } return oDA.apply(this, arguments); };
    }
    if (window.WebGLRenderingContext) hookProto(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) hookProto(WebGL2RenderingContext.prototype);

    function makePiece(kind, key, m) {
        var M = new Float32Array(m), base = baseKind(kind), dir = twistDir(kind);
        var layout = (LAYOUTS[base] || (base === "slope" ? laneBlockLayout(key) : [])).map(function (c) { return twisted(c, dir, base); });
        var up = norm3(m4mulv(M, UP_LOCAL)), fwd = norm3(m4mulv(M, FWD_LOCAL)), right = norm3(cross(up, fwd));
        var coins = layout.map(function (c, i) {
            return { wp: m4mulp(M, toLocal(c[0], c[1], c[2])), up: up, fwd: fwd, right: right, phase: (c[1] * 0.37 + c[0] * 0.11 + i) % 6.283, done: 0, popAt: 0 };
        });
        var piece = { kind: kind, key: key, m: M, coins: coins, seen: frame, org: [m[12], m[13], m[14]], up: up, fwd: fwd, right: right, lane: !LAYOUTS[base] };
        if (piece.lane) hiddenGen = -1;    // a new lane block: re-check which edge coins are under a tunnel
        return piece;
    }
    function underTunnel(wp) {             // inside the box of any tunnel piece seen: lane frame 0..length along, 0..10 across, below its roof
        for (var k in pieces) {
            var t = pieces[k], len = TUNNELS[baseKind(t.kind)]; if (!len) continue;
            var d = [wp[0] - t.org[0], wp[1] - t.org[1], wp[2] - t.org[2]];
            var s = d[0] * t.fwd[0] + d[1] * t.fwd[1] + d[2] * t.fwd[2], x = d[0] * t.right[0] + d[1] * t.right[1] + d[2] * t.right[2], n = d[0] * t.up[0] + d[1] * t.up[1] + d[2] * t.up[2];
            if (s >= -1 && s <= len + 1 && x >= -1 && x <= 11 && n < 5) return true;
        }
        return false;
    }
    function refreshHidden() {
        if (hiddenGen === tunnelGen) return;
        hiddenGen = tunnelGen;
        for (var k in pieces) { var p = pieces[k]; if (!p.lane) continue; for (var i = 0; i < p.coins.length; i++) p.coins[i].hidden = p.noCoins || underTunnel(p.coins[i].wp); }
    }

    // ------------------------------------------------------------------ collecting
    var audioCtx = null;
    function chime() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === "suspended") audioCtx.resume();
            var t0 = audioCtx.currentTime, gain = audioCtx.createGain(); gain.connect(audioCtx.destination);
            gain.gain.setValueAtTime(0.0001, t0); gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01); gain.gain.setValueAtTime(0.12, t0 + 0.08); gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);
            var osc = audioCtx.createOscillator(); osc.type = "square"; osc.frequency.setValueAtTime(988, t0); osc.frequency.setValueAtTime(1319, t0 + 0.08);   // B5 then E6, the classic
            osc.connect(gain); osc.start(t0); osc.stop(t0 + 0.45);
        } catch (e) { /* no audio */ }
    }
    var menuBox = null;
    function updateBadge() { /* no separate coin counter: a coin is a point on the game's own score (SlopeMod.addScore) */ }
    function collect(c, now) {
        c.done = 1; c.popAt = now; count++; collectedTotal++;
        if (count > best) { best = count; lsSet(KEY_BEST, best); }
        chime();
        try { if (window.SlopeMod && SlopeMod.addScore) SlopeMod.addScore(1); } catch (e) { errors++; }
    }
    function reset() { pieces = {}; pieceCount = 0; loose = []; count = 0; ballPos = ballPrev = null; }

    // ------------------------------------------------------------------ drawing
    var VS = [
        "attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUV;",
        "uniform mat4 uVP; uniform mat4 uModel; uniform vec3 uLight; uniform vec3 uView; uniform float uScale;",
        "varying vec2 vUV; varying vec3 vLit;",
        "void main() {",
        "  vec3 wp = (uModel * vec4(aPos * uScale, 1.0)).xyz;",
        "  vec3 n = normalize(mat3(uModel) * aNrm);",
        "  float d = max(0.0, dot(n, uLight));",
        "  vec3 h = normalize(uLight + uView);",
        "  float sp = pow(max(0.0, dot(n, h)), 24.0);",
        "  float rim = max(0.0, dot(n, -uLight));",            // the face away from the light still catches the sky a little
        "  float fv = 0.75 + 0.5 * max(0.0, dot(n, uView));",   // faces turned to the camera read brighter: the old vertex-lit look
        "  vLit = vec3(0.85 + 0.65 * d + 0.2 * rim) * fv + sp * vec3(1.3, 1.2, 0.9);",
        "  vUV = aUV; gl_Position = uVP * vec4(wp, 1.0);",
        "}"].join("\n");
    var FS = [
        "precision mediump float; uniform sampler2D uTex; uniform float uAlpha; varying vec2 vUV; varying vec3 vLit;",
        "void main() { vec3 c = texture2D(uTex, vUV).rgb * vLit; gl_FragColor = vec4(c, uAlpha); }"].join("\n");
    var res = null, mesh = null, meshLoading = false, texImg = null;
    function loadMesh() {
        if (mesh || meshLoading) return;
        meshLoading = true;
        try {
            var xhr = new XMLHttpRequest(); xhr.open("GET", ASSET_DIR + "coin.json", true);
            xhr.onload = function () { try { if (xhr.status >= 200 && xhr.status < 300) mesh = JSON.parse(xhr.responseText); else warn("coin.json: HTTP " + xhr.status); } catch (e) { warn("coin.json: " + e); } };
            xhr.onerror = function () { warn("coin.json failed to load"); };
            xhr.send();
            var img = new Image(); img.onload = function () { texImg = img; if (res && res.tex) res.texDirty = true; }; img.src = ASSET_DIR + "coin.png";
        } catch (e) { warn("assets: " + e); }
    }
    function compile(g, gl, type, src) {
        var sh = g.createShader(type); g.shaderSource(sh, src); g.compileShader(sh);
        if (!g.getShaderParameter(sh, gl.COMPILE_STATUS)) { warn("shader: " + g.getShaderInfoLog(sh)); g.deleteShader(sh); return null; }
        return sh;
    }
    function ensureResources(h) {
        var g = h.g, gl = h.gl;
        if (res && res.gl === gl && !res.failed) return res.ok;
        if (!mesh) return false;
        res = { gl: gl, ok: false, failed: false };
        try {
            var vs = compile(g, gl, gl.VERTEX_SHADER, VS), fs = compile(g, gl, gl.FRAGMENT_SHADER, FS);
            if (!vs || !fs) { res.failed = true; return false; }
            var prog = g.createProgram(); g.attachShader(prog, vs); g.attachShader(prog, fs);
            g.bindAttribLocation(prog, 0, "aPos"); g.bindAttribLocation(prog, 1, "aNrm"); g.bindAttribLocation(prog, 2, "aUV");
            g.linkProgram(prog);
            if (!g.getProgramParameter(prog, gl.LINK_STATUS)) { warn("program: " + g.getProgramInfoLog(prog)); res.failed = true; return false; }
            res.prog = prog; res.u = {};
            ["uVP", "uModel", "uLight", "uView", "uScale", "uTex", "uAlpha"].forEach(function (n) { res.u[n] = g.getUniformLocation(prog, n); });
            var nv = mesh.p.length / 3, inter = new Float32Array(nv * 8);
            for (var i = 0; i < nv; i++) { inter[i * 8] = mesh.p[i * 3]; inter[i * 8 + 1] = mesh.p[i * 3 + 1]; inter[i * 8 + 2] = mesh.p[i * 3 + 2]; inter[i * 8 + 3] = mesh.n[i * 3]; inter[i * 8 + 4] = mesh.n[i * 3 + 1]; inter[i * 8 + 5] = mesh.n[i * 3 + 2]; inter[i * 8 + 6] = mesh.t[i * 2]; inter[i * 8 + 7] = mesh.t[i * 2 + 1]; }
            res.vbo = g.createBuffer(); g.bindBuffer(gl.ARRAY_BUFFER, res.vbo); g.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
            res.ibo = g.createBuffer(); res.indexCount = mesh.i.length;
            // vertex state in a vertex array object of our own when the game's context has them, else set up per draw
            res.vao = null;
            if (h.vaoMode === "gl2") { res.vao = g.createVertexArray(); g.bindVertexArray(res.vao); }
            else if (h.vaoMode === "oes") { res.vao = h.vaoExt.createVertexArrayOES(); h.vaoExt.bindVertexArrayOES(res.vao); }
            g.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.ibo); g.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.i), gl.STATIC_DRAW);
            setPointers(g, gl);
            if (h.vaoMode === "gl2") g.bindVertexArray(null); else if (h.vaoMode === "oes") h.vaoExt.bindVertexArrayOES(null);
            res.tex = g.createTexture(); g.bindTexture(gl.TEXTURE_2D, res.tex);
            g.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([226, 176, 7, 255]));
            g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            res.texDirty = !!texImg;
            res.ok = true;
        } catch (e) { warn("resources: " + e); res.failed = true; errors++; }
        return res.ok;
    }
    function setPointers(g, gl) {
        g.bindBuffer(gl.ARRAY_BUFFER, res.vbo);
        g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
        g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
        g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    }
    var LIGHT = norm3([0.35, 0.8, -0.45]);
    var NEAR_SKIP = 2.2;
    function cameraPos(vp) {               // VP = P * V: V's rows 0..2 are VP's rows 0, 1 scaled and minus row 3; the eye is -R^T t
        var r = [[vp[0], vp[4], vp[8], vp[12]], [vp[1], vp[5], vp[9], vp[13]], [-vp[3], -vp[7], -vp[11], -vp[15]]];
        for (var i = 0; i < 2; i++) { var l = Math.hypot(r[i][0], r[i][1], r[i][2]); if (l < 1e-6) return null; r[i] = r[i].map(function (v) { return v / l; }); }
        return [-(r[0][0] * r[0][3] + r[1][0] * r[1][3] + r[2][0] * r[2][3]), -(r[0][1] * r[0][3] + r[1][1] * r[1][3] + r[2][1] * r[2][3]), -(r[0][2] * r[0][3] + r[1][2] * r[1][3] + r[2][2] * r[2][3])];
    }
    var model = new Float32Array(16);
    function liveCoins(now) {
        var out = [];
        refreshHidden();
        for (var k in pieces) { var p = pieces[k]; for (var i = 0; i < p.coins.length; i++) { var c = p.coins[i]; if (!c.hidden && (!c.done || now - c.popAt < POP_MS)) out.push(c); } }
        for (var j = 0; j < loose.length; j++) { var l = loose[j]; if (!l.done || now - l.popAt < POP_MS) out.push(l); }
        return out;
    }
    function onScene(h) {
        frame++;
        var now = performance.now();
        if (!enabled) { drawnLast = 0; return; }
        // expire the pieces the game stopped drawing (passed, or despawned); a teleporting ball is a restart
        for (var k in pieces) if (frame - pieces[k].seen > EXPIRE_FRAMES) { if (TUNNELS[baseKind(pieces[k].kind)]) tunnelGen++; delete pieces[k]; pieceCount--; }
        if (ballPos && ballPrev && Math.hypot(ballPos[0] - ballPrev[0], ballPos[1] - ballPrev[1], ballPos[2] - ballPrev[2]) > 20) { var keep = ballPos; reset(); ballPos = keep; }
        var list = liveCoins(now);
        if (ballPos) {
            for (var i = 0; i < list.length; i++) {
                var c = list[i]; if (c.done) continue;
                var d = Math.hypot(c.wp[0] - ballPos[0], c.wp[1] - ballPos[1], c.wp[2] - ballPos[2]);
                if (d < PICK_RADIUS) collect(c, now);
            }
        }
        updateBadge();
        drawnLast = 0;
        if (!list.length || !camVP) return;
        if (window.SlopeMod && SlopeMod.overMenu && SlopeMod.overMenu()) return;   // the game-over screen stays empty
        loadMesh();
        if (!ensureResources(h)) return;
        var g = h.g, gl = h.gl;
        var keep = saveExtra(g, gl, h);
        try { drawCoins(h, g, gl, list, now); } finally { restoreExtra(g, gl, h, keep); }
    }
    // SlopeShaders.onScene saves program, framebuffers, buffers, textures, vertex arrays, viewport and the enable
    // bits around the hook; the rest of what the coins touch is kept here (the game caches GL state)
    function saveExtra(g, gl, h) {
        var k = { depthFunc: g.getParameter(gl.DEPTH_FUNC), depthMask: g.getParameter(gl.DEPTH_WRITEMASK), cullMode: g.getParameter(gl.CULL_FACE_MODE), front: g.getParameter(gl.FRONT_FACE),
            bsrc: g.getParameter(gl.BLEND_SRC_RGB), bdst: g.getParameter(gl.BLEND_DST_RGB), bsrcA: g.getParameter(gl.BLEND_SRC_ALPHA), bdstA: g.getParameter(gl.BLEND_DST_ALPHA),
            flipY: g.getParameter(gl.UNPACK_FLIP_Y_WEBGL), premul: g.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), elementBuf: null, attribs: null };
        if (!res.vao) {   // no vertex array objects: attribute pointers 1 and 2 are global state the game may rely on
            k.elementBuf = g.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING); k.attribs = [];
            for (var a = 1; a <= 2; a++) k.attribs.push({ en: g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_ENABLED), buf: g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING), size: g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_SIZE), type: g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_TYPE), norm: g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED), stride: g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_STRIDE), off: g.getVertexAttribOffset(a, gl.VERTEX_ATTRIB_ARRAY_POINTER) });
        }
        return k;
    }
    function restoreExtra(g, gl, h, k) {
        g.depthFunc(k.depthFunc); g.depthMask(k.depthMask); g.cullFace(k.cullMode); g.frontFace(k.front);
        g.blendFuncSeparate(k.bsrc, k.bdst, k.bsrcA, k.bdstA);
        g.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, k.flipY); g.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, k.premul);
        if (k.attribs) {
            for (var a = 1; a <= 2; a++) { var s = k.attribs[a - 1]; if (s.buf) { g.bindBuffer(gl.ARRAY_BUFFER, s.buf); g.vertexAttribPointer(a, s.size, s.type, s.norm, s.stride, s.off); } if (s.en) g.enableVertexAttribArray(a); else g.disableVertexAttribArray(a); }
            g.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, k.elementBuf);
        }
    }
    function drawCoins(h, g, gl, list, now) {
        g.useProgram(res.prog);
        if (res.vao) { if (h.vaoMode === "gl2") g.bindVertexArray(res.vao); else h.vaoExt.bindVertexArrayOES(res.vao); }
        else { setPointers(g, gl); g.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.ibo); }
        g.activeTexture(gl.TEXTURE0); g.bindTexture(gl.TEXTURE_2D, res.tex);
        if (res.texDirty && texImg) { try { g.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); g.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); g.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texImg); } catch (e) { errors++; } res.texDirty = false; }
        g.uniform1i(res.u.uTex, 0);
        g.uniformMatrix4fv(res.u.uVP, false, camVP);
        var back = norm3([-camVP[3], -camVP[7], -camVP[11]]);       // the camera's back axis is minus the last row of VP
        var eye = cameraPos(camVP);
        g.uniform3f(res.u.uLight, LIGHT[0], LIGHT[1], LIGHT[2]); g.uniform3f(res.u.uView, back[0], back[1], back[2]);
        g.enable(gl.DEPTH_TEST); g.depthFunc(gl.LESS); g.depthMask(true);
        g.enable(gl.CULL_FACE); g.cullFace(gl.BACK); g.frontFace(gl.CCW);
        g.disable(gl.SCISSOR_TEST); g.disable(gl.STENCIL_TEST); g.colorMask(true, true, true, true);
        g.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); g.disable(gl.BLEND);
        var t = now / 1000, blending = false;
        for (var j = 0; j < list.length; j++) {
            var c = list[j], th = t * SPIN * 6.2831853 + c.phase, cs = Math.cos(th), sn = Math.sin(th);
            if (eye && Math.hypot(c.wp[0] - eye[0], c.wp[1] - eye[1], c.wp[2] - eye[2]) < NEAR_SKIP) continue;   // a coin at the camera would be cut by the near plane
            var pop = c.done ? Math.min(1, (now - c.popAt) / POP_MS) : 0, scale = 1 + pop * 1.3, lift = BOB * Math.sin(t * 5 + c.phase) + pop * 0.9;
            var rt = c.right, fw = c.fwd, up = c.up;
            model[0] = cs * rt[0] + sn * fw[0]; model[1] = cs * rt[1] + sn * fw[1]; model[2] = cs * rt[2] + sn * fw[2]; model[3] = 0;     // the disc's x: swings between across and along the lane
            model[4] = up[0]; model[5] = up[1]; model[6] = up[2]; model[7] = 0;                                                       // the disc's y: up
            model[8] = -sn * rt[0] + cs * fw[0]; model[9] = -sn * rt[1] + cs * fw[1]; model[10] = -sn * rt[2] + cs * fw[2]; model[11] = 0;   // the face normal
            model[12] = c.wp[0] + up[0] * lift; model[13] = c.wp[1] + up[1] * lift; model[14] = c.wp[2] + up[2] * lift; model[15] = 1;
            if (c.done !== blending) { blending = !!c.done; if (blending) { g.enable(gl.BLEND); g.depthMask(false); } else { g.disable(gl.BLEND); g.depthMask(true); } }
            g.uniformMatrix4fv(res.u.uModel, false, model);
            g.uniform1f(res.u.uScale, scale); g.uniform1f(res.u.uAlpha, 1 - pop);
            g.drawElements(gl.TRIANGLES, res.indexCount, gl.UNSIGNED_SHORT, 0);
            drawnLast++;
        }
        if (res.vao) { if (h.vaoMode === "gl2") g.bindVertexArray(null); else h.vaoExt.bindVertexArrayOES(null); }
    }
    function register() {
        if (window.SlopeShaders && SlopeShaders.onScene) { SlopeShaders.onScene(onScene); return true; }
        return false;
    }
    if (!register()) warn("shaders.js is not loaded before coins.js; coins cannot draw");

    // ------------------------------------------------------------------ settings and API
    function setEnabled(on) {
        enabled = !!on; lsSet(KEY_ON, enabled);
        if (!enabled) { pieces = {}; pieceCount = 0; loose = []; count = 0; }
        if (!menuBox) menuBox = document.getElementById("hud-coins");
        if (menuBox && menuBox.checked !== enabled) menuBox.checked = enabled;
        updateBadge();
    }
    function wireHud() {
        menuBox = document.getElementById("hud-coins");
        if (menuBox) { menuBox.checked = enabled; menuBox.addEventListener("change", function () { setEnabled(menuBox.checked); }); }
        updateBadge();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireHud); else wireHud();
    window.SlopeCoins = {
        enabled: function () { return enabled; },
        setEnabled: setEnabled,
        count: function () { return count; },
        best: function () { return best; },
        reset: reset,
        ballPos: function () { return ballPos ? ballPos.slice() : null; },
        pieces: function () { return Object.keys(pieces).map(function (k) { var p = pieces[k]; return { kind: p.kind, pos: [p.m[12], p.m[13], p.m[14]].map(function (v) { return +v.toFixed(1); }), coins: p.coins.length, left: p.coins.filter(function (c) { return !c.done; }).length, age: frame - p.seen }; }); },
        plant: function (x, y, z) {        // debug/test: a loose coin at a world position (standing like a lane coin)
            var up = [0, R2, R2], fwd = [0, -R2, R2];
            loose.push({ wp: [x, y, z], up: up, fwd: fwd, right: norm3(cross(up, fwd)), phase: 0, done: 0, popAt: 0 }); return loose.length;
        },
        layouts: LAYOUTS,
        frames: function () {              // every live piece with its lane frame (for TemplateData/ramps.js): origin, fwd, up, right in world space
            var out = []; for (var k in pieces) { var p = pieces[k]; out.push({ key: k, kind: p.kind, lane: p.lane, org: p.org, fwd: p.fwd, up: p.up, right: p.right, hidden: !!p.noCoins }); } return out;
        },
        camera: function () { return camVP ? Array.prototype.slice.call(camVP) : null; },
        underTunnel: underTunnel,          // world point inside a tunnel piece's span
        muteBlock: function (key) {        // a super ramp stands on this block: its edge coin goes away
            var p = pieces[key]; if (!p) return; p.noCoins = true; for (var i = 0; i < p.coins.length; i++) p.coins[i].hidden = true;
        },
        matrices: function () {            // debug/test: one object-to-world matrix per piece kind (the first piece seen of each)
            var out = {}; for (var k in pieces) { var p = pieces[k]; if (!out[p.kind]) out[p.kind] = Array.prototype.slice.call(p.m); } return out;
        },
        coins: function () {               // debug/test: every live coin with its world position
            var out = [], b = ballPos; refreshHidden(); for (var k in pieces) pieces[k].coins.forEach(function (c) { out.push({ kind: pieces[k].kind, wp: c.wp.map(function (v) { return +v.toFixed(2); }), done: c.done, hidden: !!c.hidden, dist: b ? +Math.hypot(c.wp[0] - b[0], c.wp[1] - b[1], c.wp[2] - b[2]).toFixed(2) : null }); }); return out;
        },
        stats: function () {
            var total = 0, left = 0; for (var k in pieces) { total += pieces[k].coins.length; left += pieces[k].coins.filter(function (c) { return !c.done; }).length; }
            return { enabled: enabled, frame: frame, pieces: pieceCount, coins: total, left: left, loose: loose.length, count: count, best: best, collectedTotal: collectedTotal, drawn: drawnLast, errors: errors, mesh: !!mesh, texture: !!texImg, gl: !!(res && res.ok), ball: ballPos ? ballPos.map(function (v) { return +v.toFixed(2); }) : null, camera: !!camVP, eye: camVP ? cameraPos(camVP).map(function (v) { return +v.toFixed(2); }) : null, kinds: seenKinds };
        }
    };
})();
