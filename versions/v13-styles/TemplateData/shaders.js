/* Slope mod: shader system. Post-processing of the game's finished frame.
 *
 * The game draws into the canvas's default framebuffer. Every
 * requestAnimationFrame callback is wrapped, so after Unity's frame
 * callback returns (and before the browser composites the canvas) the
 * finished frame is copied into a texture and run through the selected
 * style's chain of full-screen passes; the last pass draws back onto the
 * canvas. The game's own shaders are not touched. (The previous system
 * rewrote every fragment shader at compile time: it could only recolour
 * pixels, failed per shader, uploaded a uniform before every draw call and
 * could not be changed once the shaders were compiled.) Unity caches GL
 * state and skips redundant calls, so every piece of state the passes use
 * is saved before and restored after them.
 *
 * A style is a list of passes (STYLES below): each names a fragment shader
 * (FRAG), the buffer it reads ("scene" is the captured frame, "a"/"b" are
 * full-size, "h1"/"h2" half-size), an optional second input, where it
 * writes ("screen" is the canvas), and parameters. The GLSL is ES 1.00 so
 * it runs on WebGL 1 and 2. A compile or link failure disables that style
 * (the game keeps rendering untouched) and is counted in stats(). The
 * raw GL entry points are captured here, before mod.js wraps the same
 * prototypes to count the game's draw calls, so the passes are invisible
 * to it. Load order: this file before mod.js, both before the loader.
 *
 * Page API (window.SlopeShaders): styles(), style(), setStyle(id), next(),
 * intensity(), setIntensity(0..1), enabled(), setEnabled(b), define(id,
 * {name, passes}), stats(). The HUD's Style select / FX slider and the V
 * key are wired here. Settings persist in localStorage.
 */
(function () {
    "use strict";

    var KEY_STYLE = "slope-mod.style", KEY_FX = "slope-mod.fx", KEY_RAINBOW_OLD = "slope-mod.rainbow";
    var HUE_PERIOD = 3.5;         // seconds per rainbow cycle (what the old system did at 60 fps)
    var SPEED_REF = 40;           // ball speed (units/s, from SlopeMod.speed()) that counts as "fast" for speed-driven effects
    var ERROR_CHECK_EVERY = 60;   // frames between glGetError polls (each one is a round trip)

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }
    function warn(msg) { if (window.console) console.warn("[slope-shaders] " + msg); }

    // ======================================================================
    // Raw GL entry points, captured before anything else wraps the prototypes
    // ======================================================================
    function captureRaw(P) {
        var o = {};
        if (!P) return o;
        Object.getOwnPropertyNames(P).forEach(function (n) {
            var d = Object.getOwnPropertyDescriptor(P, n);
            if (d && typeof d.value === "function") o[n] = d.value;
        });
        return o;
    }
    var RAW1 = captureRaw(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    var RAW2 = captureRaw(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    function bindRaw(ctx) {
        var raw = (window.WebGL2RenderingContext && ctx instanceof WebGL2RenderingContext) ? RAW2 : RAW1, g = {};
        Object.keys(raw).forEach(function (n) { var fn = raw[n]; g[n] = function () { return fn.apply(ctx, arguments); }; });
        return g;
    }

    // ======================================================================
    // GLSL
    // ======================================================================
    var VERT = [
        "attribute vec2 aPos;",
        "varying vec2 vUv;",
        "void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }"
    ].join("\n");

    var HEAD = [
        "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif",
        "varying vec2 vUv;",
        "uniform sampler2D uTex;",     // the pass's input
        "uniform sampler2D uTex2;",    // optional second input (bloom)
        "uniform vec2 uRes;",          // output size in pixels
        "uniform vec2 uTexel;",        // 1 / input size
        "uniform float uTime;",        // seconds
        "uniform float uHue;",         // 0..1, cycles every HUE_PERIOD
        "uniform float uSpeed;",       // 0..1, ball speed
        "uniform float uAmount;",      // style intensity 0..1
        "uniform vec4 uP;",            // pass parameters
        "uniform vec4 uQ;",            // more pass parameters
        "float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }",
        "vec3 rgb2hsv(vec3 c) {",
        "  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);",
        "  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));",
        "  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));",
        "  float d = q.x - min(q.w, q.y); float e = 1.0e-10;",
        "  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);",
        "}",
        "vec3 hsv2rgb(vec3 c) {",
        "  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);",
        "  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);",
        "  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);",
        "}",
        "float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }",
        // the green neon of the track, which the colour styles recolour; red (the obstacles) is left alone
        "float greenness(vec3 c) {",
        "  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn;",
        "  if (mx <= 0.0 || d < 0.03 * mx) return 0.0;",
        "  float h; if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;",
        "  return 1.0 - smoothstep(0.7, 1.1, abs(h - 2.0));",
        "}"
    ].join("\n");

    var FRAG = {
        // The original rainbow: green-hued pixels get their hue replaced by a diagonal rainbow
        // that scrolls with time and ripples with a travelling wave. Everything else keeps its colour.
        rainbow: [
            "void main() {",
            "  vec3 c = texture2D(uTex, vUv).rgb; vec3 r = c;",
            "  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn;",
            "  if (mx > 0.0 && d >= 0.03 * mx) {",
            "    float h; if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;",
            "    if (abs(h - 2.0) <= 0.9) {",
            "      float band = vUv.x * 1.4 + vUv.y * 0.8;",
            "      float wave = 0.22 * sin(vUv.y * 7.0 - uTime * 2.6) + 0.12 * sin(vUv.x * 11.0 + uTime * 1.7);",
            "      float H = mod((uHue + band + wave) * 6.0 + (h - 2.0), 6.0);",
            "      float C = d; float X = C * (1.0 - abs(mod(H, 2.0) - 1.0)); float m = mx - C; vec3 o;",
            "      if (H < 1.0) o = vec3(C, X, 0.0); else if (H < 2.0) o = vec3(X, C, 0.0); else if (H < 3.0) o = vec3(0.0, C, X);",
            "      else if (H < 4.0) o = vec3(0.0, X, C); else if (H < 5.0) o = vec3(X, 0.0, C); else o = vec3(C, 0.0, X);",
            "      r = mix(c, o + m, uAmount);",
            "    }",
            "  }",
            "  gl_FragColor = vec4(r, 1.0);",
            "}"
        ].join("\n"),

        // Colour grading. uP.x selects: 1 synthwave (greens to magenta/cyan, purple shadows),
        // 2 noir (grey with the reds kept), 3 matrix (green phosphor with the reds kept).
        grade: [
            "void main() {",
            "  vec3 c = texture2D(uTex, vUv).rgb; vec3 o = c;",
            "  float g = greenness(c); float red = smoothstep(0.15, 0.4, c.r - max(c.g, c.b));",
            "  if (uP.x < 1.5) {",
            "    vec3 h = rgb2hsv(c);",
            "    float nh = mix(0.56, 0.88, clamp(vUv.y * 1.3 - 0.1, 0.0, 1.0)) + 0.03 * sin(uTime * 0.7 + vUv.x * 4.0);",
            "    vec3 neon = hsv2rgb(vec3(nh, min(1.0, h.y * 1.25), min(1.0, h.z * 1.12)));",
            "    vec3 tinted = mix(c, c * vec3(1.08, 0.86, 1.22) + vec3(0.02, 0.0, 0.05), 0.45);",
            "    o = mix(tinted, neon, g);",
            "  } else if (uP.x < 2.5) {",
            "    float y = lum(c); y = clamp((y - 0.5) * 1.3 + 0.5, 0.0, 1.0);",
            "    o = mix(vec3(y), c * vec3(1.15, 0.9, 0.9), red);",
            "  } else {",
            "    float y = pow(lum(c), 0.85); float q = floor(y * 14.0 + 0.5) / 14.0;",
            "    o = vec3(0.04, 1.0, 0.28) * mix(y, q, 0.6) + vec3(0.0, 0.03, 0.0);",
            "    o = mix(o, c * vec3(1.2, 0.95, 0.9), red);",
            "  }",
            "  gl_FragColor = vec4(mix(c, o, uAmount * uP.y), 1.0);",
            "}"
        ].join("\n"),

        // Bloom threshold: keeps what is bright or saturated (the neon), written at half size.
        bright: [
            "void main() {",
            "  vec3 c = texture2D(uTex, vUv).rgb;",
            "  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b));",
            "  float w = smoothstep(uP.x, uP.x + 0.3, max(lum(c), (mx - mn) * 0.9));",
            "  gl_FragColor = vec4(c * w, 1.0);",
            "}"
        ].join("\n"),

        // 9-tap gaussian along uP.xy, radius uP.z texels.
        blur: [
            "void main() {",
            "  vec2 d = uP.xy * uTexel * uP.z;",
            "  vec3 c = texture2D(uTex, vUv).rgb * 0.2270;",
            "  c += (texture2D(uTex, vUv + d).rgb + texture2D(uTex, vUv - d).rgb) * 0.1946;",
            "  c += (texture2D(uTex, vUv + d * 2.0).rgb + texture2D(uTex, vUv - d * 2.0).rgb) * 0.1216;",
            "  c += (texture2D(uTex, vUv + d * 3.0).rgb + texture2D(uTex, vUv - d * 3.0).rgb) * 0.0540;",
            "  c += (texture2D(uTex, vUv + d * 4.0).rgb + texture2D(uTex, vUv - d * 4.0).rgb) * 0.0162;",
            "  gl_FragColor = vec4(c, 1.0);",
            "}"
        ].join("\n"),

        // Screen finish: scene + bloom (uTex2) * uP.x, chromatic aberration uP.y, vignette uP.z,
        // scanlines uP.w, film grain uQ.x, saturation boost uQ.y.
        finish: [
            "void main() {",
            "  vec2 off = (vUv - 0.5) * uP.y * 0.012;",
            "  vec3 c = vec3(texture2D(uTex, vUv + off).r, texture2D(uTex, vUv).g, texture2D(uTex, vUv - off).b);",
            "  vec3 orig = texture2D(uTex, vUv).rgb;",
            "  c += texture2D(uTex2, vUv).rgb * uP.x;",
            "  if (uQ.y > 0.0) { float y = lum(c); c = mix(vec3(y), c, 1.0 + uQ.y); }",
            "  float v = length((vUv - 0.5) * vec2(1.0, uRes.y / max(uRes.x, 1.0)) * 2.0);",
            "  c *= 1.0 - uP.z * smoothstep(0.45, 1.25, v);",
            "  c *= 1.0 - uP.w * 0.45 * (0.5 + 0.5 * sin(vUv.y * uRes.y * 3.14159));",
            "  c += (hash(vUv * uRes + fract(uTime) * 100.0) - 0.5) * uQ.x;",
            "  gl_FragColor = vec4(mix(orig, clamp(c, 0.0, 1.0), uAmount), 1.0);",
            "}"
        ].join("\n"),

        // CRT: barrel curvature uP.x, scanlines uP.y, phosphor mask uP.z, vignette uP.w.
        crt: [
            "void main() {",
            "  vec2 q = vUv * 2.0 - 1.0; q *= 1.0 + uP.x * dot(q, q); vec2 uv = q * 0.5 + 0.5;",
            "  vec3 orig = texture2D(uTex, vUv).rgb; vec3 c = vec3(0.0);",
            "  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {",
            "    vec2 off = (uv - 0.5) * 0.004;",
            "    c = vec3(texture2D(uTex, uv + off).r, texture2D(uTex, uv).g, texture2D(uTex, uv - off).b);",
            "    float line = 0.5 + 0.5 * sin(uv.y * uRes.y * 3.14159);",
            "    c *= 1.0 - uP.y * 0.5 * line;",
            "    float m = mod(gl_FragCoord.x, 3.0); vec3 mask = m < 1.0 ? vec3(1.0, 0.7, 0.7) : (m < 2.0 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0));",
            "    c *= mix(vec3(1.0), mask, uP.z);",
            "    float v = length((uv - 0.5) * 2.0); c *= 1.0 - uP.w * smoothstep(0.6, 1.5, v);",
            "    c *= 1.0 + 0.25 * (uP.y + uP.z);",
            "    float edge = smoothstep(0.0, 0.02, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y))); c *= edge;",
            "  }",
            "  gl_FragColor = vec4(mix(orig, clamp(c, 0.0, 1.0), uAmount), 1.0);",
            "}"
        ].join("\n"),

        // Hyperspeed: radial blur from the centre, strength uP.x scaled by the ball's speed,
        // chromatic split uP.y, with a faint colour pulse at speed.
        radial: [
            "void main() {",
            "  vec2 dir = vUv - 0.5; float s = uP.x * (0.2 + 0.8 * uSpeed);",
            "  vec3 orig = texture2D(uTex, vUv).rgb; vec3 c = vec3(0.0);",
            "  for (int i = 0; i < 12; i++) { float k = float(i) / 12.0; c += texture2D(uTex, vUv - dir * s * k).rgb * (1.0 - k * 0.5); }",
            "  c /= 7.25;",
            "  vec2 off = dir * uP.y * 0.02 * uSpeed;",
            "  c = vec3(mix(c.r, texture2D(uTex, vUv + off).r, 0.5), c.g, mix(c.b, texture2D(uTex, vUv - off).b, 0.5));",
            "  c *= 1.0 + 0.15 * uSpeed * (0.5 + 0.5 * sin(uTime * 9.0));",
            "  gl_FragColor = vec4(mix(orig, clamp(c, 0.0, 1.0), uAmount), 1.0);",
            "}"
        ].join("\n"),

        // Pixel: block size uP.x pixels, uP.y colour levels, ordered dither uP.z.
        pixel: [
            "void main() {",
            "  vec2 px = uRes / uP.x; vec2 uv = (floor(vUv * px) + 0.5) / px;",
            "  vec3 orig = texture2D(uTex, vUv).rgb; vec3 c = texture2D(uTex, uv).rgb;",
            "  vec2 cell = mod(floor(vUv * px), 2.0); float bayer = (cell.x + cell.y * 2.0) / 4.0 - 0.375;",
            "  c = floor(c * uP.y + 0.5 + bayer * uP.z) / uP.y;",
            "  gl_FragColor = vec4(mix(orig, clamp(c, 0.0, 1.0), uAmount), 1.0);",
            "}"
        ].join("\n")
    };

    // ======================================================================
    // Styles: ordered pass chains
    // ======================================================================
    function bloom(src, threshold, radius) {
        return [
            { fs: "bright", in: src, out: "h1", p: [threshold] },
            { fs: "blur", in: "h1", out: "h2", p: [1, 0, radius] },
            { fs: "blur", in: "h2", out: "h1", p: [0, 1, radius] },
            { fs: "blur", in: "h1", out: "h2", p: [1, 0, radius * 1.8] },
            { fs: "blur", in: "h2", out: "h1", p: [0, 1, radius * 1.8] }
        ];
    }
    var STYLES = {};
    var ORDER = [];
    function define(id, def) {
        if (!STYLES[id]) ORDER.push(id);
        STYLES[id] = { id: id, name: def.name || id, passes: def.passes || [], failed: false };
        return STYLES[id];
    }
    define("classic", { name: "Classic", passes: [] });
    define("rainbow", { name: "Rainbow", passes: [{ fs: "rainbow", in: "scene", out: "screen" }] });
    define("neon", { name: "Neon glow", passes: bloom("scene", 0.45, 1.5).concat([
        { fs: "finish", in: "scene", in2: "h1", out: "screen", p: [1.1, 0.15, 0.25, 0], q: [0, 0.15] }]) });
    define("synthwave", { name: "Synthwave", passes: [{ fs: "grade", in: "scene", out: "a", p: [1, 1] }].concat(bloom("a", 0.4, 1.5), [
        { fs: "finish", in: "a", in2: "h1", out: "screen", p: [0.9, 0.5, 0.35, 0.25], q: [0.05, 0.1] }]) });
    define("crt", { name: "CRT arcade", passes: bloom("scene", 0.5, 1.2).concat([
        { fs: "finish", in: "scene", in2: "h1", out: "a", p: [0.45, 0, 0, 0], q: [0, 0] },
        { fs: "crt", in: "a", out: "screen", p: [0.12, 0.45, 0.5, 0.45] }]) });
    define("hyperspeed", { name: "Hyperspeed", passes: [{ fs: "radial", in: "scene", out: "screen", p: [0.09, 0.5] }] });
    define("pixel", { name: "Pixel", passes: [{ fs: "pixel", in: "scene", out: "screen", p: [4, 6, 1] }] });
    define("noir", { name: "Noir", passes: [{ fs: "grade", in: "scene", out: "a", p: [2, 1] },
        { fs: "finish", in: "a", out: "screen", p: [0, 0, 0.5, 0], q: [0.12, 0] }] });
    define("matrix", { name: "Matrix", passes: [{ fs: "grade", in: "scene", out: "a", p: [3, 1] },
        { fs: "finish", in: "a", out: "screen", p: [0, 0, 0.35, 0.35], q: [0.1, 0] }] });

    // ======================================================================
    // Settings
    // ======================================================================
    var styleId = (function () {
        var s = lsGet(KEY_STYLE);
        if (s && STYLES[s]) return s;
        return lsGet(KEY_RAINBOW_OLD) === "0" ? "classic" : "rainbow";   // the old Rainbow checkbox
    })();
    var intensity = (function () { var v = parseFloat(lsGet(KEY_FX)); return v >= 0 && v <= 1 ? v : 1; })();
    var enabled = true;

    // ======================================================================
    // Context adoption and frame hooks
    // ======================================================================
    var gl = null, g = null, isGL2 = false, res = null, dirty = false;
    var stats = { frames: 0, presented: 0, passes: 0, errors: 0, failed: 0, lastPassMs: 0, vao: "none" };
    var errorTick = 0, t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    function now() { return ((window.performance && performance.now) ? performance.now() : Date.now()); }

    function adopt(ctx) {
        gl = ctx; g = bindRaw(ctx); isGL2 = !!(window.WebGL2RenderingContext && ctx instanceof WebGL2RenderingContext);
        if (ctx.canvas && ctx.canvas.addEventListener) {
            ctx.canvas.addEventListener("webglcontextlost", function () { res = null; }, false);
        }
    }

    // The game's context is the one that draws; the loader's capability probes never do.
    function hookProto(P) {
        if (!P) return;
        var oBind = P.bindFramebuffer;
        P.bindFramebuffer = function (target, fb) {
            if (target === this.FRAMEBUFFER || (this.DRAW_FRAMEBUFFER && target === this.DRAW_FRAMEBUFFER)) this.__slopeFbNull = (fb === null);
            return oBind.apply(this, arguments);
        };
        function wrapDraw(name) {
            var o = P[name];
            if (!o) return;
            P[name] = function () {
                if (this.__slopeFbNull !== false) {   // undefined = never bound anything = default framebuffer
                    if (!gl) adopt(this);
                    if (this === gl) dirty = true;
                }
                return o.apply(this, arguments);
            };
        }
        ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"].forEach(wrapDraw);
    }
    hookProto(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    hookProto(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

    var origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
        if (typeof cb !== "function") return origRAF.call(window, cb);
        return origRAF.call(window, function (t) {
            try { return cb(t); }
            finally { if (dirty) { dirty = false; try { present(); } catch (e) { stats.errors++; warn("present failed: " + e); } } }
        });
    };

    // ======================================================================
    // Resources
    // ======================================================================
    function compile(type, src) {
        var sh = g.createShader(type);
        g.shaderSource(sh, src); g.compileShader(sh);
        if (!g.getShaderParameter(sh, gl.COMPILE_STATUS)) { var log = g.getShaderInfoLog(sh); g.deleteShader(sh); throw new Error(log); }
        return sh;
    }
    function program(fsName) {
        var p = res.programs[fsName];
        if (p !== undefined) return p;
        try {
            var vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, HEAD + "\n" + FRAG[fsName]);
            var prog = g.createProgram();
            g.attachShader(prog, vs); g.attachShader(prog, fs);
            g.bindAttribLocation(prog, 0, "aPos");
            g.linkProgram(prog);
            if (!g.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog));
            p = { prog: prog, u: {} };
            ["uTex", "uTex2", "uRes", "uTexel", "uTime", "uHue", "uSpeed", "uAmount", "uP", "uQ"].forEach(function (n) { p.u[n] = g.getUniformLocation(prog, n); });
        } catch (e) {
            stats.failed++; warn("shader '" + fsName + "' failed: " + e.message);
            p = null;
        }
        res.programs[fsName] = p;
        return p;
    }
    function makeTarget(w, h, fmt) {
        var tex = g.createTexture();
        g.bindTexture(gl.TEXTURE_2D, tex);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        g.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, null);
        var fbo = g.createFramebuffer();
        g.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        g.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        var ok = g.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        return { tex: tex, fbo: fbo, w: w, h: h, ok: ok };
    }
    function dropResources() {
        if (!res) return;
        try {
            Object.keys(res.buffers).forEach(function (k) { var b = res.buffers[k]; if (b.fbo) g.deleteFramebuffer(b.fbo); g.deleteTexture(b.tex); });
            Object.keys(res.programs).forEach(function (k) { if (res.programs[k]) g.deleteProgram(res.programs[k].prog); });
            if (res.quad) g.deleteBuffer(res.quad);
            if (res.vao && res.vaoMode === "gl2") g.deleteVertexArray(res.vao);
            else if (res.vao && res.vaoExt) res.vaoExt.deleteVertexArrayOES(res.vao);
        } catch (e) { /* context may be gone */ }
        res = null;
    }
    function ensureResources(w, h) {
        if (res && res.w === w && res.h === h) return true;
        var programs = res ? res.programs : null, quad = res ? res.quad : null, vao = res ? res.vao : null, vaoMode = res ? res.vaoMode : null, vaoExt = res ? res.vaoExt : null;
        if (res) { Object.keys(res.buffers).forEach(function (k) { var b = res.buffers[k]; if (b.fbo) g.deleteFramebuffer(b.fbo); g.deleteTexture(b.tex); }); }
        var attrs = null; try { attrs = g.getContextAttributes(); } catch (e) { /* ignore */ }
        var sceneFmt = (attrs && attrs.alpha === false) ? gl.RGB : gl.RGBA;   // copyTexSubImage2D needs the texture to match the canvas
        var hw = Math.max(1, Math.round(w / 2)), hh = Math.max(1, Math.round(h / 2));
        res = { w: w, h: h, programs: programs || {}, quad: quad, vao: vao, vaoMode: vaoMode, vaoExt: vaoExt, buffers: {} };
        var scene = makeTarget(w, h, sceneFmt); if (scene.fbo) { g.deleteFramebuffer(scene.fbo); scene.fbo = null; }   // the capture is never rendered into
        res.buffers.scene = scene;
        res.buffers.a = makeTarget(w, h, gl.RGBA);
        res.buffers.b = makeTarget(w, h, gl.RGBA);
        res.buffers.h1 = makeTarget(hw, hh, gl.RGBA);
        res.buffers.h2 = makeTarget(hw, hh, gl.RGBA);
        g.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!res.quad) {
            res.quad = g.createBuffer();
            g.bindBuffer(gl.ARRAY_BUFFER, res.quad);
            g.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle covers the screen
            if (isGL2 && g.createVertexArray) { res.vao = g.createVertexArray(); res.vaoMode = "gl2"; g.bindVertexArray(res.vao); }
            else {
                var ext = null; try { ext = g.getExtension("OES_vertex_array_object"); } catch (e) { /* none */ }
                if (ext) { res.vaoExt = ext; res.vao = ext.createVertexArrayOES(); res.vaoMode = "oes"; ext.bindVertexArrayOES(res.vao); }
                else res.vaoMode = "none";
            }
            if (res.vaoMode !== "none") {
                g.bindBuffer(gl.ARRAY_BUFFER, res.quad);
                g.enableVertexAttribArray(0);
                g.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
                if (res.vaoMode === "gl2") g.bindVertexArray(null); else res.vaoExt.bindVertexArrayOES(null);
            }
            stats.vao = res.vaoMode;
        }
        var ok = res.buffers.a.ok && res.buffers.b.ok && res.buffers.h1.ok && res.buffers.h2.ok;
        if (!ok) warn("framebuffers incomplete; post-processing disabled");
        return ok;
    }

    // ======================================================================
    // Presenting a frame
    // ======================================================================
    var TEX_UNITS = 2;
    function saveState() {
        var s = {};
        s.program = g.getParameter(gl.CURRENT_PROGRAM);
        s.fb = g.getParameter(gl.FRAMEBUFFER_BINDING);
        if (isGL2) s.readFb = g.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        s.arrayBuf = g.getParameter(gl.ARRAY_BUFFER_BINDING);
        s.activeTex = g.getParameter(gl.ACTIVE_TEXTURE);
        s.tex = [];
        for (var i = 0; i < TEX_UNITS; i++) { g.activeTexture(gl.TEXTURE0 + i); s.tex.push(g.getParameter(gl.TEXTURE_BINDING_2D)); }
        s.viewport = g.getParameter(gl.VIEWPORT);
        s.scissor = g.isEnabled(gl.SCISSOR_TEST);
        s.blend = g.isEnabled(gl.BLEND);
        s.depth = g.isEnabled(gl.DEPTH_TEST);
        s.stencil = g.isEnabled(gl.STENCIL_TEST);
        s.cull = g.isEnabled(gl.CULL_FACE);
        s.colorMask = g.getParameter(gl.COLOR_WRITEMASK);
        if (isGL2) s.discard = g.isEnabled(gl.RASTERIZER_DISCARD);
        if (res.vaoMode === "gl2") s.vao = g.getParameter(gl.VERTEX_ARRAY_BINDING);
        else if (res.vaoMode === "oes") s.vao = g.getParameter(res.vaoExt.VERTEX_ARRAY_BINDING_OES);
        else {
            s.attribs = [];
            var n = g.getParameter(gl.MAX_VERTEX_ATTRIBS);
            for (var a = 0; a < n; a++) {
                var en = g.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_ENABLED);
                s.attribs.push(en);
                if (en && a > 0) g.disableVertexAttribArray(a);
            }
            s.attrib0 = { buf: g.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING), size: g.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_SIZE), type: g.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_TYPE),
                norm: g.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED), stride: g.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_STRIDE), off: g.getVertexAttribOffset(0, gl.VERTEX_ATTRIB_ARRAY_POINTER) };
            s.elementBuf = g.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
        }
        return s;
    }
    function restoreState(s) {
        if (res.vaoMode === "gl2") g.bindVertexArray(s.vao);
        else if (res.vaoMode === "oes") res.vaoExt.bindVertexArrayOES(s.vao);
        else {
            for (var a = 0; a < s.attribs.length; a++) { if (s.attribs[a]) g.enableVertexAttribArray(a); else g.disableVertexAttribArray(a); }
            g.bindBuffer(gl.ARRAY_BUFFER, s.attrib0.buf);
            if (s.attrib0.buf) g.vertexAttribPointer(0, s.attrib0.size, s.attrib0.type, s.attrib0.norm, s.attrib0.stride, s.attrib0.off);
            g.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.elementBuf);
        }
        g.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuf);
        for (var i = 0; i < TEX_UNITS; i++) { g.activeTexture(gl.TEXTURE0 + i); g.bindTexture(gl.TEXTURE_2D, s.tex[i]); }
        g.activeTexture(s.activeTex);
        g.useProgram(s.program);
        if (isGL2) { g.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.fb); g.bindFramebuffer(gl.READ_FRAMEBUFFER, s.readFb); }
        else g.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
        g.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
        (s.scissor ? g.enable : g.disable)(gl.SCISSOR_TEST);
        (s.blend ? g.enable : g.disable)(gl.BLEND);
        (s.depth ? g.enable : g.disable)(gl.DEPTH_TEST);
        (s.stencil ? g.enable : g.disable)(gl.STENCIL_TEST);
        (s.cull ? g.enable : g.disable)(gl.CULL_FACE);
        if (isGL2) (s.discard ? g.enable : g.disable)(gl.RASTERIZER_DISCARD);
        g.colorMask(s.colorMask[0], s.colorMask[1], s.colorMask[2], s.colorMask[3]);
    }

    function speedNorm() {
        try { var v = window.SlopeMod && SlopeMod.speed ? SlopeMod.speed() : 0; return Math.max(0, Math.min(1, v / SPEED_REF)); } catch (e) { return 0; }
    }

    function present() {
        stats.frames++;
        var style = STYLES[styleId];
        if (!enabled || !gl || !style || !style.passes.length || style.failed) { stats.passes = 0; return; }
        if (gl.isContextLost && gl.isContextLost()) return;
        var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        if (!(w > 0 && h > 0)) return;
        var tStart = now();
        if (!ensureResources(w, h)) { style.failed = true; return; }
        var state = saveState();
        var drawn = 0;
        try {
            // capture the finished frame
            g.bindFramebuffer(gl.FRAMEBUFFER, null);
            g.activeTexture(gl.TEXTURE0);
            g.bindTexture(gl.TEXTURE_2D, res.buffers.scene.tex);
            g.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);

            g.disable(gl.SCISSOR_TEST); g.disable(gl.BLEND); g.disable(gl.DEPTH_TEST); g.disable(gl.STENCIL_TEST); g.disable(gl.CULL_FACE);
            if (isGL2) g.disable(gl.RASTERIZER_DISCARD);
            g.colorMask(true, true, true, true);
            if (res.vaoMode === "gl2") g.bindVertexArray(res.vao);
            else if (res.vaoMode === "oes") res.vaoExt.bindVertexArrayOES(res.vao);
            else { g.bindBuffer(gl.ARRAY_BUFFER, res.quad); g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); }

            var t = (now() - t0) / 1000, hue = (t / HUE_PERIOD) % 1, speed = speedNorm();
            for (var i = 0; i < style.passes.length; i++) {
                var pass = style.passes[i], p = program(pass.fs);
                if (!p) { style.failed = true; break; }
                var src = res.buffers[pass.in] || res.buffers.scene, src2 = res.buffers[pass.in2] || src;
                var dst = pass.out === "screen" ? null : res.buffers[pass.out];
                g.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
                var ow = dst ? dst.w : w, oh = dst ? dst.h : h;
                g.viewport(0, 0, ow, oh);
                g.useProgram(p.prog);
                g.activeTexture(gl.TEXTURE0); g.bindTexture(gl.TEXTURE_2D, src.tex);
                g.activeTexture(gl.TEXTURE1); g.bindTexture(gl.TEXTURE_2D, src2.tex);
                g.uniform1i(p.u.uTex, 0); g.uniform1i(p.u.uTex2, 1);
                g.uniform2f(p.u.uRes, ow, oh); g.uniform2f(p.u.uTexel, 1 / src.w, 1 / src.h);
                g.uniform1f(p.u.uTime, t); g.uniform1f(p.u.uHue, hue); g.uniform1f(p.u.uSpeed, speed); g.uniform1f(p.u.uAmount, intensity);
                var P = pass.p || [], Q = pass.q || [];
                g.uniform4f(p.u.uP, P[0] || 0, P[1] || 0, P[2] || 0, P[3] || 0);
                g.uniform4f(p.u.uQ, Q[0] || 0, Q[1] || 0, Q[2] || 0, Q[3] || 0);
                g.drawArrays(gl.TRIANGLES, 0, 3);
                drawn++;
            }
        } finally {
            restoreState(state);
        }
        stats.passes = drawn;
        if (drawn) stats.presented++;
        stats.lastPassMs = now() - tStart;
        if (++errorTick >= ERROR_CHECK_EVERY) { errorTick = 0; var err = g.getError(); if (err) { stats.errors++; warn("GL error 0x" + err.toString(16) + " after the post pass"); } }
    }

    // ======================================================================
    // Settings, HUD, keyboard
    // ======================================================================
    var styleSel = null, fxRange = null;
    function setStyle(id) {
        if (!STYLES[id]) return false;
        styleId = id; lsSet(KEY_STYLE, id);
        if (styleSel && styleSel.value !== id) styleSel.value = id;
        return true;
    }
    function setIntensity(v) {
        v = parseFloat(v); if (!(v >= 0)) v = 0; if (v > 1) v = 1;
        intensity = v; lsSet(KEY_FX, v);
        if (fxRange && Math.round(parseFloat(fxRange.value)) !== Math.round(v * 100)) fxRange.value = Math.round(v * 100);
    }
    function nextStyle(step) {
        var i = ORDER.indexOf(styleId); if (i < 0) i = 0;
        setStyle(ORDER[(i + (step || 1) + ORDER.length) % ORDER.length]);
        return styleId;
    }
    function populate() {
        if (!styleSel) return;
        styleSel.innerHTML = "";
        ORDER.forEach(function (id) { var o = document.createElement("option"); o.value = id; o.textContent = STYLES[id].name; styleSel.appendChild(o); });
        styleSel.value = styleId;
    }
    function wireHud() {
        styleSel = document.getElementById("hud-style");
        fxRange = document.getElementById("hud-fx");
        if (styleSel) {
            populate();
            styleSel.addEventListener("change", function () { setStyle(styleSel.value); styleSel.blur(); });
        }
        if (fxRange) {
            fxRange.value = Math.round(intensity * 100);
            fxRange.addEventListener("input", function () { setIntensity(parseFloat(fxRange.value) / 100); });
            fxRange.addEventListener("change", function () { fxRange.blur(); });
        }
        document.addEventListener("keydown", function (e) {
            var ae = document.activeElement;
            if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === "v" || e.key === "V") nextStyle(e.shiftKey ? -1 : 1);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireHud); else wireHud();

    window.SlopeShaders = {
        styles: function () { return ORDER.map(function (id) { return { id: id, name: STYLES[id].name, failed: STYLES[id].failed }; }); },
        style: function () { return styleId; },
        setStyle: setStyle,
        next: nextStyle,
        intensity: function () { return intensity; },
        setIntensity: setIntensity,
        enabled: function () { return enabled; },
        setEnabled: function (b) { enabled = !!b; },
        define: function (id, def) { define(id, def); populate(); return STYLES[id]; },
        passes: function (id) { var s = STYLES[id || styleId]; return s ? s.passes.map(function (p) { return { fs: p.fs, in: p.in, in2: p.in2, out: p.out, p: p.p, q: p.q }; }) : null; },
        reset: function () { dropResources(); Object.keys(STYLES).forEach(function (k) { STYLES[k].failed = false; }); },
        stats: function () {
            return { enabled: enabled, style: styleId, intensity: intensity, glVersion: gl ? (isGL2 ? 2 : 1) : 0, width: res ? res.w : 0, height: res ? res.h : 0,
                frames: stats.frames, presented: stats.presented, passes: stats.passes, errors: stats.errors, failed: stats.failed, lastPassMs: +stats.lastPassMs.toFixed(2), vao: stats.vao,
                styleFailed: !!(STYLES[styleId] && STYLES[styleId].failed) };
        }
    };
})();
