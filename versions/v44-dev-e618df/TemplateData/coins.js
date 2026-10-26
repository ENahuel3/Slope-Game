/* Slope mod: collectable 3D coins (loaded after shaders.js, before mod.js).
 *
 * The coins sit on the course's own pieces in the places that are hard to reach: on the roof of the tunnels, in the
 * air over the jump gaps, at the edges of the thin lanes, on the high side of the tilted lanes, at the outer corners
 * of the doglegs, and at the very edge of some lane blocks. Nothing in the scene data is changed for them.
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
        "720/9ad72440": "slopeTwistP",      // the mod's helicoid blocks (tools/patch_roll.py)
        "720/2d1cf952": "slopeTwistN",
        "560/8c0596f5": "tiltLeft",         // slopeWideTiltLeft: the wide lane tilted up on the right
        "560/75ca3d9b": "tiltRight",        // slopeWideTiltRight: tilted up on the left
        "28840/9cb76e50": "ball"            // Sphere
    };
    var LENGTH = { tunnelArc: 56.6, tunnelArcLong: 84.8, tunnelRoof: 41, deathTunnel: 42.5, jump: 42.4, jumpGapMid: 42.4, thin: 78, thinNoJump: 78, dogleg: 151, slope: 14.1, slopeTwistP: 14.1, slopeTwistN: 14.1, tiltLeft: 14.1, tiltRight: 14.1 };

    // ------------------------------------------------------------------ layouts: [x, s, n] per piece, in its lane frame
    // x across the lane (the lane blocks span 0..10), s along the course from the piece's origin, n above its floor.
    // Heights are the floor or roof height under the coin plus 1.0, so a ball riding there runs through the coin.
    var LAYOUTS = {
        tunnelArc: [[5, 20, 5.9], [5, 28, 5.9], [5, 36, 5.9], [5, 44, 5.9]],           // the ridge of the arch (roof at 4.9)
        tunnelRoof: [[5, 14, 5.5], [5, 22, 5.5], [5, 30, 5.5]],                        // the beam on top of the stepped roof (4.5)
        jumpGapMid: [[5, 18, 5.0], [5, 24, 5.6], [5, 30, 5.0]],                        // high over the gap: off the 2.8 lip, only a fast ball flies this high
        jump: [[5, 18, 4.0], [5, 24, 4.4]],                                            // high off the 1.4 lip (a slow ball peaks at 2.6, 15 along)
        thin: [[1.9, 15, 1], [-1.9, 30, 1], [1.9, 45, 1], [-1.5, 60, 1], [1.9, 75, 1]],   // the edges of the 5-wide lane (4.5 wide after s 43)
        thinNoJump: [[1.9, 15, 1], [-1.9, 30, 1], [1.9, 45, 1], [-1.5, 60, 1], [1.9, 75, 1]],
        dogleg: [[-4.3, 34, 1], [-0.2, 73, 1], [4.5, 118, 1]],                         // the outer corners of the two bends, and the crossing
        tiltLeft: [[15.3, 7, 4.0]],                                                    // the high edge (floor at 3.0)
        tiltRight: [[1.2, 7, 4.1]]
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
    var frame = 0, ballPos = null, ballPrev = null, camVP = null, vpLast = null, o2wLast = null;
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
            var a = new Float32Array(16); for (var i = 0; i < 16; i++) a[i] = v[(off || 0) + i];
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
                if (vpLast && Math.hypot(vpLast[3], vpLast[7], vpLast[11]) > 1e-6) camVP = vpLast;   // a perspective matrix: the camera that drew the ball
                return;
            }
            var key = kind + "@" + m[12].toFixed(1) + "," + m[13].toFixed(1) + "," + m[14].toFixed(1);
            var p = pieces[key];
            if (!p) { p = pieces[key] = makePiece(kind, key, m); pieceCount++; seenKinds[kind] = (seenKinds[kind] || 0) + 1; }
            p.seen = frame;
        }
        P.drawElements = function () { try { sawDraw(this); } catch (e) { errors++; } return oDE.apply(this, arguments); };
        P.drawArrays = function () { try { sawDraw(this); } catch (e) { errors++; } return oDA.apply(this, arguments); };
    }
    if (window.WebGLRenderingContext) hookProto(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) hookProto(WebGL2RenderingContext.prototype);

    function makePiece(kind, key, m) {
        var M = new Float32Array(m), layout = LAYOUTS[kind] || ((kind === "slope" || kind === "slopeTwistP" || kind === "slopeTwistN") ? laneBlockLayout(key) : []);
        var up = norm3(m4mulv(M, UP_LOCAL)), fwd = norm3(m4mulv(M, FWD_LOCAL)), right = norm3(cross(up, fwd));
        var coins = layout.map(function (c, i) {
            return { wp: m4mulp(M, toLocal(c[0], c[1], c[2])), up: up, fwd: fwd, right: right, phase: (c[1] * 0.37 + c[0] * 0.11 + i) % 6.283, done: 0, popAt: 0 };
        });
        return { kind: kind, key: key, m: M, coins: coins, seen: frame };
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
    var badge = null, menuBox = null;
    function updateBadge() {
        if (!badge) badge = document.getElementById("hud-coin-count");
        if (!badge) return;
        var txt = enabled ? "🪙 " + count : "";
        if (badge.textContent !== txt) badge.textContent = txt;
        badge.title = "Coins this run" + (best ? " · best " + best : "");
        badge.classList.toggle("on", enabled && (count > 0 || !!ballPos));
    }
    function collect(c, now) {
        c.done = 1; c.popAt = now; count++; collectedTotal++;
        if (count > best) { best = count; lsSet(KEY_BEST, best); }
        chime(); updateBadge();
    }
    function reset() { pieces = {}; pieceCount = 0; loose = []; count = 0; ballPos = ballPrev = null; updateBadge(); }

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
        for (var k in pieces) { var p = pieces[k]; for (var i = 0; i < p.coins.length; i++) { var c = p.coins[i]; if (!c.done || now - c.popAt < POP_MS) out.push(c); } }
        for (var j = 0; j < loose.length; j++) { var l = loose[j]; if (!l.done || now - l.popAt < POP_MS) out.push(l); }
        return out;
    }
    function onScene(h) {
        frame++;
        var now = performance.now();
        if (!enabled) { drawnLast = 0; return; }
        // expire the pieces the game stopped drawing (passed, or despawned); a teleporting ball is a restart
        for (var k in pieces) if (frame - pieces[k].seen > EXPIRE_FRAMES) { delete pieces[k]; pieceCount--; }
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
        menuBox = document.getElementById("hud-coins"); badge = document.getElementById("hud-coin-count");
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
        coins: function () {               // debug/test: every live coin with its world position
            var out = [], b = ballPos; for (var k in pieces) pieces[k].coins.forEach(function (c) { out.push({ kind: pieces[k].kind, wp: c.wp.map(function (v) { return +v.toFixed(2); }), done: c.done, dist: b ? +Math.hypot(c.wp[0] - b[0], c.wp[1] - b[1], c.wp[2] - b[2]).toFixed(2) : null }); }); return out;
        },
        stats: function () {
            var total = 0, left = 0; for (var k in pieces) { total += pieces[k].coins.length; left += pieces[k].coins.filter(function (c) { return !c.done; }).length; }
            return { enabled: enabled, frame: frame, pieces: pieceCount, coins: total, left: left, loose: loose.length, count: count, best: best, collectedTotal: collectedTotal, drawn: drawnLast, errors: errors, mesh: !!mesh, texture: !!texImg, gl: !!(res && res.ok), ball: ballPos ? ballPos.map(function (v) { return +v.toFixed(2); }) : null, camera: !!camVP, eye: camVP ? cameraPos(camVP).map(function (v) { return +v.toFixed(2); }) : null, kinds: seenKinds };
        }
    };
})();
