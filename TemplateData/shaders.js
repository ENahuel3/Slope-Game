/* Slope mod: shader system. Post-processing of the game's finished frame,
 * plus a lighting stage that ray-marches against the game's depth buffer.
 *
 * Every requestAnimationFrame callback is wrapped, so after Unity's frame
 * callback returns (and before the browser composites the canvas) the
 * finished frame is run through the selected Light mode and Style, a chain
 * of full-screen passes; the last pass draws onto the canvas. The game's
 * own shaders are not touched. (The previous system rewrote every fragment
 * shader at compile time: it could only recolour pixels, failed per shader,
 * uploaded a uniform before every draw call and could not be changed once
 * the shaders were compiled.) Unity caches GL state and skips redundant
 * calls, so every piece of state the passes use is saved and restored.
 *
 * Styles (STYLES) recolour the frame: with Light = Normal the canvas is
 * copied into a texture (copyTexSubImage2D) and the passes read that.
 *
 * Light = Sunny / Night needs the scene's depth, which the canvas cannot
 * give, so while one of them is on the game's binds of the default
 * framebuffer are redirected to an offscreen framebuffer with a depth-
 * stencil texture (the game cannot tell: it binds null four times a frame
 * and never reads the binding back). The lighting pass reconstructs each
 * pixel's view-space position and normal from that depth, using the real
 * camera: Unity uploads unity_MatrixVP every frame as a vec4[4] uniform,
 * from which the near and far planes, the field of view and the camera's
 * world orientation are recovered (CAMERA below), so the sun and moon are
 * fixed in the world and stay put while the lane rolls. Against that depth
 * it traces, per pixel: a sky ray (procedural sky, sun or moon and stars),
 * a shadow ray toward the light (screen-space ray march), for Night a
 * reflection ray off the lane (screen-space reflections of the neon), and a
 * half-size pass marches toward the light through the sky mask for
 * volumetric light shafts. The lit frame then feeds the Style passes.
 *
 * A pass names a fragment shader (FRAG), the buffer it reads ("scene" is
 * the frame, "a"/"b"/"lit" are full-size, "h1".."h3" half-size), optional
 * second and third inputs, where it writes ("screen" is the canvas) and
 * parameters. The GLSL is ES 1.00 so it runs on WebGL 1 and 2 (WebGL 1
 * needs WEBGL_depth_texture for the lighting's depth; without it the
 * lighting still runs, without shadows and reflections). A compile or
 * link failure disables that style or light (the game keeps rendering)
 * and is counted in stats(). The raw GL entry points are captured here,
 * before mod.js wraps the same prototypes to count the game's draw calls,
 * so the passes are invisible to it. Load order: this file before mod.js,
 * both before the loader.
 *
 * Page API (window.SlopeShaders): styles(), style(), setStyle(id), next(),
 * lights(), light(), setLight(id), nextLight(), intensity(),
 * setIntensity(0..1), enabled(), setEnabled(b), define(id, {name,
 * passes}), passes(id), camera(), stats(). The HUD's Style / Light
 * selects and FX slider, the V key (style) and L key (light) are wired
 * here. Settings persist in localStorage.
 */
(function () {
    "use strict";

    var KEY_STYLE = "slope-mod.style", KEY_FX = "slope-mod.fx", KEY_LIGHT = "slope-mod.light", KEY_RAINBOW_OLD = "slope-mod.rainbow";
    var HUE_PERIOD = 3.5;         // seconds per rainbow cycle (what the old system did at 60 fps)
    var SPEED_REF = 40;           // ball speed (units/s, from SlopeMod.speed()) that counts as "fast" for speed-driven effects
    var ERROR_CHECK_EVERY = 60;   // frames between glGetError polls (each one is a round trip)
    var VP_UNIFORM = /unity_MatrixVP(\[0\])?$/;   // Unity's view-projection matrix: four vec4s (hlslcc_mtx4x4unity_MatrixVP, WebGL 2) or a mat4 (WebGL 1)
    // The course runs down a 45-degree slope: its axis and floor normal in world space (mod.js FWD0 / N0).
    // The sky's "up" is the lane's normal; the sun sits ahead of the player and off to one side, the moon on the other.
    var SKY_UP = [0, 0.70710678, 0.70710678];
    // (course axis + 0.5 lane-up + 0.25 right: the sun sits near the top of the view, 25 degrees above the lane, so shadows are long)
    var SUN_DIR = norm3([0.22, -0.31, 0.92]);
    var MOON_DIR = norm3([-0.25, -0.24, 0.94]);

    function norm3(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
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
        "uniform sampler2D uTex2;",    // optional second input
        "uniform sampler2D uTex3;",    // optional third input
        "uniform sampler2D uDepth;",   // the scene's depth (lighting passes)
        "uniform vec2 uRes;",          // output size in pixels
        "uniform vec2 uTexel;",        // 1 / input size
        "uniform float uTime;",        // seconds
        "uniform float uHue;",         // 0..1, cycles every HUE_PERIOD
        "uniform float uSpeed;",       // 0..1, ball speed
        "uniform float uAmount;",      // style intensity 0..1
        "uniform vec4 uP;",            // pass parameters
        "uniform vec4 uQ;",            // more pass parameters
        "uniform vec4 uCam;",          // projection: x = 1/(tan(fov/2)*aspect), y = 1/tan(fov/2), z = near, w = far
        "uniform mat3 uRot;",          // camera axes in world space (columns: right, up, back): world = uRot * view
        "uniform vec4 uLight;",        // light direction in view space (xyz), w = 1 when depth is available
        "uniform vec4 uLightUV;",      // light's screen position (xy), z = 1 when it is in front of the camera
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
        "float hash3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }",
        "float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);",
        "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }",
        "float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }",
        // the green neon of the track, which the colour styles recolour; red (the obstacles) is left alone
        "float greenness(vec3 c) {",
        "  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn;",
        "  if (mx <= 0.0 || d < 0.03 * mx) return 0.0;",
        "  float h; if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;",
        "  return 1.0 - smoothstep(0.7, 1.1, abs(h - 2.0));",
        "}",
        // ---- depth / camera helpers (lighting passes) ----
        "const vec3 SKY_UP = vec3(" + SKY_UP.join(", ") + ");",
        "float linZ(float d) { float z = d * 2.0 - 1.0; float n = uCam.z, f = uCam.w; return 2.0 * n * f / (f + n - z * (f - n)); }",   // distance along the view axis
        "float depthAt(vec2 uv) { return texture2D(uDepth, uv).r; }",
        "bool isSky(float d) { return d > 0.99999; }",
        "vec3 viewPos(vec2 uv, float lz) { return vec3((uv.x * 2.0 - 1.0) / uCam.x * lz, (uv.y * 2.0 - 1.0) / uCam.y * lz, -lz); }",
        "vec3 proj(vec3 p) { float lz = -p.z; return vec3(0.5 + 0.5 * uCam.x * p.x / lz, 0.5 + 0.5 * uCam.y * p.y / lz, lz); }",   // xy = uv, z = view distance
        "vec3 viewRay(vec2 uv) { return normalize(vec3((uv.x * 2.0 - 1.0) / uCam.x, (uv.y * 2.0 - 1.0) / uCam.y, -1.0)); }",
        // normal from neighbouring depths, taking the smoother side of each axis so edges stay crisp
        "vec3 normalAt(vec2 uv, vec3 P) {",
        "  vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);",
        "  vec3 pr = viewPos(uv + dx, linZ(depthAt(uv + dx))), pl = viewPos(uv - dx, linZ(depthAt(uv - dx)));",
        "  vec3 pu = viewPos(uv + dy, linZ(depthAt(uv + dy))), pd = viewPos(uv - dy, linZ(depthAt(uv - dy)));",
        "  vec3 ddx = (abs(pr.z - P.z) < abs(P.z - pl.z)) ? pr - P : P - pl;",
        "  vec3 ddy = (abs(pu.z - P.z) < abs(P.z - pd.z)) ? pu - P : P - pd;",
        "  vec3 n = normalize(cross(ddx, ddy));",
        "  return dot(n, -P) < 0.0 ? -n : n;",
        "}",
        // screen-space shadow ray: march from P toward the light, shadowed when the depth buffer is in front of the ray
        "float shadowRay(vec3 P, vec3 N, vec3 L, float softness) {",
        "  float dist = -P.z; float stp = max(0.06, 0.02 * dist); vec3 p = P + N * stp * 1.5; float hits = 0.0;",
        "  for (int i = 0; i < 16; i++) {",
        "    p += L * stp; if (p.z > -uCam.z) break;",
        "    vec3 q = proj(p); if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) break;",
        "    float bz = linZ(depthAt(q.xy)); float diff = q.z - bz;",
        "    if (diff > max(stp * 0.5, 0.015 * q.z) && diff < stp * 8.0) { hits += 1.0; if (hits >= softness) break; }",
        "    stp *= 1.14;",
        "  }",
        "  return 1.0 - min(1.0, hits / softness);",
        "}",
        // screen-space reflection: march the reflected ray, return the colour it hits (black when it leaves the screen)
        "vec3 reflectRay(vec3 P, vec3 N, out float hitFade) {",
        "  hitFade = 0.0; vec3 R = reflect(normalize(P), N);",
        "  float stp = max(0.08, 0.03 * -P.z); vec3 p = P + N * stp * 0.5 + R * stp;",
        "  for (int i = 0; i < 24; i++) {",
        "    if (p.z > -uCam.z) break;",
        "    vec3 q = proj(p); if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) break;",
        "    float bz = linZ(depthAt(q.xy)); float diff = q.z - bz;",
        "    if (diff > 0.0 && diff < stp * 3.0) { hitFade = (1.0 - float(i) / 24.0) * (1.0 - smoothstep(0.7, 1.0, max(abs(q.x - 0.5), abs(q.y - 0.5)) * 2.0)); return texture2D(uTex, q.xy).rgb; }",
        "    p += R * stp; stp *= 1.1;",
        "  }",
        "  return vec3(0.0);",
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
        ].join("\n"),

        // ---- Lighting ----
        // Sunny: a ray-marched daytime sky where the depth buffer is empty (gradient, sun disc, haze, drifting
        // clouds), and for geometry a sun-lit grey surface under the game's neon: Lambert from the reconstructed
        // normal, a screen-space shadow ray toward the sun, sky ambient and distance haze. Alpha carries the
        // light-shaft mask (sky brightness near the sun) for the rays pass.
        sunny: [
            "void main() {",
            "  vec3 c = texture2D(uTex, vUv).rgb; float d = depthAt(vUv); bool hasDepth = uLight.w > 0.5;",
            "  bool sky = hasDepth ? isSky(d) : (lum(c) < 0.02);",
            "  vec3 L = uLight.xyz;",
            "  vec3 rdW = uRot * viewRay(vUv); float up = dot(rdW, SKY_UP);",
            "  vec3 sunW = uRot * L;",
            "  vec3 zenith = vec3(0.18, 0.40, 0.84), horizon = vec3(0.60, 0.72, 0.88), sunCol = vec3(1.0, 0.93, 0.80);",
            "  float t = clamp(up * 1.6 + 0.1, 0.0, 1.0);",
            "  vec3 skyCol = mix(horizon, zenith, pow(t, 0.7));",
            "  float cosSun = dot(rdW, sunW);",
            "  vec3 hazeCol = mix(horizon, zenith, 0.25);",   // fog colour: the sky without the sun's glow or clouds, so distant geometry does not wash out to white
            "  skyCol += sunCol * (0.12 * pow(max(cosSun, 0.0), 8.0) + 0.35 * pow(max(cosSun, 0.0), 64.0));",
            "  float disc = smoothstep(0.9993, 0.9997, cosSun); skyCol = mix(skyCol, vec3(1.0, 0.98, 0.92), disc);",
            "  if (up > 0.02) { vec3 e1 = vec3(1.0, 0.0, 0.0), e2 = cross(SKY_UP, e1); vec2 cp = vec2(dot(rdW, e1), dot(rdW, e2)) / (up + 0.15);",
            "    float cl = fbm(cp * 2.2 + vec2(uTime * 0.02, 0.0)); cl = smoothstep(0.52, 0.78, cl) * smoothstep(0.02, 0.2, up);",
            "    skyCol = mix(skyCol, vec3(1.0, 0.99, 0.97), cl * 0.85); }",
            "  float mx = max(c.r, max(c.g, c.b)); float emis = smoothstep(0.12, 0.35, mx);",
            "  if (sky) { gl_FragColor = vec4(mix(skyCol, c, emis), (0.04 + 0.6 * pow(max(cosSun, 0.0), 10.0) + 0.6 * disc) * (1.0 - emis)); return; }",   // the UI has no depth: keep it over the sky
            "  vec3 col; float dist = 20.0;",
            "  if (hasDepth) {",
            "    float lz = linZ(d); dist = lz; vec3 P = viewPos(vUv, lz); vec3 N = normalAt(vUv, P);",
            "    float ndl = max(dot(N, L), 0.0);",
            "    float sh = (ndl > 0.0 && uLightUV.w > 0.5) ? shadowRay(P, N, L, 3.0) : 1.0;",
            "    float upN = dot(uRot * N, SKY_UP);",
            "    vec3 amb = mix(horizon, zenith, 0.5 + 0.5 * upN) * 0.36;",
            "    vec3 direct = sunCol * 1.35 * ndl * sh;",
            "    vec3 surf = vec3(0.56, 0.56, 0.58) * (amb + direct);",
            "    col = c * (1.0 + 0.15 * emis) + surf * (1.0 - emis);",
            "  } else {",
            "    col = c + vec3(0.55) * mix(horizon, zenith, 0.5) * 0.5 * (1.0 - emis);",
            "  }",
            "  float fog = 1.0 - exp(-dist * 0.008); col = mix(col, hazeCol, fog * 0.75 * (1.0 - 0.6 * emis));",
            "  gl_FragColor = vec4(col, 0.0);",
            "}"
        ].join("\n"),

        // Night: a ray-marched night sky (gradient, stars with twinkle, moon disc and halo, a faint band of
        // haze), and for geometry a wet-asphalt surface under moonlight with a screen-space shadow ray, the
        // neon boosted, and screen-space reflections of the neon traced off the lane. Alpha carries the
        // moon-glow mask for the light shafts.
        night: [
            "void main() {",
            "  vec3 c = texture2D(uTex, vUv).rgb; float d = depthAt(vUv); bool hasDepth = uLight.w > 0.5;",
            "  bool sky = hasDepth ? isSky(d) : (lum(c) < 0.02);",
            "  vec3 L = uLight.xyz;",
            "  vec3 rdW = uRot * viewRay(vUv); float up = dot(rdW, SKY_UP);",
            "  vec3 moonW = uRot * L;",
            "  vec3 zenith = vec3(0.015, 0.02, 0.06), horizon = vec3(0.07, 0.07, 0.15), moonCol = vec3(0.62, 0.70, 0.95);",
            "  float t = clamp(up * 1.6 + 0.1, 0.0, 1.0);",
            "  vec3 skyCol = mix(horizon, zenith, pow(t, 0.6));",
            "  float cosMoon = dot(rdW, moonW);",
            "  skyCol += moonCol * (0.08 * pow(max(cosMoon, 0.0), 6.0) + 0.35 * pow(max(cosMoon, 0.0), 90.0));",
            "  float disc = smoothstep(0.99955, 0.99975, cosMoon); skyCol = mix(skyCol, vec3(0.92, 0.94, 1.0), disc);",
            "  vec3 cell = floor(rdW * 170.0); float h = hash3(cell);",
            "  float star = step(0.9935, h) * (0.6 + 0.4 * sin(uTime * (2.0 + 6.0 * hash3(cell + 1.0)) + h * 50.0));",
            "  vec3 cf = fract(rdW * 170.0) - 0.5; star *= (1.0 - smoothstep(0.05, 0.35, length(cf))) * smoothstep(0.0, 0.15, up);",
            "  skyCol += vec3(0.9, 0.93, 1.0) * star * 0.9;",
            "  if (up > 0.02) { vec3 e1 = vec3(1.0, 0.0, 0.0), e2 = cross(SKY_UP, e1); vec2 cp = vec2(dot(rdW, e1), dot(rdW, e2)) / (up + 0.15);",
            "    float haze = fbm(cp * 1.4 + vec2(uTime * 0.01, 3.0)); skyCol += vec3(0.05, 0.06, 0.12) * smoothstep(0.45, 0.8, haze) * smoothstep(0.02, 0.25, up); }",
            "  float mx = max(c.r, max(c.g, c.b)); float emis = smoothstep(0.12, 0.35, mx);",
            "  if (sky) { gl_FragColor = vec4(mix(skyCol, c * (1.0 + 0.3 * emis), emis), (0.35 * pow(max(cosMoon, 0.0), 14.0) + disc * 0.8) * (1.0 - emis)); return; }",   // the UI has no depth: keep it over the sky
            "  vec3 col; float dist = 20.0;",
            "  if (hasDepth) {",
            "    float lz = linZ(d); dist = lz; vec3 P = viewPos(vUv, lz); vec3 N = normalAt(vUv, P);",
            "    float ndl = max(dot(N, L), 0.0);",
            "    float sh = (ndl > 0.0 && uLightUV.w > 0.5) ? shadowRay(P, N, L, 2.0) : 1.0;",
            "    vec3 amb = vec3(0.05, 0.065, 0.13);",
            "    vec3 direct = moonCol * 0.55 * ndl * sh;",
            "    vec3 surf = vec3(0.32, 0.33, 0.38) * (amb + direct);",
            "    float floorness = smoothstep(0.35, 0.8, dot(uRot * N, SKY_UP));",
            "    vec3 refl = vec3(0.0);",
            "    if (floorness > 0.01 && emis < 0.9) { float fade; vec3 rc = reflectRay(P, N, fade); refl = rc * smoothstep(0.06, 0.3, lum(rc)) * fade;",
            "      float fres = 0.3 + 0.7 * pow(1.0 - max(dot(-normalize(P), N), 0.0), 3.0); refl *= fres * floorness * 0.8; }",
            "    col = c * (1.0 + 0.3 * emis) + surf * (1.0 - emis) + refl * (1.0 - emis);",
            "  } else {",
            "    col = c * (1.0 + 0.3 * emis) + vec3(0.03, 0.035, 0.06) * (1.0 - emis);",
            "  }",
            "  float fog = 1.0 - exp(-dist * 0.016); col = mix(col, skyCol, fog * 0.9 * (1.0 - 0.6 * emis));",
            "  gl_FragColor = vec4(col, 0.0);",
            "}"
        ].join("\n"),

        // Light shafts: march from the pixel toward the light through the lighting pass's alpha mask
        // (sky brightness around the sun / moon). uP.x density, uP.y decay, uP.z weight. Half size.
        rays: [
            "void main() {",
            "  if (uLightUV.z < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }",
            "  vec2 dir = (uLightUV.xy - vUv) / 32.0 * uP.x; vec2 uv = vUv; float ill = 1.0, acc = 0.0;",
            "  for (int i = 0; i < 32; i++) { uv += dir; acc += texture2D(uTex, uv).a * ill; ill *= uP.y; }",
            "  float edge = 1.0 - smoothstep(0.5, 1.6, length(uLightUV.xy - 0.5) * 2.0 - 0.3);",   // fade when the light is far off screen
            "  gl_FragColor = vec4(vec3(acc * uP.z * edge), 1.0);",
            "}"
        ].join("\n"),

        // Lighting composite: lit scene (uTex) + light shafts (uTex2) * light colour uP.rgb + bloom (uTex3) * uQ.x.
        lcomp: [
            "void main() {",
            "  vec3 c = texture2D(uTex, vUv).rgb;",
            "  c += texture2D(uTex2, vUv).rgb * uP.rgb;",
            "  c += texture2D(uTex3, vUv).rgb * uQ.x;",
            "  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);",
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
    var BUFFERS = ["scene", "a", "b", "lit", "h1", "h2", "h3"];
    function validChain(passes) {
        for (var i = 0; i < passes.length; i++) {
            var p = passes[i];
            if (!FRAG[p.fs]) return "unknown shader '" + p.fs + "'";
            if (BUFFERS.indexOf(p.in) < 0) return "unknown input '" + p.in + "'";
            if (p.in2 && BUFFERS.indexOf(p.in2) < 0) return "unknown input '" + p.in2 + "'";
            if (p.in3 && BUFFERS.indexOf(p.in3) < 0) return "unknown input '" + p.in3 + "'";
            if (p.out !== "screen" && (BUFFERS.indexOf(p.out) < 0 || p.out === "scene")) return "bad output '" + p.out + "'";
            if (p.out === p.in || p.out === p.in2 || p.out === p.in3) return "pass " + i + " reads and writes '" + p.out + "'";
        }
        return null;
    }
    function define(id, def) {
        var bad = validChain(def.passes || []);
        if (bad) { warn("style '" + id + "' rejected: " + bad); return null; }
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

    // Light modes: a pass chain that turns "scene" (+ depth) into the lit frame. The final pass writes to
    // "lit" (or to the screen when the style has no passes); the style's "scene" inputs then read "lit".
    var LIGHTS = {
        normal: { id: "normal", name: "Normal", dir: null, passes: [] },
        sunny: { id: "sunny", name: "Sunny", dir: SUN_DIR, failed: false, passes: [
            { fs: "sunny", in: "scene", out: "a" },
            { fs: "rays", in: "a", out: "h1", p: [1.0, 0.955, 0.035] },
            { fs: "lcomp", in: "a", in2: "h1", in3: "h1", out: "lit", p: [1.0, 0.92, 0.72], q: [0] }
        ] },
        night: { id: "night", name: "Night", dir: MOON_DIR, failed: false, passes: [
            { fs: "night", in: "scene", out: "a" },
            { fs: "rays", in: "a", out: "h1", p: [1.0, 0.95, 0.045] },
            { fs: "bright", in: "a", out: "h2", p: [0.5] },
            { fs: "blur", in: "h2", out: "h3", p: [1, 0, 1.6] },
            { fs: "blur", in: "h3", out: "h2", p: [0, 1, 1.6] },
            { fs: "lcomp", in: "a", in2: "h1", in3: "h2", out: "lit", p: [0.55, 0.65, 0.95], q: [0.7] }
        ] }
    };
    var LIGHT_ORDER = ["normal", "sunny", "night"];

    // ======================================================================
    // Settings
    // ======================================================================
    var styleId = (function () {
        var s = lsGet(KEY_STYLE);
        if (s && STYLES[s]) return s;
        return lsGet(KEY_RAINBOW_OLD) === "0" ? "classic" : "rainbow";   // the old Rainbow checkbox
    })();
    var lightId = (function () { var s = lsGet(KEY_LIGHT); return s && LIGHTS[s] ? s : "normal"; })();
    var intensity = (function () { var v = parseFloat(lsGet(KEY_FX)); return v >= 0 && v <= 1 ? v : 1; })();
    var enabled = true;

    // ======================================================================
    // Context adoption and frame hooks
    // ======================================================================
    var gl = null, g = null, isGL2 = false, res = null, dirty = false;
    var vaoMode = "none", vaoExt = null;   // "gl2" | "oes" | "none": how the pass quad's vertex state is kept
    var redirectActive = false;   // the game's default-framebuffer binds go to res.main (lighting on)
    var vpMat = null;             // last unity_MatrixVP upload (Float32Array[16], column-major)
    var stats = { frames: 0, presented: 0, passes: 0, errors: 0, failed: 0, lastPassMs: 0, vao: "none", depth: "none" };
    var errorTick = 0, t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    function now() { return ((window.performance && performance.now) ? performance.now() : Date.now()); }

    function adopt(ctx) {
        gl = ctx; g = bindRaw(ctx); isGL2 = !!(window.WebGL2RenderingContext && ctx instanceof WebGL2RenderingContext);
        if (isGL2 && g.createVertexArray) vaoMode = "gl2";
        else { try { vaoExt = g.getExtension("OES_vertex_array_object"); } catch (e) { vaoExt = null; } vaoMode = vaoExt ? "oes" : "none"; }
        stats.vao = vaoMode;
        if (ctx.canvas && ctx.canvas.addEventListener) {
            ctx.canvas.addEventListener("webglcontextlost", function () { res = null; redirectActive = false; }, false);
        }
    }

    // The game's context is the one that draws; the loader's capability probes never do.
    function hookProto(P) {
        if (!P) return;
        var oBind = P.bindFramebuffer, oGetLoc = P.getUniformLocation, oU4 = P.uniform4fv, oM4 = P.uniformMatrix4fv;
        var oInv = P.invalidateFramebuffer, oInvSub = P.invalidateSubFramebuffer;
        P.bindFramebuffer = function (target, fb) {
            var isRead = this.READ_FRAMEBUFFER && target === this.READ_FRAMEBUFFER;
            if (target === this.FRAMEBUFFER) { this.__slopeFbNull = (fb === null); this.__slopeReadNull = (fb === null); }
            else if (isRead) this.__slopeReadNull = (fb === null);
            else this.__slopeFbNull = (fb === null);
            if (fb === null && redirectActive && this === gl && ensureMain()) fb = res.main.fbo;   // the lighting's capture target stands in for the canvas
            return oBind.call(this, target, fb);
        };
        P.getUniformLocation = function (program, name) {
            var loc = oGetLoc.apply(this, arguments);
            if (loc && VP_UNIFORM.test(String(name))) loc.__slopeVP = true;
            return loc;
        };
        function noteVP(ctx, loc, v, srcOffset) {
            if (loc && loc.__slopeVP && ctx === gl && v && v.length >= 16) {
                var off = srcOffset | 0;
                if (!vpMat) vpMat = new Float32Array(16);
                for (var i = 0; i < 16; i++) vpMat[i] = v[off + i];
            }
        }
        P.uniform4fv = function (loc, v, srcOffset) { noteVP(this, loc, v, srcOffset); return oU4.apply(this, arguments); };
        P.uniformMatrix4fv = function (loc, transpose, v, srcOffset) { if (!transpose) noteVP(this, loc, v, srcOffset); return oM4.apply(this, arguments); };
        // Discarding the "canvas" while it is really the lighting's framebuffer would throw away the depth the pass needs.
        function logicalNull(ctx, target) { return (ctx.READ_FRAMEBUFFER && target === ctx.READ_FRAMEBUFFER) ? ctx.__slopeReadNull !== false : ctx.__slopeFbNull !== false; }
        if (oInv) P.invalidateFramebuffer = function (target) { if (redirectActive && this === gl && logicalNull(this, target)) return; return oInv.apply(this, arguments); };
        if (oInvSub) P.invalidateSubFramebuffer = function (target) { if (redirectActive && this === gl && logicalNull(this, target)) return; return oInvSub.apply(this, arguments); };
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
            finally { if (dirty) { dirty = false; try { runSceneHooks(); } catch (e) { stats.errors++; warn("scene hook failed: " + e); } try { present(); } catch (e) { stats.errors++; warn("present failed: " + e); } } }
        });
    };
    // Scene hooks (SlopeShaders.onScene): other modules draw into the game's frame after the game's draws and before
    // the post-processing, with the depth buffer of the frame still there (coins.js). The hook gets the raw entry
    // points, the frame's size and whether the frame is the lighting stand-in; the framebuffer, viewport, program,
    // buffers, textures, vertex array and the enable bits are saved around it like around the passes.
    var sceneHooks = [];
    function runSceneHooks() {
        if (!sceneHooks.length || !gl || (gl.isContextLost && gl.isContextLost())) return;
        var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        if (!(w > 0 && h > 0)) return;
        var state = saveState();
        try {
            var target = redirectActive && res && res.main && res.main.ok ? res.main.fbo : null;
            g.bindFramebuffer(gl.FRAMEBUFFER, target);
            if (isGL2) g.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
            g.viewport(0, 0, w, h);
            var info = { gl: gl, g: g, isGL2: isGL2, vaoMode: vaoMode, vaoExt: vaoExt, width: w, height: h, redirected: !!target, vp: vpMat };
            for (var i = 0; i < sceneHooks.length; i++) { try { sceneHooks[i](info); } catch (e) { stats.errors++; warn("scene hook: " + e); } }
        } finally { restoreState(state); }
    }

    // ======================================================================
    // Camera: near, far, field of view and orientation from unity_MatrixVP
    // ======================================================================
    var CAMERA = { near: 0.3, far: 1000, a: 0, b: 1.7320508, right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1], live: false };
    function updateCamera(w, h) {
        var aspect = w / Math.max(1, h);
        var v = vpMat;
        if (v) {
            // VP = P * V. P's last row is (0, 0, -1, 0), so VP's last row is -V's third row (the camera's back axis), its
            // third row is c * (that) + (0, 0, 0, d) with c = -(f+n)/(f-n), d = -2fn/(f-n), and rows 0 and 1 are the right
            // and up axes scaled by 1/(tan(fov/2)*aspect) and 1/tan(fov/2).
            var r3 = [v[3], v[7], v[11], v[15]], r2 = [v[2], v[6], v[10], v[14]];
            var n3 = Math.hypot(r3[0], r3[1], r3[2]);
            if (n3 > 1e-6) {
                var c = -(r2[0] * r3[0] + r2[1] * r3[1] + r2[2] * r3[2]) / (n3 * n3), d = r2[3] + c * r3[3];
                var near = d / (c - 1), far = d / (c + 1);
                var a = Math.hypot(v[0], v[4], v[8]) / n3, b = Math.hypot(v[1], v[5], v[9]) / n3;
                if (isFinite(near) && isFinite(far) && near > 0.001 && far > near * 2 && a > 0.1 && b > 0.1) {
                    CAMERA.near = near; CAMERA.far = Math.min(far, 1e6); CAMERA.a = a; CAMERA.b = b;
                    var na = Math.hypot(v[0], v[4], v[8]) || 1, nb = Math.hypot(v[1], v[5], v[9]) || 1;
                    CAMERA.right = [v[0] / na, v[4] / na, v[8] / na];
                    CAMERA.up = [v[1] / nb, v[5] / nb, v[9] / nb];
                    CAMERA.back = [-r3[0] / n3, -r3[1] / n3, -r3[2] / n3];
                    CAMERA.live = true;
                }
            }
        }
        if (!CAMERA.live) { CAMERA.b = 1.7320508; CAMERA.a = CAMERA.b / aspect; }   // Unity's default 60-degree camera until the matrix shows up
        return CAMERA;
    }
    function lightInView(dirW) {
        var C = CAMERA;
        var L = [C.right[0] * dirW[0] + C.right[1] * dirW[1] + C.right[2] * dirW[2], C.up[0] * dirW[0] + C.up[1] * dirW[1] + C.up[2] * dirW[2], C.back[0] * dirW[0] + C.back[1] * dirW[1] + C.back[2] * dirW[2]];
        var uv = [0.5, 0.5], front = 0;
        if (L[2] < -1e-3) { uv = [0.5 + 0.5 * C.a * L[0] / -L[2], 0.5 + 0.5 * C.b * L[1] / -L[2]]; front = 1; }
        return { dir: L, uv: uv, front: front };
    }

    // ======================================================================
    // Resources
    // ======================================================================
    function compile(type, src) {
        var sh = g.createShader(type);
        g.shaderSource(sh, src); g.compileShader(sh);
        if (!g.getShaderParameter(sh, gl.COMPILE_STATUS)) { var log = g.getShaderInfoLog(sh); g.deleteShader(sh); throw new Error(log); }
        return sh;
    }
    var UNIFORMS = ["uTex", "uTex2", "uTex3", "uDepth", "uRes", "uTexel", "uTime", "uHue", "uSpeed", "uAmount", "uP", "uQ", "uCam", "uRot", "uLight", "uLightUV"];
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
            UNIFORMS.forEach(function (n) { p.u[n] = g.getUniformLocation(prog, n); });
        } catch (e) {
            stats.failed++; warn("shader '" + fsName + "' failed: " + e.message);
            p = null;
        }
        res.programs[fsName] = p;
        return p;
    }
    function makeTex(w, h, fmt, filter) {
        var tex = g.createTexture();
        g.bindTexture(gl.TEXTURE_2D, tex);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        g.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, null);
        return tex;
    }
    function makeTarget(w, h, fmt) {
        var tex = makeTex(w, h, fmt, gl.LINEAR);
        var fbo = g.createFramebuffer();
        g.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        g.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        var ok = g.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        return { tex: tex, fbo: fbo, w: w, h: h, ok: ok };
    }
    function dropTarget(b) { if (!b) return; if (b.fbo) g.deleteFramebuffer(b.fbo); if (b.tex) g.deleteTexture(b.tex); if (b.depth) g.deleteTexture(b.depth); }
    // The lighting's stand-in for the canvas: colour + a depth-stencil texture the passes can sample.
    function makeMain(w, h) {
        var m = { w: w, h: h, tex: makeTex(w, h, gl.RGBA, gl.LINEAR), depth: null, fbo: g.createFramebuffer(), ok: false, depthOk: false };
        g.bindFramebuffer(gl.FRAMEBUFFER, m.fbo);
        g.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, m.tex, 0);
        var depthTexOk = false;
        try {
            if (isGL2) {
                m.depth = g.createTexture(); g.bindTexture(gl.TEXTURE_2D, m.depth);
                g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                g.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH24_STENCIL8, w, h, 0, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8, null);
                g.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, m.depth, 0);
                depthTexOk = true;
            } else {
                var ext = g.getExtension("WEBGL_depth_texture");
                if (ext) {
                    m.depth = g.createTexture(); g.bindTexture(gl.TEXTURE_2D, m.depth);
                    g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); g.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    g.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_STENCIL, w, h, 0, gl.DEPTH_STENCIL, ext.UNSIGNED_INT_24_8_WEBGL, null);
                    g.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, m.depth, 0);
                    depthTexOk = true;
                }
            }
        } catch (e) { depthTexOk = false; }
        if (depthTexOk && g.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) { m.ok = true; m.depthOk = true; }
        else {
            // no sampleable depth: give the game a plain depth-stencil renderbuffer so it still renders correctly
            if (m.depth) { g.deleteTexture(m.depth); m.depth = null; }
            var rb = g.createRenderbuffer(); g.bindRenderbuffer(gl.RENDERBUFFER, rb);
            g.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, w, h);
            g.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
            g.bindRenderbuffer(gl.RENDERBUFFER, null);
            m.rb = rb; m.ok = g.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        }
        stats.depth = m.depthOk ? (isGL2 ? "texture" : "ext") : "none";
        return m;
    }
    // Called from the game's bindFramebuffer(null) while redirecting: the stand-in must exist and match the canvas size.
    // It allocates in the middle of the game's frame only when the canvas has just been resized.
    function ensureMain() {
        if (!res) return false;
        var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        if (!(w > 0 && h > 0)) return false;
        if (res.main && res.main.w === w && res.main.h === h) return res.main.ok;
        var prev = g.getParameter(gl.FRAMEBUFFER_BINDING), prevRead = isGL2 ? g.getParameter(gl.READ_FRAMEBUFFER_BINDING) : null;
        var prevTex = g.getParameter(gl.TEXTURE_BINDING_2D), prevRb = g.getParameter(gl.RENDERBUFFER_BINDING);
        var prevUnpack = isGL2 ? g.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) : null;
        if (isGL2) g.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        if (res.main) { dropTarget(res.main); if (res.main.rb) g.deleteRenderbuffer(res.main.rb); }
        res.main = makeMain(w, h);
        g.bindTexture(gl.TEXTURE_2D, prevTex);
        g.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
        if (isGL2) { g.bindBuffer(gl.PIXEL_UNPACK_BUFFER, prevUnpack); g.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prev); g.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead); }
        else g.bindFramebuffer(gl.FRAMEBUFFER, prev);
        if (!res.main.ok) warn("lighting framebuffer incomplete; lighting disabled");
        return res.main.ok;
    }
    function dropResources() {
        if (!res) return;
        try {
            Object.keys(res.buffers).forEach(function (k) { dropTarget(res.buffers[k]); });
            if (res.main) { dropTarget(res.main); if (res.main.rb) g.deleteRenderbuffer(res.main.rb); }
            Object.keys(res.programs).forEach(function (k) { if (res.programs[k]) g.deleteProgram(res.programs[k].prog); });
            if (res.quad) g.deleteBuffer(res.quad);
            if (res.vao && vaoMode === "gl2") g.deleteVertexArray(res.vao);
            else if (res.vao && vaoExt) vaoExt.deleteVertexArrayOES(res.vao);
        } catch (e) { /* context may be gone */ }
        res = null; redirectActive = false;
    }
    function ensureResources(w, h) {
        if (res && res.w === w && res.h === h) return true;
        var programs = res ? res.programs : null, quad = res ? res.quad : null, vao = res ? res.vao : null, main = res ? res.main : null;
        if (res) { Object.keys(res.buffers).forEach(function (k) { dropTarget(res.buffers[k]); }); }
        var attrs = null; try { attrs = g.getContextAttributes(); } catch (e) { /* ignore */ }
        var sceneFmt = (attrs && attrs.alpha === false) ? gl.RGB : gl.RGBA;   // copyTexSubImage2D needs the texture to match the canvas
        var hw = Math.max(1, Math.round(w / 2)), hh = Math.max(1, Math.round(h / 2));
        res = { w: w, h: h, programs: programs || {}, quad: quad, vao: vao, main: main, buffers: {} };
        res.buffers.scene = { tex: makeTex(w, h, sceneFmt, gl.LINEAR), fbo: null, w: w, h: h, ok: true };   // the capture is never rendered into
        res.buffers.a = makeTarget(w, h, gl.RGBA);
        res.buffers.b = makeTarget(w, h, gl.RGBA);
        res.buffers.lit = makeTarget(w, h, gl.RGBA);
        res.buffers.h1 = makeTarget(hw, hh, gl.RGBA);
        res.buffers.h2 = makeTarget(hw, hh, gl.RGBA);
        res.buffers.h3 = makeTarget(hw, hh, gl.RGBA);
        g.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!res.quad) {
            res.quad = g.createBuffer();
            g.bindBuffer(gl.ARRAY_BUFFER, res.quad);
            g.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle covers the screen
            if (vaoMode === "gl2") { res.vao = g.createVertexArray(); g.bindVertexArray(res.vao); }
            else if (vaoMode === "oes") { res.vao = vaoExt.createVertexArrayOES(); vaoExt.bindVertexArrayOES(res.vao); }
            if (vaoMode !== "none") {
                g.bindBuffer(gl.ARRAY_BUFFER, res.quad);
                g.enableVertexAttribArray(0);
                g.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
                if (vaoMode === "gl2") g.bindVertexArray(null); else vaoExt.bindVertexArrayOES(null);
            }
        }
        var ok = ["a", "b", "lit", "h1", "h2", "h3"].every(function (k) { return res.buffers[k].ok; });
        if (!ok) warn("framebuffers incomplete; post-processing disabled");
        return ok;
    }

    // ======================================================================
    // Presenting a frame
    // ======================================================================
    var TEX_UNITS = 4;
    function saveState() {
        var s = {};
        s.program = g.getParameter(gl.CURRENT_PROGRAM);
        s.fb = g.getParameter(gl.FRAMEBUFFER_BINDING);
        if (isGL2) s.readFb = g.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        s.arrayBuf = g.getParameter(gl.ARRAY_BUFFER_BINDING);
        s.activeTex = g.getParameter(gl.ACTIVE_TEXTURE);
        s.tex = [];
        s.samplers = [];
        for (var i = 0; i < TEX_UNITS; i++) {
            g.activeTexture(gl.TEXTURE0 + i); s.tex.push(g.getParameter(gl.TEXTURE_BINDING_2D));
            if (isGL2) { s.samplers.push(g.getParameter(gl.SAMPLER_BINDING)); g.bindSampler(i, null); }   // a sampler object would override the pass textures' filtering
        }
        s.viewport = g.getParameter(gl.VIEWPORT);
        s.scissor = g.isEnabled(gl.SCISSOR_TEST);
        s.blend = g.isEnabled(gl.BLEND);
        s.depth = g.isEnabled(gl.DEPTH_TEST);
        s.stencil = g.isEnabled(gl.STENCIL_TEST);
        s.cull = g.isEnabled(gl.CULL_FACE);
        s.colorMask = g.getParameter(gl.COLOR_WRITEMASK);
        s.sampleCov = g.isEnabled(gl.SAMPLE_COVERAGE); s.a2c = g.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE);
        s.renderbuffer = g.getParameter(gl.RENDERBUFFER_BINDING);
        if (isGL2) {
            s.discard = g.isEnabled(gl.RASTERIZER_DISCARD);
            s.unpackBuf = g.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
        }
        if (vaoMode === "gl2") s.vao = g.getParameter(gl.VERTEX_ARRAY_BINDING);
        else if (vaoMode === "oes") s.vao = g.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES);
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
        if (vaoMode === "gl2") g.bindVertexArray(s.vao);
        else if (vaoMode === "oes") vaoExt.bindVertexArrayOES(s.vao);
        else {
            for (var a = 0; a < s.attribs.length; a++) { if (s.attribs[a]) g.enableVertexAttribArray(a); else g.disableVertexAttribArray(a); }
            g.bindBuffer(gl.ARRAY_BUFFER, s.attrib0.buf);
            if (s.attrib0.buf) g.vertexAttribPointer(0, s.attrib0.size, s.attrib0.type, s.attrib0.norm, s.attrib0.stride, s.attrib0.off);
            g.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.elementBuf);
        }
        g.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuf);
        for (var i = 0; i < TEX_UNITS; i++) { g.activeTexture(gl.TEXTURE0 + i); g.bindTexture(gl.TEXTURE_2D, s.tex[i]); if (isGL2) g.bindSampler(i, s.samplers[i]); }
        g.activeTexture(s.activeTex);
        g.bindRenderbuffer(gl.RENDERBUFFER, s.renderbuffer);
        if (isGL2) g.bindBuffer(gl.PIXEL_UNPACK_BUFFER, s.unpackBuf);
        g.useProgram(s.program);
        // The game believes the canvas is bound whenever its own binding was null (or our stand-in). Whether that is the
        // real canvas or the lighting framebuffer for the next frame depends on the redirect decided this frame.
        var standIn = redirectActive && res.main ? res.main.fbo : null;
        var fb = gl.__slopeFbNull !== false ? standIn : s.fb;
        var readFb = gl.__slopeReadNull !== false ? standIn : s.readFb;
        if (isGL2) { g.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb); g.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb); }
        else g.bindFramebuffer(gl.FRAMEBUFFER, fb);
        g.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
        (s.scissor ? g.enable : g.disable)(gl.SCISSOR_TEST);
        (s.blend ? g.enable : g.disable)(gl.BLEND);
        (s.depth ? g.enable : g.disable)(gl.DEPTH_TEST);
        (s.stencil ? g.enable : g.disable)(gl.STENCIL_TEST);
        (s.cull ? g.enable : g.disable)(gl.CULL_FACE);
        if (isGL2) (s.discard ? g.enable : g.disable)(gl.RASTERIZER_DISCARD);
        (s.sampleCov ? g.enable : g.disable)(gl.SAMPLE_COVERAGE);
        (s.a2c ? g.enable : g.disable)(gl.SAMPLE_ALPHA_TO_COVERAGE);
        g.colorMask(s.colorMask[0], s.colorMask[1], s.colorMask[2], s.colorMask[3]);
    }

    function speedNorm() {
        try { var v = window.SlopeMod && SlopeMod.speed ? SlopeMod.speed() : 0; return Math.max(0, Math.min(1, v / SPEED_REF)); } catch (e) { return 0; }
    }

    // The chain for this frame: the light's passes (writing "lit", or the screen when the style has none), then the
    // style's passes with their "scene" inputs reading "lit".
    function buildChain(light, style) {
        var lp = light && !light.failed ? light.passes : [], sp = style && !style.failed ? style.passes : [];
        if (!lp.length) return sp;
        var chain = lp.map(function (p, i) { return Object.assign({}, p, { _light: true, out: (i === lp.length - 1 && !sp.length) ? "screen" : p.out }); });
        sp.forEach(function (p) { chain.push(Object.assign({}, p, { in: p.in === "scene" ? "lit" : p.in, in2: p.in2 === "scene" ? "lit" : p.in2, in3: p.in3 === "scene" ? "lit" : p.in3 })); });
        return chain;
    }

    function present() {
        stats.frames++;
        var style = STYLES[styleId], light = LIGHTS[lightId];
        var wasRedirected = redirectActive && res && res.main && res.main.ok;
        var chain = enabled && gl ? buildChain(light, style) : [];
        if (!gl || (gl.isContextLost && gl.isContextLost())) { stats.passes = 0; return; }
        var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        if (!(w > 0 && h > 0)) return;
        if (!chain.length && !wasRedirected) { stats.passes = 0; redirectActive = false; return; }
        var tStart = now();
        var state = saveState();   // before anything is allocated: allocation binds textures, buffers and framebuffers
        var drawn = 0;
        try {
            g.activeTexture(gl.TEXTURE0);
            if (isGL2) g.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
            if (!ensureResources(w, h)) { if (style) style.failed = true; redirectActive = false; return; }
            var sceneBuf;
            if (wasRedirected && res.main.w === w && res.main.h === h) {
                sceneBuf = res.main;   // the game drew into the stand-in this frame: colour and depth are already textures
            } else {
                sceneBuf = res.buffers.scene;
                g.bindFramebuffer(gl.FRAMEBUFFER, null);
                g.activeTexture(gl.TEXTURE0);
                g.bindTexture(gl.TEXTURE_2D, sceneBuf.tex);
                g.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
            }
            if (!chain.length) {
                // lighting was just switched off while the frame went to the stand-in: show it as it is
                chain = [{ fs: "lcomp", in: "scene", in2: "scene", in3: "scene", out: "screen", p: [0, 0, 0], q: [0] }];
            }
            g.disable(gl.SCISSOR_TEST); g.disable(gl.BLEND); g.disable(gl.DEPTH_TEST); g.disable(gl.STENCIL_TEST); g.disable(gl.CULL_FACE);
            g.disable(gl.SAMPLE_COVERAGE); g.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            if (isGL2) g.disable(gl.RASTERIZER_DISCARD);
            g.colorMask(true, true, true, true);
            if (vaoMode === "gl2") g.bindVertexArray(res.vao);
            else if (vaoMode === "oes") vaoExt.bindVertexArrayOES(res.vao);
            else { g.bindBuffer(gl.ARRAY_BUFFER, res.quad); g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); }

            var t = (now() - t0) / 1000, hue = (t / HUE_PERIOD) % 1, speed = speedNorm();
            var cam = updateCamera(w, h);
            var hasDepth = !!(sceneBuf.depth) ? 1 : 0;
            var lv = light && light.dir ? lightInView(light.dir) : { dir: [0, 0, 1], uv: [0.5, 0.5], front: 0 };
            var rot = [cam.right[0], cam.right[1], cam.right[2], cam.up[0], cam.up[1], cam.up[2], cam.back[0], cam.back[1], cam.back[2]];
            for (var i = 0; i < chain.length; i++) {
                var pass = chain[i], p = program(pass.fs);
                if (!p) { if (pass._light && light) light.failed = true; else if (style) style.failed = true; break; }
                var src = pass.in === "scene" ? sceneBuf : (res.buffers[pass.in] || sceneBuf);
                var src2 = pass.in2 ? (pass.in2 === "scene" ? sceneBuf : res.buffers[pass.in2]) : src;
                var src3 = pass.in3 ? (pass.in3 === "scene" ? sceneBuf : res.buffers[pass.in3]) : src2;
                var dst = pass.out === "screen" ? null : res.buffers[pass.out];
                g.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
                var ow = dst ? dst.w : w, oh = dst ? dst.h : h;
                g.viewport(0, 0, ow, oh);
                g.useProgram(p.prog);
                g.activeTexture(gl.TEXTURE0); g.bindTexture(gl.TEXTURE_2D, src.tex);
                g.activeTexture(gl.TEXTURE1); g.bindTexture(gl.TEXTURE_2D, src2.tex);
                g.activeTexture(gl.TEXTURE2); g.bindTexture(gl.TEXTURE_2D, src3.tex);
                g.activeTexture(gl.TEXTURE3); g.bindTexture(gl.TEXTURE_2D, sceneBuf.depth || src.tex);
                g.uniform1i(p.u.uTex, 0); g.uniform1i(p.u.uTex2, 1); g.uniform1i(p.u.uTex3, 2); g.uniform1i(p.u.uDepth, 3);
                g.uniform2f(p.u.uRes, ow, oh); g.uniform2f(p.u.uTexel, 1 / src.w, 1 / src.h);
                g.uniform1f(p.u.uTime, t); g.uniform1f(p.u.uHue, hue); g.uniform1f(p.u.uSpeed, speed); g.uniform1f(p.u.uAmount, intensity);
                var P = pass.p || [], Q = pass.q || [];
                g.uniform4f(p.u.uP, P[0] || 0, P[1] || 0, P[2] || 0, P[3] || 0);
                g.uniform4f(p.u.uQ, Q[0] || 0, Q[1] || 0, Q[2] || 0, Q[3] || 0);
                if (p.u.uCam) g.uniform4f(p.u.uCam, cam.a, cam.b, cam.near, cam.far);
                if (p.u.uRot) g.uniformMatrix3fv(p.u.uRot, false, rot);
                if (p.u.uLight) g.uniform4f(p.u.uLight, lv.dir[0], lv.dir[1], lv.dir[2], hasDepth);
                if (p.u.uLightUV) g.uniform4f(p.u.uLightUV, lv.uv[0], lv.uv[1], lv.front, hasDepth);
                g.drawArrays(gl.TRIANGLES, 0, 3);
                drawn++;
            }
        } finally {
            // decide where the game draws next frame, then put its state back
            redirectActive = !!(enabled && light && light.dir && !light.failed && ensureMain());
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
    var styleSel = null, lightSel = null, fxRange = null;
    function setStyle(id) {
        if (!STYLES[id]) return false;
        styleId = id; lsSet(KEY_STYLE, id);
        if (styleSel && styleSel.value !== id) styleSel.value = id;
        return true;
    }
    function setLight(id) {
        if (!LIGHTS[id]) return false;
        lightId = id; lsSet(KEY_LIGHT, id);
        if (lightSel && lightSel.value !== id) lightSel.value = id;
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
    function nextLight(step) {
        var i = LIGHT_ORDER.indexOf(lightId); if (i < 0) i = 0;
        setLight(LIGHT_ORDER[(i + (step || 1) + LIGHT_ORDER.length) % LIGHT_ORDER.length]);
        return lightId;
    }
    function populate() {
        if (styleSel) {
            styleSel.innerHTML = "";
            ORDER.forEach(function (id) { var o = document.createElement("option"); o.value = id; o.textContent = STYLES[id].name; styleSel.appendChild(o); });
            styleSel.value = styleId;
        }
        if (lightSel) {
            lightSel.innerHTML = "";
            LIGHT_ORDER.forEach(function (id) { var o = document.createElement("option"); o.value = id; o.textContent = LIGHTS[id].name; lightSel.appendChild(o); });
            lightSel.value = lightId;
        }
    }
    function wireHud() {
        styleSel = document.getElementById("hud-style");
        lightSel = document.getElementById("hud-light");
        fxRange = document.getElementById("hud-fx");
        populate();
        if (styleSel) styleSel.addEventListener("change", function () { setStyle(styleSel.value); styleSel.blur(); });
        if (lightSel) lightSel.addEventListener("change", function () { setLight(lightSel.value); lightSel.blur(); });
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
            else if (e.key === "l" || e.key === "L") nextLight(e.shiftKey ? -1 : 1);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireHud); else wireHud();

    function passList(list) { return list.map(function (p) { return { fs: p.fs, in: p.in, in2: p.in2, in3: p.in3, out: p.out, p: p.p, q: p.q }; }); }
    window.SlopeShaders = {
        styles: function () { return ORDER.map(function (id) { return { id: id, name: STYLES[id].name, failed: STYLES[id].failed }; }); },
        style: function () { return styleId; },
        setStyle: setStyle,
        next: nextStyle,
        lights: function () { return LIGHT_ORDER.map(function (id) { return { id: id, name: LIGHTS[id].name, failed: !!LIGHTS[id].failed }; }); },
        light: function () { return lightId; },
        setLight: setLight,
        nextLight: nextLight,
        intensity: function () { return intensity; },
        setIntensity: setIntensity,
        enabled: function () { return enabled; },
        setEnabled: function (b) { enabled = !!b; },
        define: function (id, def) { define(id, def); populate(); return STYLES[id]; },
        passes: function (id) { var s = STYLES[id || styleId]; return s ? passList(s.passes) : (LIGHTS[id] ? passList(LIGHTS[id].passes) : null); },
        camera: function () { return { live: CAMERA.live, near: +CAMERA.near.toFixed(4), far: +CAMERA.far.toFixed(1), fovY: +(2 * Math.atan(1 / CAMERA.b) * 180 / Math.PI).toFixed(2), aspect: +(CAMERA.b / CAMERA.a).toFixed(4), right: CAMERA.right.map(function (v) { return +v.toFixed(3); }), up: CAMERA.up.map(function (v) { return +v.toFixed(3); }), back: CAMERA.back.map(function (v) { return +v.toFixed(3); }) }; },
        onScene: function (fn) { if (typeof fn === "function" && sceneHooks.indexOf(fn) < 0) sceneHooks.push(fn); },
        offScene: function (fn) { var i = sceneHooks.indexOf(fn); if (i >= 0) sceneHooks.splice(i, 1); },
        reset: function () { dropResources(); Object.keys(STYLES).forEach(function (k) { STYLES[k].failed = false; }); Object.keys(LIGHTS).forEach(function (k) { LIGHTS[k].failed = false; }); },
        stats: function () {
            return { enabled: enabled, style: styleId, light: lightId, intensity: intensity, glVersion: gl ? (isGL2 ? 2 : 1) : 0, width: res ? res.w : 0, height: res ? res.h : 0,
                frames: stats.frames, presented: stats.presented, passes: stats.passes, errors: stats.errors, failed: stats.failed, lastPassMs: +stats.lastPassMs.toFixed(2), vao: stats.vao,
                redirect: redirectActive, depth: stats.depth, cameraLive: CAMERA.live,
                styleFailed: !!(STYLES[styleId] && STYLES[styleId].failed), lightFailed: !!(LIGHTS[lightId] && LIGHTS[lightId].failed) };
        }
    };
})();
