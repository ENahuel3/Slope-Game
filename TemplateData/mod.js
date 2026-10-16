/* Slope mod runtime.
 *
 * 1. Network shim: the Unity build phones home to id.net / y8.com for ads,
 *    autologin and leaderboards, and to Unity Analytics. Every XHR, fetch
 *    and injected <script> aimed at those hosts is failed locally before it
 *    leaves the browser. The game already handles "failed to load ads".
 *
 * 2. Stacked courses, built instantly. The game is a set of PlayMaker state
 *    machines, and Unity's SendMessage bridge can switch their states by
 *    name. The mod spawns N-1 hidden courses directly (ball and spawn point
 *    back to the origin, a start section, a few laps each), then triggers the
 *    game's own restart state for the live course. Nothing on that path
 *    despawns old blocks; only a game over's delayed "death complete" does.
 *    When the ball dies the mod waits half a second, despawns the blocks
 *    itself and rebuilds the stack in place, so there is no game-over screen
 *    and no waiting: this is the rapid-Enter glitch without the Enter.
 *
 * 3. Rainbow neon: every fragment shader is rewritten at compile time so
 *    that green-hued output pixels get their hue replaced by a moving
 *    rainbow (a sweep across the screen that cycles over time). Red stays
 *    red. The rotation is applied only for draws that hit the default
 *    framebuffer, so scenes that go through an image-effect pass are
 *    recoloured once, at the final blit.
 *
 * 4. HUD: fullscreen (F, whole page so the HUD stays), R restarts, session
 *    timer, Courses / Rainbow / Music controls, auto-hide while playing.
 *
 * 5. Community editor: typing "awesome" opens a box that asks Claude Code
 *    (via edit-server/) to change this mod; see edit-server/README.md.
 *
 * 6. Gravity modes (Curves / Ramps) by rewriting Unity's gravity vector in
 *    the WebAssembly heap every frame, with the ball tracked the same way.
 */
(function () {
    "use strict";

    // ======================================================================
    // Settings (localStorage, with safe fallbacks)
    // ======================================================================
    var KEY_STACK = "slope-mod.stack";
    var KEY_RAINBOW = "slope-mod.rainbow";
    var KEY_MUSIC = "slope-mod.music";
    var KEY_GRAVITY = "slope-mod.gravity";
    var STACK_MAX = 99;

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }

    var stackTarget = (function () { var n = parseInt(lsGet(KEY_STACK), 10); return (n >= 1 && n <= STACK_MAX) ? n : 1; })();
    var rainbowOn = lsGet(KEY_RAINBOW) !== "0";
    var TRACKS = [
        { id: "original", name: "Original" },
        { id: "aria", name: "Aria Math (Phonk Remix)", file: "TemplateData/music/aria-math-phonk-remix.mp3" },
        { id: "billie", name: "Mort Jackson \u2013 Billie Jean", file: "TemplateData/music/mort-jackson-billie-jean.mp3" }
    ];
    var GRAVITY_MODES = ["off", "curves", "ramps", "both"];
    var gravityMode = (function () { var m = lsGet(KEY_GRAVITY); return GRAVITY_MODES.indexOf(m) >= 0 ? m : "off"; })();
    var musicId = (function () { var id = lsGet(KEY_MUSIC); return TRACKS.some(function (t) { return t.id === id; }) ? id : "original"; })();

    // ======================================================================
    // 1. Network shim
    // ======================================================================
    var BLOCKED = [/(^|\.)id\.net$/i, /(^|\.)y8\.com$/i, /(^|\.)doubleclick\.net$/i,
                   /(^|\.)googlesyndication\.com$/i, /(^|\.)google-analytics\.com$/i,
                   /(^|\.)unity3d\.com$/i];

    function hostOf(url) {
        try { return new URL(String(url), location.href).hostname; } catch (e) { return ""; }
    }
    function isBlocked(url) {
        var h = hostOf(url);
        for (var i = 0; i < BLOCKED.length; i++) if (BLOCKED[i].test(h)) return true;
        return false;
    }

    var blockedCount = 0;
    function noteBlocked(kind, url) {
        blockedCount++;
        if (window.console && console.debug) console.debug("[slope-mod] blocked " + kind + " " + url);
    }

    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__slopeBlocked = isBlocked(url);
        if (this.__slopeBlocked) noteBlocked("xhr", url);
        return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        if (this.__slopeBlocked) {
            var xhr = this;
            // Behave like a network failure, asynchronously, so Unity's
            // UnityWebRequest sees isNetworkError and moves on.
            setTimeout(function () {
                try { xhr.abort(); } catch (e) { /* ignore */ }
                if (typeof xhr.onerror === "function") xhr.onerror(new ProgressEvent("error"));
                else xhr.dispatchEvent(new ProgressEvent("error"));
            }, 0);
            return;
        }
        return xhrSend.apply(this, arguments);
    };

    if (window.fetch) {
        var origFetch = window.fetch;
        window.fetch = function (input) {
            var url = (input && input.url) || input;
            if (isBlocked(url)) {
                noteBlocked("fetch", url);
                return Promise.reject(new TypeError("Blocked by slope-mod: " + url));
            }
            return origFetch.apply(this, arguments);
        };
    }

    var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
    if (srcDesc && srcDesc.set) {
        Object.defineProperty(HTMLScriptElement.prototype, "src", {
            configurable: true,
            enumerable: srcDesc.enumerable,
            get: srcDesc.get,
            set: function (v) {
                if (isBlocked(v)) { noteBlocked("script", v); return; }
                srcDesc.set.call(this, v);
            }
        });
    }
    var origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (this instanceof HTMLScriptElement && String(name).toLowerCase() === "src" && isBlocked(value)) {
            noteBlocked("script", value);
            return;
        }
        return origSetAttr.apply(this, arguments);
    };

    // ======================================================================
    // WebGL hooks shared by the stacker and the rainbow
    // ======================================================================
    // Draw-call fingerprint of this build: a 5190-index draw is the city
    // skyline, which the game spawns once per restart (one second in) and
    // which lives in the same pool as the blocks, so it is a reliable sign
    // that the world has been cleared (count drops to 0) or is in a run.
    var COURSE_BATCH = 5190;

    var frameDraws = [];          // index counts of draws in the frame being rendered
    var defaultFbBound = true;    // is the default framebuffer the current draw target?
    var currentProgram = null;
    var hue = 0;                  // 0..1, advanced every frame when the rainbow is on
    var rainbowTime = 0;          // seconds the rainbow has been running (drives the wave)
    var shaderPatched = 0, shaderFailed = 0;

    var HUE_UNIFORM = "_slopeRainbow";   // vec4: hue phase, 1/width, 1/height, time (s)
    // GLSL helper: replace the hue of green-ish pixels, keep saturation/value.
    // The new hue is a diagonal rainbow across the screen that scrolls with
    // time and ripples with a travelling wave, so the whole scene visibly flows.
    var GLSL_HELPER = [
        "uniform vec4 " + HUE_UNIFORM + ";",
        "vec3 slopeRainbow(vec3 c) {",
        "  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn;",
        "  if (" + HUE_UNIFORM + ".x < 0.0 || mx <= 0.0 || d < 0.03 * mx) return c;",
        "  float h;",
        "  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;",
        "  if (abs(h - 2.0) > 0.9) return c;",                       // keep anything that is not green-ish
        "  vec2 uv = gl_FragCoord.xy * " + HUE_UNIFORM + ".yz;",      // 0..1 across the viewport
        "  float t = " + HUE_UNIFORM + ".w;",
        "  float band = uv.x * 1.4 + uv.y * 0.8;",                    // diagonal sweep, ~2 rainbows corner to corner
        "  float wave = 0.22 * sin(uv.y * 7.0 - t * 2.6) + 0.12 * sin(uv.x * 11.0 + t * 1.7);",
        "  float H = mod((" + HUE_UNIFORM + ".x + band + wave) * 6.0 + (h - 2.0), 6.0);",
        "  float C = d; float X = C * (1.0 - abs(mod(H, 2.0) - 1.0)); float m = mx - C; vec3 r;",
        "  if (H < 1.0) r = vec3(C, X, 0.0); else if (H < 2.0) r = vec3(X, C, 0.0); else if (H < 3.0) r = vec3(0.0, C, X);",
        "  else if (H < 4.0) r = vec3(0.0, X, C); else if (H < 5.0) r = vec3(X, 0.0, C); else r = vec3(C, 0.0, X);",
        "  return r + m;",
        "}"
    ].join("\n");

    function patchFragmentShader(src) {
        var out = null;
        if (/\bSV_Target0\b/.test(src)) out = "SV_Target0";
        else if (/gl_FragData\s*\[\s*0\s*\]/.test(src)) out = "gl_FragData[0]";
        else if (/\bgl_FragColor\b/.test(src)) out = "gl_FragColor";
        if (!out || !/void\s+main\s*\(\s*\)/.test(src)) return null;
        var patched = src.replace(/void\s+main\s*\(\s*\)/, "void slope_main()");
        // Appending keeps every declaration of the original in scope.
        patched += "\n" + GLSL_HELPER + "\nvoid main() { slope_main(); " + out + " = vec4(slopeRainbow(" + out + ".rgb), " + out + ".a); }\n";
        return patched;
    }

    function hookContext(P) {
        var origShaderSource = P.shaderSource, origCompile = P.compileShader;
        var origUse = P.useProgram, origBindFb = P.bindFramebuffer;
        var origDE = P.drawElements, origDA = P.drawArrays;
        var origDEI = P.drawElementsInstanced, origDAI = P.drawArraysInstanced;

        P.shaderSource = function (shader, src) {
            shader.__slopeOrig = src;
            var fs = this.getShaderParameter(shader, this.SHADER_TYPE) === this.FRAGMENT_SHADER;
            var p = fs ? patchFragmentShader(src) : null;
            if (p) { shader.__slopePatched = true; src = p; }
            return origShaderSource.call(this, shader, src);
        };
        P.compileShader = function (shader) {
            origCompile.call(this, shader);
            if (shader.__slopePatched && !this.getShaderParameter(shader, this.COMPILE_STATUS)) {
                // fall back to the untouched shader rather than break rendering
                shaderFailed++;
                if (window.console) console.warn("[slope-mod] rainbow patch rejected by compiler, using original shader:\n" + this.getShaderInfoLog(shader));
                shader.__slopePatched = false;
                origShaderSource.call(this, shader, shader.__slopeOrig);
                origCompile.call(this, shader);
            } else if (shader.__slopePatched) {
                shaderPatched++;
            }
        };
        P.useProgram = function (program) {
            currentProgram = program;
            return origUse.call(this, program);
        };
        P.bindFramebuffer = function (target, fb) {
            if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) defaultFbBound = (fb === null);
            return origBindFb.call(this, target, fb);
        };
        function beforeDraw(gl, count) {
            frameDraws.push(count);
            var prog = currentProgram;
            if (!prog) return;
            if (prog.__slopeHueLoc === undefined) prog.__slopeHueLoc = gl.getUniformLocation(prog, HUE_UNIFORM);
            if (prog.__slopeHueLoc) {
                if (rainbowOn && defaultFbBound) gl.uniform4f(prog.__slopeHueLoc, hue, 1 / (gl.drawingBufferWidth || 1), 1 / (gl.drawingBufferHeight || 1), rainbowTime);
                else gl.uniform4f(prog.__slopeHueLoc, -1.0, 0.0, 0.0, 0.0);
            }
        }
        P.drawElements = function (mode, count) { beforeDraw(this, count); return origDE.apply(this, arguments); };
        P.drawArrays = function (mode, first, count) { beforeDraw(this, count); return origDA.apply(this, arguments); };
        if (origDEI) P.drawElementsInstanced = function (mode, count) { beforeDraw(this, count); return origDEI.apply(this, arguments); };
        if (origDAI) P.drawArraysInstanced = function (mode, first, count) { beforeDraw(this, count); return origDAI.apply(this, arguments); };
    }
    if (window.WebGLRenderingContext) hookContext(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) hookContext(WebGL2RenderingContext.prototype);

    // ======================================================================
    // Audio hook: the run's music track (a ~24 s buffer) is stopped at the
    // instant the ball dies, for falls and crashes alike, and restarted on
    // every restart. That is the earliest death signal there is. The same
    // hook swaps the music: with a custom track selected the game's own
    // track is never started and an <audio> element plays instead, paused
    // and resumed exactly when the game would stop and start its track.
    // ======================================================================
    var MUSIC_MIN_SECONDS = 10;
    var musicStopped = false, musicStarted = false;   // flags for the frame being examined
    var musicNode = null;          // the game's current music source node
    var audioEl = null;            // custom track player
    var absStart = null, absStop = null;

    function isCustomMusic() { return musicId !== "original"; }
    function trackById(id) { for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i]; return TRACKS[0]; }
    function ensureAudio() {
        if (audioEl) return audioEl;
        audioEl = new Audio();
        audioEl.loop = true; audioEl.preload = "auto"; audioEl.volume = 0.8;
        return audioEl;
    }
    function playCustom() {
        var t = trackById(musicId); if (!t.file) return;
        var el = ensureAudio();
        var src = new URL(t.file, location.href).href;
        if (el.src !== src) { el.src = src; }
        var p = el.play(); if (p && p.catch) p.catch(function () { /* autoplay blocked until a gesture; the next restart retries */ });
    }
    function pauseCustom() { if (audioEl && !audioEl.paused) audioEl.pause(); }
    function musicNodeElapsed(node) {
        if (!node || node.__slopeStartedAt === undefined) return node && node.__slopeOffset || 0;
        return (node.__slopeOffset || 0) + (node.context.currentTime - node.__slopeStartedAt);
    }

    if (window.AudioBufferSourceNode) {
        absStart = AudioBufferSourceNode.prototype.start; absStop = AudioBufferSourceNode.prototype.stop;
        AudioBufferSourceNode.prototype.start = function (when, offset) {
            this.__slopeDur = this.buffer ? this.buffer.duration : 0;
            if (this.__slopeDur < MUSIC_MIN_SECONDS) return absStart.apply(this, arguments);
            musicStarted = true;
            musicNode = this;
            this.__slopeOffset = offset || 0;
            if (isCustomMusic()) {
                this.__slopeSuppressed = true;              // the game's track stays silent
                playCustom();
                return;
            }
            this.__slopeStartedAt = this.context.currentTime;
            return absStart.apply(this, arguments);
        };
        AudioBufferSourceNode.prototype.stop = function () {
            if (this.__slopeDur >= MUSIC_MIN_SECONDS) {
                musicStopped = true;
                if (this === musicNode) pauseCustom();
                if (this.__slopeSuppressed) return;        // never started: nothing to stop
            }
            return absStop.apply(this, arguments);
        };
    }

    function setMusic(id) {
        var t = trackById(id); id = t.id;
        if (id === musicId) return;
        var was = musicId; musicId = id; lsSet(KEY_MUSIC, id);
        var node = musicNode;
        if (!node) return;
        if (was === "original" && isCustomMusic()) {
            // original playing -> silence it, keep its position, start the custom track
            node.__slopeOffset = musicNodeElapsed(node); node.__slopeStartedAt = undefined;
            try { absStop.call(node); } catch (e) { /* already stopped */ }
            node.__slopeSuppressed = true;
            playCustom();
        } else if (isCustomMusic()) {
            playCustom();                                   // custom -> another custom
        } else if (node.__slopeSuppressed && !node.__slopeDead) {
            // custom -> original: start the game's node where it would have been
            pauseCustom();
            var off = (node.__slopeOffset || 0) % (node.__slopeDur || 1);
            try {
                // a stopped node cannot be restarted: build a fresh one on the same route
                var ctx = node.context, fresh = ctx.createBufferSource();
                fresh.buffer = node.buffer; fresh.loop = node.loop; fresh.loopStart = node.loopStart; fresh.loopEnd = node.loopEnd;
                fresh.__slopeDur = node.__slopeDur; fresh.__slopeOffset = off; fresh.__slopeStartedAt = ctx.currentTime;
                fresh.connect(node.__slopeDest || ctx.destination);
                absStart.call(fresh, 0, off);
                node.__slopeDead = true; musicNode = fresh;
            } catch (e) { /* no route known: resumes at the next restart */ }
        }
    }
    if (window.AudioNode) {
        var nodeConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (dest) {
            if (this instanceof AudioBufferSourceNode) this.__slopeDest = dest;
            return nodeConnect.apply(this, arguments);
        };
    }

    // ======================================================================
    // 2. Stacked courses: instant builder, instant restart (death or R)
    // ======================================================================
    // Hidden courses are spawned directly: Sphere "Restart Game" puts the
    // ball and the spawn point back at the origin, t_Spawner "spawn go tunnel
    // run" drops a start section there, and each "Check score" generates one
    // lap (the spawner's own per-speed-up path, so laps go easy -> medium ->
    // hard like a real run). Only the last course goes through the normal
    // EventManager "resetGame" restart, so the game's own state is clean;
    // "start game" is forced right after it (it wakes the ball and restores
    // the time scale). Sphere "Restart Game" also resets the spawn point, so
    // it is sent only right before a start section (never during laps, or
    // the laps would land inside the start tunnel) and once more just before
    // the final reset, so the live run begins with the ball at the top of the
    // drop whatever the build took.
    //
    // Clearing the world: t_Spawner "DestroyBlocksPool" despawns every block
    // but also sets the time scale to 0, and the despawn only executes once
    // time runs again, so "start game" is forced in the same frame and the
    // build starts two frames later on an empty world.
    //
    // Death: the game queues a "death complete" broadcast 3 s after a death
    // (that is what despawns the course and freezes time at the game-over
    // screen). A restart issued before it lands defuses it, so the mod does
    // a plain restart half a second after the death, then clears, rebuilds
    // and restarts again a few frames later. No game-over screen, no Enter.
    var LAPS_PER_COURSE = 8;       // laps pre-generated on every hidden course
    var FINAL_SETTLE = 8;          // frames between the last lift and the final reset (lets its delayed destroySelf land first)
    var START_AFTER = 2;           // frames after a reset to force "start game"
    var RESET_TIMEOUT = 45;        // frames to wait for the final reset's music restart before one retry
    var DEATH_BEAT = 30;           // frames to show the death before the instant restart
    var DEFUSE_FRAMES = 10;        // frames between the defusing restart and the clear
    var CLEAR_FRAMES = 2;          // frames for the despawn to execute before building
    var RESTART_GRACE = 15;        // a restart also stops the previous track a frame or two later
    var SPAWNER = "t_Spawner", EVENT_MANAGER = "EventManager", SPHERE = "Sphere";

    var lastCourseCount = 0;      // skyline draws in the last frame (diagnostics)
    var builds = 0, resetsSent = 0, deaths = 0, restarts = 0;
    var lastRestart = -1000, gameRunning = false;
    var frameNo = 0, debugLog = [];   // debugLog: last 40 decisions, for diagnostics
    function note(ev) { debugLog.push(frameNo + ':' + ev); if (debugLog.length > 40) debugLog.shift(); }

    // build: null | { phase: "course" | "laps" | "settle" | "final", hidden, hiddenTarget, laps, since, started, tries, lastLift, startSent }
    var build = null;
    // restart: null | { phase: "beat" | "defuse" | "clear", since }
    var restartSeq = null;

    function setState(obj, state) {
        if (!game || typeof game.SendMessage !== "function") return false;
        try { game.SendMessage(obj, "SetState", state); return true; } catch (e) { note("SendMessage failed: " + e); return false; }
    }
    function plainRestart() { setState(EVENT_MANAGER, "resetGame"); }
    function clearWorld() { setState(SPAWNER, "DestroyBlocksPool"); setState(EVENT_MANAGER, "start game"); }
    function liftBall() { setState(SPHERE, "Restart Game"); build.lastLift = frameNo; }
    function startBuild(existing) {
        // `existing` courses are already in the world with their start section
        // at the origin (1 right after a restart, 0 after a clear); they become
        // hidden layers under the ones built here
        build = { phase: existing > 0 ? "laps" : "course", hidden: existing, hiddenTarget: Math.max(stackTarget - 1, 0),
                  laps: 0, since: frameNo, started: frameNo, tries: 0, lastLift: -1000, startSent: false };
        if (build.hidden >= build.hiddenTarget) build.phase = "settle";
        builds++; note("building " + stackTarget + " courses from " + existing);
    }
    function sendFinalReset() {
        resetsSent++; build.tries++;
        setState(EVENT_MANAGER, "resetGame");
        build.phase = "final"; build.since = frameNo; build.startSent = false;
    }
    function finishBuild(how) {
        note("stack of " + (build.hidden + 1) + " " + how + " in " + (frameNo - build.started) + " frames");
        build = null;
    }
    function stepBuild(restarted) {
        if (build.phase === "course") {
            liftBall();                                   // ball to the top, SpawnPos -> origin
            setState(SPAWNER, "spawn go tunnel run");     // start section there
            build.hidden++; build.laps = 0; build.phase = "laps";
        } else if (build.phase === "laps") {
            if (build.laps < LAPS_PER_COURSE) { setState(SPAWNER, "Check score"); build.laps++; }
            else if (build.hidden < build.hiddenTarget) build.phase = "course";
            else { build.phase = "settle"; build.since = frameNo; }
        } else if (build.phase === "settle") {
            if (build.lastLift < 0) liftBall();
            if (frameNo - build.lastLift >= FINAL_SETTLE) { build.tries = 0; sendFinalReset(); }
        } else {                                          // final
            if (!build.startSent && frameNo - build.since >= START_AFTER) { setState(EVENT_MANAGER, "start game"); build.startSent = true; }
            if (restarted) finishBuild("complete");
            else if (frameNo - build.since > RESET_TIMEOUT) {
                if (build.tries < 2) { note("final reset not confirmed, one retry"); sendFinalReset(); }
                else finishBuild("unconfirmed");
            }
        }
    }
    function stepRestart() {
        var r = restartSeq;
        if (r.phase === "beat") {
            if (frameNo - r.since >= DEATH_BEAT) { plainRestart(); r.phase = "defuse"; r.since = frameNo; r.startSent = false; }
        } else if (r.phase === "defuse") {
            if (!r.startSent && frameNo - r.since >= START_AFTER) { setState(EVENT_MANAGER, "start game"); r.startSent = true; }
            if (frameNo - r.since >= DEFUSE_FRAMES) { clearWorld(); r.phase = "clear"; r.since = frameNo; }
        } else if (frameNo - r.since >= CLEAR_FRAMES) {   // clear
            restartSeq = null;
            startBuild(0);
        }
    }
    function requestRestart(withBeat) {
        if (restartSeq) return;
        build = null; restarts++;
        restartSeq = withBeat ? { phase: "beat", since: frameNo } : { phase: "defuse", since: frameNo - DEFUSE_FRAMES, startSent: true };
        note(withBeat ? "death -> instant restart" : "R -> restart");
    }

    function examineFrame(draws) {
        var c = 0;
        for (var i = 0; i < draws.length; i++) if (draws[i] === COURSE_BATCH) c++;
        lastCourseCount = c;
        var restarted = musicStarted; if (restarted) { lastRestart = frameNo; gameRunning = true; resetGravityRun(); }
        var died = musicStopped && !musicStarted && frameNo - lastRestart > RESTART_GRACE;
        if (died) gameRunning = false;
        if (c === 0 && frameNo - lastRestart > 120) gameRunning = false;   // world cleared / menu
        musicStopped = musicStarted = false;

        if (restartSeq) {
            stepRestart();
        } else if (build) {
            stepBuild(restarted);
        } else if (restarted) {                         // a run just started (Enter at the menu / game over)
            if (stackTarget > 1) startBuild(1);
        } else if (died) {
            deaths++;
            if (stackTarget > 1) requestRestart(true);  // instant restart with the stack rebuilt
        }
    }

    function frameLoop() {
        frameNo++;
        var draws = frameDraws; frameDraws = [];
        try { examineFrame(draws); } catch (e) { /* never break the game loop */ }
        try { stepGravity(gameRunning && !build && !restartSeq); } catch (e) { /* ditto */ }
        if (rainbowOn) { hue = (hue + 1 / 210) % 1; rainbowTime += 1 / 60; }   // hues scroll through a full cycle every 3.5 s
        requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);   // registered before Unity's loop, so it runs first each frame

    // ======================================================================
    // 6. Gravity: the game never exposes physics, but Unity's gravity vector
    //    and the ball's position live at fixed places in the WebAssembly heap.
    //    Both are found by value once the runtime is up (gravity is the
    //    default 0,-9.81,0; the ball rests at its scene position 5,10.5,-4
    //    in the menu) and gravity is rewritten every frame from then on.
    //    Curves: a slow random sideways tilt (the view banks with it).
    //    Ramps: when the ball leaves the ground, a sudden effect until it lands:
    //    a side pull, low gravity or a slam.
    // ======================================================================
    var G0 = -9.8100004196167;
    var gravAddrs = [], ballAddr = -1, ballCands = [];
    var gravNow = [0, G0, 0], gravWritten = false;
    var ballPos = null, ballVel = [0, 0, 0], ballT = 0, relHist = [];
    var curve = { t: 0, p1: 0, p2: 0, p3: 0 };
    var ramp = null;                 // { kind, until, since }
    var rampCooldownUntil = 0, airborneFrames = 0, groundFrames = 0;
    var gravDebug = { events: 0, lastRel: 0, lastKind: "" };
    var canvasEl = null, gravBadge = null;

    function heap32() { return game && game.Module ? game.Module.HEAPF32 : null; }
    function heapU32() { return game && game.Module ? game.Module.HEAPU32 : null; }
    function fbits(f) { var b = new Float32Array([f]); return new Uint32Array(b.buffer)[0]; }
    function findTriple(a, b, c) {
        var u = heapU32(); if (!u) return [];
        var A = fbits(a), B = fbits(b), C = fbits(c), out = [];
        for (var i = 0, n = u.length - 2; i < n; i++) if (u[i] === A && u[i + 1] === B && u[i + 2] === C) out.push(i);
        return out;
    }
    function discoverHeap() {
        try {
            if (!gravAddrs.length) gravAddrs = findTriple(0, G0, 0);
            if (ballAddr < 0 && !ballCands.length) ballCands = findTriple(5, 10.5, -4);
            note("heap: gravity x" + gravAddrs.length + ", ball candidates " + ballCands.length);
        } catch (e) { note("heap scan failed: " + e); }
    }
    function writeGravity(x, y, z) {
        var f = heap32(); if (!f || !gravAddrs.length) return;
        gravNow = [x, y, z];
        for (var i = 0; i < gravAddrs.length; i++) { var a = gravAddrs[i]; f[a] = x; f[a + 1] = y; f[a + 2] = z; }
        gravWritten = !(x === 0 && y === G0 && z === 0);
    }
    function trackBall() {
        var f = heap32(); if (!f) return;
        if (ballAddr < 0) {
            // pick the first candidate that has moved away from the rest position
            for (var i = 0; i < ballCands.length; i++) { var a = ballCands[i]; if (Math.abs(f[a] - 5) > 0.05 || Math.abs(f[a + 1] - 10.5) > 0.05 || Math.abs(f[a + 2] + 4) > 0.05) { ballAddr = a; note("ball tracked at " + a); break; } }
            if (ballAddr < 0) return;
        }
        var now = performance.now();
        var p = [f[ballAddr], f[ballAddr + 1], f[ballAddr + 2]];
        if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2]) || Math.abs(p[0]) > 1e5) { ballAddr = -1; return; }
        if (ballPos && ballT) {
            var dt = Math.min(0.1, Math.max(0.004, (now - ballT) / 1000));
            var v = [(p[0] - ballPos[0]) / dt, (p[1] - ballPos[1]) / dt, (p[2] - ballPos[2]) / dt];
            ballVel = [ballVel[0] * 0.5 + v[0] * 0.5, ballVel[1] * 0.5 + v[1] * 0.5, ballVel[2] * 0.5 + v[2] * 0.5];
        }
        ballPos = p; ballT = now;
    }
    // vertical speed relative to the 45-degree descent: 0 when rolling, > 0 when launched off a ramp
    function relLift() { return ballVel[1] + Math.abs(ballVel[2]); }

    var RAMP_KINDS = [
        { kind: "left", w: 3, g: function () { return [-14, G0, 0]; }, label: "← gravity" },
        { kind: "right", w: 3, g: function () { return [14, G0, 0]; }, label: "gravity →" },
        { kind: "floaty", w: 2, g: function () { return [0, -1.5, 0]; }, label: "low gravity" },
        { kind: "slam", w: 2, g: function () { return [0, -45, 0]; }, label: "heavy gravity" }
    ];
    function pickRamp() {
        var total = 0, i; for (i = 0; i < RAMP_KINDS.length; i++) total += RAMP_KINDS[i].w;
        var r = Math.random() * total;
        for (i = 0; i < RAMP_KINDS.length; i++) { r -= RAMP_KINDS[i].w; if (r <= 0) return RAMP_KINDS[i]; }
        return RAMP_KINDS[0];
    }
    function resetGravityRun() {
        curve.t = 0; curve.p1 = Math.random() * 6.28; curve.p2 = Math.random() * 6.28; curve.p3 = Math.random() * 6.28;
        ramp = null; airborneFrames = 0; groundFrames = 0; rampCooldownUntil = performance.now() + 2500; relHist = [];
        ballPos = null; ballVel = [0, 0, 0];
    }
    function stepGravity(playing) {
        if (!gravAddrs.length) return;
        var mode = gravityMode;
        if (mode === "off" || !playing) {
            if (gravWritten) { writeGravity(0, G0, 0); setView(0, 1, ""); }
            return;
        }
        trackBall();
        var now = performance.now();
        var gx = 0, gy = G0, gz = 0, label = "";
        if (mode === "curves" || mode === "both") {
            curve.t += 1 / 60;
            var amp = 4.5 * Math.min(2, 1 + curve.t / 40);                       // grows slowly over a long run
            var tilt = 0.6 * Math.sin(6.2832 * curve.t / 9.3 + curve.p1) + 0.3 * Math.sin(6.2832 * curve.t / 4.1 + curve.p2) + 0.1 * Math.sin(6.2832 * curve.t / 1.7 + curve.p3);
            gx = amp * tilt;
        }
        if (mode === "ramps" || mode === "both") {
            var rel = relLift(); gravDebug.lastRel = rel;
            if (ramp) {
                var g = ramp.def.g();
                gx += g[0]; gy = g[1]; label = ramp.def.label;
                // landed: lift back to ~0 for a few frames, or time out
                if (Math.abs(rel) < 2 && ballVel[1] < 0.5) groundFrames++; else groundFrames = 0;
                if (now > ramp.until || groundFrames >= 6) { ramp = null; rampCooldownUntil = now + 1500; }
            } else if (ballAddr >= 0 && now > rampCooldownUntil) {
                if (rel > 5 && ballVel[1] > 0.5) airborneFrames++; else airborneFrames = 0;
                if (airborneFrames >= 3) {
                    ramp = { def: pickRamp(), until: now + 2200, since: now }; gravDebug.events++; gravDebug.lastKind = ramp.def.kind;
                    groundFrames = 0; airborneFrames = 0;
                    note("ramp -> " + ramp.def.kind + " (lift " + rel.toFixed(1) + ")");
                }
            }
        }
        writeGravity(gx, gy, gz);
        var bank = -gx * 0.55;                                                   // degrees of view roll per m/s^2 of side pull
        var zoom = ramp && ramp.def.kind === "floaty" ? 0.96 : (ramp && ramp.def.kind === "slam" ? 1.04 : 1);
        setView(bank, zoom, label);
    }
    var viewLast = "";
    function setView(bankDeg, zoom, label) {
        if (!canvasEl) canvasEl = document.querySelector("#gameContainer canvas");
        var key = bankDeg.toFixed(1) + "|" + zoom + "|" + label;
        if (key === viewLast) return; viewLast = key;
        if (canvasEl) canvasEl.style.transform = (bankDeg || zoom !== 1) ? "scale(" + (1.12 * zoom).toFixed(3) + ") rotate(" + bankDeg.toFixed(2) + "deg)" : "";
        if (gravBadge) { gravBadge.textContent = label; gravBadge.classList.toggle("on", !!label); }
    }
    function setGravityMode(m) {
        if (GRAVITY_MODES.indexOf(m) < 0) m = "off";
        gravityMode = m; lsSet(KEY_GRAVITY, m);
        if (m === "off") { writeGravity(0, G0, 0); setView(0, 1, ""); }
    }

    // ======================================================================
    // 4. HUD
    // ======================================================================
    // Unity registers capture-phase key listeners on window that call
    // preventDefault() on every key event, which kills typing in any page
    // input. This listener is registered first (mod.js loads before the Unity
    // loader), so it can shield the HUD's input: events aimed at it stop here.
    var STACK_INPUT_ID = "hud-stack";
    ["keydown", "keypress", "keyup"].forEach(function (type) {
        window.addEventListener(type, function (e) {
            var t = e.target;
            if (!t || (t.id !== STACK_INPUT_ID && t.id !== "hud-music" && t.id !== "hud-gravity" && !(t.closest && t.closest("#edit-panel")))) return;
            e.stopImmediatePropagation();
            if (type === "keydown" && (e.key === "Enter" || e.key === "Escape") && t.tagName !== "TEXTAREA") { e.preventDefault(); t.blur(); }
        }, true);
    });

    var game = null;
    var hud, timerEl, fsBtn, stackInput, rainbowBox, musicSel, gravSel;
    var startedAt = Date.now();
    var hideTimer = null;

    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function tickTimer() {
        if (!timerEl) return;
        var s = Math.floor((Date.now() - startedAt) / 1000);
        var m = Math.floor(s / 60); s %= 60;
        var h = Math.floor(m / 60); m %= 60;
        timerEl.textContent = (h ? h + ":" : "") + pad(m) + ":" + pad(s);
    }

    function showHud() {
        if (!hud) return;
        hud.classList.remove("hidden");
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            var ae = document.activeElement;
            if (ae === stackInput || ae === musicSel || ae === gravSel) return;   // keep it visible while choosing
            hud.classList.add("hidden");
        }, 2500);
    }

    function setStackTarget(n) {
        n = parseInt(n, 10);
        if (!(n >= 1)) n = 1;
        if (n > STACK_MAX) n = STACK_MAX;
        stackTarget = n;                                // applies at the next run, restart or R
        lsSet(KEY_STACK, n);
        if (stackInput && String(stackInput.value) !== String(n)) stackInput.value = n;
    }

    function toggleFullscreen() {
        // the whole page goes fullscreen (not just the canvas) so the HUD stays usable
        if (document.fullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
            return;
        }
        var root = document.documentElement;
        if (root.requestFullscreen) root.requestFullscreen().catch(function () { /* denied */ });
    }

    // ======================================================================
    // 5. Community editor: type "awesome" to open a box that sends a request
    //    to the slope-edit service (edit-server/), which runs Claude Code on a
    //    sandboxed clone and publishes the change for everyone.
    // ======================================================================
    var EDIT_API = (window.SLOPE_EDIT_API || "").replace(/\/+$/, "");
    var MAGIC = "awesome";
    var typed = "";
    var panel = null, editBox = null, editSend = null, editStatus = null, editLog = null, editBudget = null;
    var editJob = null, editPoll = null;

    function api(pathname, opts) {
        if (!EDIT_API) return Promise.reject(new Error("The editor is not connected on this page."));
        return fetch(EDIT_API + pathname, Object.assign({ cache: "no-store" }, opts || {})).then(function (r) {
            return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
        });
    }
    function fmtUsd(x) { return "$" + (Math.round(x * 100) / 100).toFixed(2); }
    function refreshBudget() {
        if (!editBudget) return;
        api("/api/status").then(function (st) {
            var b = st.budget;
            editBudget.textContent = "Budget today " + fmtUsd(b.dayUsed) + " / " + fmtUsd(b.dayCap) + " · month " + fmtUsd(b.monthUsed) + " / " + fmtUsd(b.monthCap) +
                (st.queue ? " · " + st.queue + " waiting" : "") + (st.running ? " · one running" : "");
        }).catch(function (e) { editBudget.textContent = e.message; });
    }
    function buildPanel() {
        if (panel) return panel;
        panel = document.createElement("div");
        panel.id = "edit-panel";
        panel.className = "edit-panel";
        panel.innerHTML =
            '<div class="edit-head"><span class="edit-title">Edit this game with Claude</span>' +
            '<button type="button" class="edit-close" title="Close (Esc)">×</button></div>' +
            '<p class="edit-hint">Describe a change to the mod (visuals, HUD, rules, rainbow…). Claude Code edits the game files in a sandbox, the result is checked and published for everyone. Keep it small and specific.</p>' +
            '<textarea class="edit-box" rows="3" maxlength="700" placeholder="e.g. make the ball leave a short glowing trail"></textarea>' +
            '<div class="edit-row"><button type="button" class="edit-send hud-btn">Send to Claude</button><span class="edit-status"></span></div>' +
            '<pre class="edit-log"></pre>' +
            '<div class="edit-budget"></div>';
        document.body.appendChild(panel);
        editBox = panel.querySelector(".edit-box"); editSend = panel.querySelector(".edit-send");
        editStatus = panel.querySelector(".edit-status"); editLog = panel.querySelector(".edit-log"); editBudget = panel.querySelector(".edit-budget");
        panel.querySelector(".edit-close").addEventListener("click", closePanel);
        editSend.addEventListener("click", submitEdit);
        editBox.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitEdit(); });
        return panel;
    }
    function openPanel() {
        buildPanel(); panel.classList.add("open"); showHud();
        if (!EDIT_API) { editStatus.textContent = "The editor is not connected on this page (no SLOPE_EDIT_API)."; editSend.disabled = true; }
        else refreshBudget();
        setTimeout(function () { editBox.focus(); }, 50);
    }
    function closePanel() { if (panel) panel.classList.remove("open"); if (editBox) editBox.blur(); }
    function setLog(lines) { editLog.textContent = (lines || []).join("\n"); editLog.scrollTop = editLog.scrollHeight; }
    function submitEdit() {
        var prompt = (editBox.value || "").trim();
        if (prompt.length < 4) { editStatus.textContent = "Say what you want changed."; return; }
        editSend.disabled = true; editStatus.textContent = "Sending…"; setLog([]);
        api("/api/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt }) })
            .then(function (job) { editJob = job.id; editStatus.textContent = job.position > 1 ? "Queued (" + job.position + " ahead)" : "Working…"; pollJob(); })
            .catch(function (e) { editStatus.textContent = e.message; editSend.disabled = false; });
    }
    function pollJob() {
        clearTimeout(editPoll);
        api("/api/job/" + editJob).then(function (job) {
            setLog(job.log);
            if (job.state === "queued") editStatus.textContent = "Queued" + (job.position > 1 ? " (" + (job.position - 1) + " ahead)" : "") + "…";
            else if (job.state === "running") editStatus.textContent = "Claude is working…";
            else if (job.state === "done") { editStatus.textContent = "Published " + (job.commit || "") + " for " + fmtUsd(job.cost) + ". Live in about a minute; reload to see it."; if (job.summary) setLog(job.log.concat(["", job.summary])); }
            else if (job.state === "failed") { editStatus.textContent = "Not applied."; if (job.summary) setLog(job.log.concat(["", job.summary])); }
            if (job.state === "done" || job.state === "failed") { editSend.disabled = false; refreshBudget(); return; }
            editPoll = setTimeout(pollJob, 2000);
        }).catch(function (e) { editStatus.textContent = e.message; editSend.disabled = false; });
    }
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && panel && panel.classList.contains("open")) { closePanel(); return; }
        var t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
        if (e.key && e.key.length === 1) {
            typed = (typed + e.key.toLowerCase()).slice(-MAGIC.length);
            if (typed === MAGIC) { typed = ""; openPanel(); }
        }
    }, true);

    window.SlopeMod = {
        blockedCount: function () { return blockedCount; },
        stackTarget: function () { return stackTarget; },
        courseBatches: function () { return lastCourseCount; },
        log: function () { return debugLog.slice(); },
        frame: function () { return frameNo; },
        stats: function () { return { builds: builds, resetsSent: resetsSent, deaths: deaths, restarts: restarts, building: !!build, restarting: !!restartSeq, music: musicId, shaderPatched: shaderPatched, shaderFailed: shaderFailed, rainbow: rainbowOn }; },
        setStack: setStackTarget,
        setLaps: function (n) { LAPS_PER_COURSE = n; },
        setMusic: setMusic,
        setGravity: setGravityMode,
        gravity: function () { return { mode: gravityMode, addrs: gravAddrs.length, ball: ballAddr, pos: ballPos, vel: ballVel.map(function (v) { return +v.toFixed(2); }), now: gravNow.map(function (v) { return +v.toFixed(2); }), ramp: ramp ? ramp.def.kind : null, events: gravDebug.events, lastRel: +gravDebug.lastRel.toFixed(2) }; },
        audio: function () { var a = audioEl; return a ? { paused: a.paused, time: a.currentTime, ready: a.readyState, src: a.src.split("/").pop(), error: a.error && a.error.code } : null; },
        restart: function () { if (game) requestRestart(false); },
        openEditor: openPanel,
        init: function (gameInstance) {
            game = gameInstance;
            hud = document.getElementById("hud");
            timerEl = document.getElementById("hud-timer");
            fsBtn = document.getElementById("hud-fs");
            stackInput = document.getElementById("hud-stack");
            rainbowBox = document.getElementById("hud-rainbow");
            musicSel = document.getElementById("hud-music");
            gravSel = document.getElementById("hud-gravity");
            gravBadge = document.getElementById("hud-gravity-badge");
            if (gravSel) {
                gravSel.value = gravityMode;
                gravSel.addEventListener("change", function () { setGravityMode(gravSel.value); gravSel.blur(); });
                gravSel.addEventListener("focus", showHud);
                gravSel.addEventListener("blur", showHud);
            }

            if (stackInput) {
                stackInput.value = stackTarget;
                stackInput.addEventListener("input", function () { setStackTarget(stackInput.value); });
                stackInput.addEventListener("change", function () { setStackTarget(stackInput.value); stackInput.blur(); });
                stackInput.addEventListener("focus", showHud);
                stackInput.addEventListener("blur", showHud);
            }
            if (rainbowBox) {
                rainbowBox.checked = rainbowOn;
                rainbowBox.addEventListener("change", function () {
                    rainbowOn = rainbowBox.checked; lsSet(KEY_RAINBOW, rainbowOn ? "1" : "0"); rainbowBox.blur();
                });
            }
            if (musicSel) {
                musicSel.innerHTML = "";
                TRACKS.forEach(function (t) { var o = document.createElement("option"); o.value = t.id; o.textContent = t.name; musicSel.appendChild(o); });
                musicSel.value = musicId;
                musicSel.addEventListener("change", function () { setMusic(musicSel.value); musicSel.blur(); });
                musicSel.addEventListener("focus", showHud);
                musicSel.addEventListener("blur", showHud);
            }
            if (fsBtn) fsBtn.addEventListener("click", function () {
                toggleFullscreen();
                fsBtn.blur(); // give the keyboard back to the game
            });
            document.addEventListener("keydown", function (e) {
                var ae = document.activeElement;
                if (ae === stackInput || ae === musicSel || ae === gravSel || (ae && ae.closest && ae.closest("#edit-panel"))) return;
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.key === "f" || e.key === "F") toggleFullscreen();
                else if (e.key === "r" || e.key === "R") requestRestart(false);
            });
            ["mousemove", "touchstart"].forEach(function (ev) {
                document.addEventListener(ev, showHud, { passive: true });
            });
            setInterval(tickTimer, 1000);
            tickTimer();
            showHud();
        },
        onGameReady: function () {
            startedAt = Date.now();
            setTimeout(discoverHeap, 300);
            tickTimer();
            showHud();
        }
    };
})();
