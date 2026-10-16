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
 * 6. Track shaping (Curves / Turns): the course itself bends, built by
 *    rotating the spawn point; camera, forces and gravity follow (WASM heap).
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
    var GRAVITY_MODES = ["off", "curves", "twists", "both"];
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
        var restarted = musicStarted; if (restarted) { lastRestart = frameNo; gameRunning = true; resetTrackRun(); }
        var died = musicStopped && !musicStarted && frameNo - lastRestart > RESTART_GRACE;
        if (died) gameRunning = false;                 // (the skyline draw count is not used here: the camera may simply be looking away)
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
        try { stepTrack(gameRunning && !build && !restartSeq); } catch (e) { if (!trackDebug.err) { trackDebug.err = String(e); note("track error: " + e); } }
        if (rainbowOn) { hue = (hue + 1 / 210) % 1; rainbowTime += 1 / 60; }   // hues scroll through a full cycle every 3.5 s
        requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);   // registered before Unity's loop, so it runs first each frame

    // ======================================================================
    // 6. Track shaping: curves and 90-degree turns in the course itself.
    //    The spawner builds the course by translating the SpawnPos transform
    //    forward in its own frame, so rotating that transform (yaw) bends
    //    everything built after it; every block keeps the yaw it was spawned
    //    with. The camera hangs under a rig object ("Text") that follows the
    //    ball, so rotating the rig turns the camera. The game's forces are
    //    hard-wired to world axes (forward push along +z, steering along x),
    //    so on a turned course the mod reads the force magnitudes from the
    //    PlayMaker variables and adds the difference through gravity, which
    //    is also where the "throw you round the corner" burst comes from.
    //    Everything is found in the WebAssembly heap by value once, at the
    //    menu: transform records are 10 floats (quat, pos, scale).
    // ======================================================================
    var G0 = -9.8100004196167, BALL_MASS = 30;
    var PITCH_SX = -0.70710678, PITCH_CX = 0.70710678;         // SpawnPos rest rotation after the scene patch: -90 degrees about x (blocks copy it)
    var H = { grav: [], spawn: [], spawnLive: -1, spawnCache: -1, rig: -1, chase: -1, ball: -1, ballCands: [], vars: {}, kill: -1 };
    var ballPos = null, ballVel = [0, 0, 0], ballT = 0;
    var track = null;                 // per-run state, see resetTrackRun()
    var keysHeld = { left: false, right: false };
    var trackDebug = { laps: 0, kinks: 0 };
    var pendingTurnNext = 0;          // debug/test: force the next planned lap to turn
    var gravBadge = null, gravWritten = false;

    function heap32() { return game && game.Module ? game.Module.HEAPF32 : null; }
    function heapU32() { return game && game.Module ? game.Module.HEAPU32 : null; }
    function heapU16() { return game && game.Module ? game.Module.HEAPU16 : null; }
    function fbits(f) { var b = new Float32Array([f]); return new Uint32Array(b.buffer)[0]; }
    function findTriple(a, b, c) {
        var u = heapU32(); if (!u) return [];
        var A = fbits(a), B = fbits(b), C = fbits(c), out = [];
        for (var i = 0, n = u.length - 2; i < n; i++) if (u[i] === A && u[i + 1] === B && u[i + 2] === C) out.push(i);
        return out;
    }
    function nearSeq(vals, eps) {           // tolerant scan for a run of floats
        var f = heap32(); if (!f) return [];
        var out = [], n = f.length - vals.length, k;
        for (var i = 0; i < n; i++) {
            if (!(Math.abs(f[i] - vals[0]) < eps)) continue;                     // NaN never matches
            for (k = 1; k < vals.length; k++) if (!(Math.abs(f[i + k] - vals[k]) < eps)) break;
            if (k === vals.length) out.push(i);
        }
        return out;
    }
    // PlayMaker FsmFloat objects: managed string "name" <- NamedVariable.name at obj+12, value at obj+24
    function findStringObjects(str) {
        var u16 = heapU16(), u = heapU32(); if (!u16) return [];
        var out = [], first = str.charCodeAt(0), n = u16.length - str.length, k;
        for (var i = 0; i < n; i++) {
            if (u16[i] !== first) continue;
            for (k = 1; k < str.length; k++) if (u16[i + k] !== str.charCodeAt(k)) break;
            if (k < str.length) continue;
            var byteAddr = i * 2; if (byteAddr % 4) continue;
            if (u[(byteAddr - 4) >> 2] === str.length) out.push(byteAddr - 12);
        }
        return out;
    }
    function findFsmFloats(name) {
        var strs = findStringObjects(name), u = heapU32(), out = [];
        for (var s = 0; s < strs.length; s++) {
            for (var i = 0, n = u.length; i < n; i++) if (u[i] === strs[s]) out.push(i * 4 - 12);   // object whose +12 field is the name
        }
        return out;
    }
    function fsmFloat(name) {                 // the live one: largest magnitude among the candidates
        var objs = H.vars[name]; if (!objs || !objs.length) return 0;
        var f = heap32(), best = 0;
        for (var i = 0; i < objs.length; i++) { var v = f[(objs[i] + 24) >> 2]; if (isFinite(v) && Math.abs(v) > Math.abs(best)) best = v; }
        return best;
    }
    // Live objects are allocated above the raw asset data that stays mapped in the heap,
    // so matches below this float index are copies inside the data file, not the scene.
    var LIVE_MIN = 3000000;
    function liveOnly(list) { return list.filter(function (a) { return a >= LIVE_MIN; }); }
    function discoverHeap() {
        try {
            if (!H.grav.length) H.grav = findTriple(0, G0, 0);
            if (!H.ballCands.length) H.ballCands = findTriple(5, 10.5, -4);
            if (!H.spawn.length) {
                var all = liveOnly(nearSeq([PITCH_SX, 0, 0, PITCH_CX], 3e-4)), f0 = heap32();
                H.spawnCacheCands = all.slice();
                for (var i0 = 0; i0 < all.length; i0++) {
                    var a0 = all[i0];
                    if (f0[a0 - 3] === 0 && f0[a0 - 2] === 0 && f0[a0 - 1] === 0 && Math.abs(f0[a0 + 4] - 1) < 1e-3 && Math.abs(f0[a0 + 5] - 1) < 1e-3 && Math.abs(f0[a0 + 6] - 1) < 1e-3) H.spawn.push(a0);
                }
            }
            if (!H.rigCands) H.rigCands = liveOnly(nearSeq([0, 0, 0, 1, 5, 6.482, -4.737, 1, 1, 1], 2e-3));
            if (H.chase < 0) { var c = liveOnly(nearSeq([0.43559, 0, 0, 0.90015, 0, 3.056, -1.207, 1, 1, 1], 3e-4)); if (c.length) H.chase = c[c.length - 1]; }
            ["zforce", "yforce", "SteerForceLeft", "SteerForceRight"].forEach(function (nm) { if (!H.vars[nm]) H.vars[nm] = liveOnly(findFsmFloats(nm)); });
            note("heap: gravity x" + H.grav.length + ", spawn recs " + H.spawn.length + ", rig cands " + H.rigCands.length + ", chase " + (H.chase >= 0) + ", vars z/L/R " + [H.vars.zforce, H.vars.SteerForceLeft, H.vars.SteerForceRight].map(function (v) { return v ? v.length : 0; }).join("/"));
        } catch (e) { note("heap scan failed: " + e); }
    }
    function trackReady() { return H.grav.length > 0 && H.spawn.length > 0 && H.rigCands && H.rigCands.length > 0 && H.chase >= 0; }
    function resolveRig() {                   // the rig's rotation record is unique; its position is derived from the ball below
        if (H.rig < 0 && H.rigCands && H.rigCands.length) { H.rig = H.rigCands[H.rigCands.length - 1]; note("rig record " + H.rig); }
    }
    function writeGravity(x, y, z) {
        var f = heap32(); if (!f || !H.grav.length) return;
        for (var i = 0; i < H.grav.length; i++) { var a = H.grav[i]; f[a] = x; f[a + 1] = y; f[a + 2] = z; }
        gravWritten = !(x === 0 && y === G0 && z === 0);
    }
    function plausible(x, y, z) { return isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 1e4 && Math.abs(y) < 1e4 && Math.abs(z) < 1e4; }
    function resolveSpawn() {
        // The spawn transform's local record: rest rotation, at the origin with scale 1 while in the menu, and the
        // only such record that then moves when a run starts (H.spawn is filtered to origin+scale-1 at discovery).
        // Its cached world copy is the record in the [quat, pos] layout holding the same rotation and position.
        var f = heap32(); if (!f) return false;
        for (var i = 0; i < H.spawn.length; i++) {
            var a = H.spawn[i], x = f[a - 3], y = f[a - 2], z = f[a - 1];
            if (!plausible(x, y, z) || (x === 0 && y === 0 && z === 0)) continue;
            H.spawnLive = a; H.spawnCache = -1;
            var caches = H.spawnCacheCands || [];
            for (var j = 0; j < caches.length; j++) {
                var b = caches[j];
                if (Math.abs(f[b + 4] - x) < 1e-3 && Math.abs(f[b + 5] - y) < 1e-3 && Math.abs(f[b + 6] - z) < 1e-3 && Math.abs(f[b] - f[a]) < 1e-3 && Math.abs(f[b + 3] - f[a + 3]) < 1e-3) { H.spawnCache = b; break; }
            }
            note("spawn transform: local " + a + ", cache " + H.spawnCache);
            return true;
        }
        return false;
    }
    function writeSpawnYaw(yaw) {              // rotation = Ry(yaw) * Rx(45deg)
        var f = heap32(); if (!f || H.spawnLive < 0) return;
        var sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2);
        var q = [cy * PITCH_SX, sy * PITCH_CX, -sy * PITCH_SX, cy * PITCH_CX];
        var a = H.spawnLive, b = H.spawnCache;
        f[a] = q[0]; f[a + 1] = q[1]; f[a + 2] = q[2]; f[a + 3] = q[3];
        if (b >= 0) { f[b] = q[0]; f[b + 1] = q[1]; f[b + 2] = q[2]; f[b + 3] = q[3]; }
    }
    function shiftSpawnBy(d) {
        var f = heap32(); if (!f || H.spawnLive < 0) return;
        var a = H.spawnLive, b = H.spawnCache;
        f[a - 3] += d[0]; f[a - 2] += d[1]; f[a - 1] += d[2];
        if (b >= 0) { f[b + 4] += d[0]; f[b + 5] += d[1]; f[b + 6] += d[2]; }
    }
    function spawnPos() {
        var f = heap32(); if (!f) return null;
        if (H.spawnLive < 0 && !resolveSpawn()) return null;
        var a = H.spawnLive;
        return [f[a - 3], f[a - 2], f[a - 1]];
    }
    function writeRigYaw(yaw) {
        var f = heap32(); if (!f || H.rig < 0) return;
        f[H.rig] = 0; f[H.rig + 1] = Math.sin(yaw / 2); f[H.rig + 2] = 0; f[H.rig + 3] = Math.cos(yaw / 2);
    }
    // The rig ("Text") copies the ball's position each frame with x clamped to 3..7 and a fixed offset; its
    // own position record is a stale local copy, so reproduce that rule instead of reading it.
    function rigPos() { return ballPos ? [Math.min(7, Math.max(3, ballPos[0])), ballPos[1] - 4.018, ballPos[2] - 0.737] : null; }
    function writeChaseLocal(x, y, z) { var f = heap32(); if (!f || H.chase < 0) return; f[H.chase + 4] = x; f[H.chase + 5] = y; f[H.chase + 6] = z; }
    var CHASE_WORLD_OFF = [0, 3.056 - 4.018, -1.207 - 0.737];   // chase target relative to the ball on a straight run (rig sits 4.0 below / 0.74 behind the ball)

    function trackBall() {
        var f = heap32(); if (!f) return;
        if (H.ball < 0) {
            for (var i = 0; i < H.ballCands.length; i++) { var a = H.ballCands[i]; if (Math.abs(f[a] - 5) > 0.05 || Math.abs(f[a + 1] - 10.5) > 0.05 || Math.abs(f[a + 2] + 4) > 0.05) { H.ball = a; note("ball tracked at " + a); break; } }
            if (H.ball < 0) return;
        }
        var now = performance.now();
        var p = [f[H.ball], f[H.ball + 1], f[H.ball + 2]];
        if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2]) || Math.abs(p[0]) > 1e5) { H.ball = -1; return; }
        if (ballPos && ballT) {
            var dx = p[0] - ballPos[0], dy = p[1] - ballPos[1], dz = p[2] - ballPos[2];
            if (dx * dx + dy * dy + dz * dz > 15 * 15) ballVel = [0, 0, 0];                       // teleport (restart)
            else { var dt = Math.min(0.1, Math.max(0.004, (now - ballT) / 1000)); ballVel = [ballVel[0] * 0.5 + dx / dt * 0.5, ballVel[1] * 0.5 + dy / dt * 0.5, ballVel[2] * 0.5 + dz / dt * 0.5]; }
        }
        ballPos = p; ballT = now;
    }

    // ---- quaternion helpers (x, y, z, w) ---------------------------------------
    function qmul(a, b) { return [a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1], a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0], a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3], a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]]; }
    function qconj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
    function qrot(q, v) { var r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q)); return [r[0], r[1], r[2]]; }
    function qaxis(axis, ang) { var h = ang / 2, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; }
    var Q_REST = [PITCH_SX, 0, 0, PITCH_CX];                   // the spawn point's rest rotation
    var FWD0 = [0, -0.70710678, 0.70710678], N0 = [0, 0.70710678, 0.70710678];   // course axis and floor normal of a straight lap
    function frameQ(yaw, roll) {                                // world rotation of a lap frame: roll about the course axis, then yaw about y
        return qmul(qaxis([0, 1, 0], yaw), qaxis(FWD0, roll));
    }
    function spawnQ(yaw, roll) { return qmul(frameQ(yaw, roll), Q_REST); }
    function v3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
    function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
    function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
    function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function vlen(a) { return Math.sqrt(vdot(a, a)); }
    function segFrame(seg) {                                    // cached axes of a segment
        if (!seg.R) { seg.R = frameQ(seg.yaw, seg.roll); seg.fwd = qrot(seg.R, FWD0); seg.n = qrot(seg.R, N0); seg.xh = qrot(seg.R, [1, 0, 0]); seg.yh = qrot(seg.R, [0, 1, 0]); seg.zh = qrot(seg.R, [0, 0, 1]); }
        return seg;
    }

    // ---- per-run track state -------------------------------------------------
    function resetTrackRun() {
        track = { yaw: 0, roll: 0, segs: [segFrame({ yaw: 0, roll: 0, pos: [0, 0, 0], from: null })], passed: 0, lastSpawn: null, moving: false, stillFrames: 0, laps: 0,
                  camQ: [0, 0, 0, 1], turnPending: 0, twistPending: 0, fallFrames: 0, shift: null, written: null, whip: null };
        note("track reset" + (pendingTurnNext ? " (turn pending)" : "") + (pendingTwistNext ? " (twist pending)" : ""));
        ballPos = null; ballVel = [0, 0, 0];
        writeSpawnRot(spawnQ(0, 0)); writeRigQ([0, 0, 0, 1]); writeChaseLocal(0, 3.056, -1.207);
    }
    function writeSpawnRot(q) {
        var f = heap32(); if (!f || H.spawnLive < 0) return;
        var a = H.spawnLive, b = H.spawnCache;
        f[a] = q[0]; f[a + 1] = q[1]; f[a + 2] = q[2]; f[a + 3] = q[3];
        if (b >= 0) { f[b] = q[0]; f[b + 1] = q[1]; f[b + 2] = q[2]; f[b + 3] = q[3]; }
    }
    function writeRigQ(q) { var f = heap32(); if (!f || H.rig < 0) return; f[H.rig] = q[0]; f[H.rig + 1] = q[1]; f[H.rig + 2] = q[2]; f[H.rig + 3] = q[3]; }
    function segHeadingAt(p) {                // index of the segment the ball is on; kinks are passed in order and stay passed
        var segs = track.segs;
        while (track.passed + 1 < segs.length) {
            var k = segs[track.passed + 1], prev = segs[track.passed];
            var d = vsub(p, k.pos), dist = vlen([d[0], 0, d[2]]), along = vdot(d, prev.fwd);
            if (dist < 90 && along > -2) { track.passed++; track.whip = null; } else break;
        }
        return track.passed;
    }
    function planNextLap() {                   // called when a lap chain has finished spawning: decide the frame of the next lap
        var mode = gravityMode, yawStep = 0, rollStep = 0;
        track.laps++;
        if (pendingTurnNext) { yawStep = pendingTurnNext; pendingTurnNext = 0; }
        else if (pendingTwistNext) { rollStep = pendingTwistNext; pendingTwistNext = 0; }
        else if (mode === "twists" || mode === "both") {
            if (track.laps >= 2 && Math.random() < 0.5) rollStep = (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2;
        }
        if (!yawStep && !rollStep && (mode === "curves" || mode === "both")) yawStep = (Math.random() * 2 - 1) * (8 * Math.PI / 180) + (Math.random() < 0.5 ? -1 : 1) * (4 * Math.PI / 180);
        if (!yawStep && !rollStep) return;
        var sp = spawnPos() || [0, 0, 0];
        var prev = track.segs[track.segs.length - 1];
        var seg = segFrame({ yaw: track.yaw + yawStep, roll: track.roll + rollStep, pos: sp.slice(), from: prev, turn: Math.abs(yawStep) > 1, twist: !!rollStep, at: performance.now() });
        track.segs.push(seg);
        if (seg.twist) {
            // The next lap is a wall: put it at the lane edge on the side the new "up" points away from, so the
            // ball (lane centre, 5 in from either edge) sits 5 units off the wall's collidable face and drops onto
            // it once gravity swings. The lane spans 0..10 along the new lateral axis; centre that on the ball.
            var w = vdot(seg.n, prev.xh) < 0 ? 10 : 0;
            var p2 = vadd(vadd(sp, v3(prev.xh, w)), v3(seg.xh, -5));
            track.shift = { fixed: p2 };
        } else {
            track.shift = { base: sp.slice(), fwd: prev.fwd, nfwd: seg.fwd, step: Math.abs(yawStep), nxh: seg.xh };
        }
        track.yaw = seg.yaw; track.roll = seg.roll; trackDebug.kinks++;
        note("lap " + track.laps + ": yaw " + (seg.yaw * 180 / Math.PI).toFixed(0) + " roll " + (seg.roll * 180 / Math.PI).toFixed(0) + " at " + sp.map(function (v) { return v.toFixed(0); }).join(","));
    }
    function watchSpawner() {
        var sp = spawnPos(); if (!sp) return;
        if (!track.lastSpawn) {
            track.lastSpawn = sp;
            if (Math.abs(sp[0]) + Math.abs(sp[1]) + Math.abs(sp[2]) > 1) { track.moving = true; track.stillFrames = 7; }   // already built: treat as a chain at rest
            return;
        }
        var ref = track.written || track.lastSpawn;
        var moved = Math.abs(sp[0] - ref[0]) + Math.abs(sp[1] - ref[1]) + Math.abs(sp[2] - ref[2]) > 0.05;
        if (moved) { track.moving = true; track.stillFrames = 0; track.shift = null; track.written = null; }
        else if (track.moving && ++track.stillFrames >= 8) { track.moving = false; planNextLap(); }   // a chain just finished: the jump block sits at this position
        track.lastSpawn = sp;
        if (!track.moving && track.shift && ballPos) {
            var want;
            if (track.shift.fixed) want = track.shift.fixed;
            else {
                var sh = track.shift, vh = vlen([ballVel[0], 0, ballVel[2]]);
                var half = Math.min(sh.step, Math.PI / 2) / 2, sharp = Math.sin(half) * 2 / 1.4142;
                var ahead = (8 + 0.06 * Math.max(vh, 12)) * sharp, back = 8 * sharp, centre = 5 * sharp, drop = 8 * sharp;
                want = vadd(vadd(vadd(sh.base, v3([sh.fwd[0], 0, sh.fwd[2]], ahead / 0.7071 * 0.7071)), v3([sh.nfwd[0], 0, sh.nfwd[2]], -back)), v3(sh.nxh, -centre));
                want[1] -= drop;
                if (sharp < 0.3) want = sh.base;
            }
            var cur = track.written || sp, d = vsub(want, cur);
            if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 0.01) shiftSpawnBy(d);
            track.written = want; track.lastSpawn = want;
        }
    }

    function stepTrack(playing) {
        if (!trackReady()) return;
        if (playing) resolveRig();
        if (gravityMode === "off" || !playing || !track) {
            if (gravWritten) writeGravity(0, G0, 0);
            if (track && gravityMode === "off") { writeSpawnRot(spawnQ(0, 0)); writeRigQ([0, 0, 0, 1]); parkKillZone(false); }
            return;
        }
        trackBall(); watchSpawner();
        if (ballPos && ballVel[1] < -70) { if (++track.fallFrames > 45 && !restartSeq && !build) { note("free fall at y=" + ballPos[1].toFixed(0) + ", restarting"); requestRestart(true); return; } } else track.fallFrames = 0;
        if (H.spawnLive < 0) return;                                       // not until the live spawn record has shown itself
        parkKillZone(true);                                                // the kill box is a child of the spawner and would rotate into the lane
        writeSpawnRot(spawnQ(track.yaw, track.roll));                      // whatever spawns next uses the commanded frame
        if (!ballPos || H.rig < 0) return;
        var idx = segHeadingAt(ballPos), seg = track.segs[idx], frame = seg;
        // forces keep the previous lap's frame until the ball is past the jump lip (or airborne and whipped for turns)
        if (idx > 0 && !seg.done) {
            var dOld = vsub(ballPos, seg.pos), alongOld = vdot(dOld, seg.from.fwd);
            if ((track.whip && performance.now() - track.whip.since > 250) || alongOld > (seg.twist ? 14 : 16)) seg.done = true;
            else frame = seg.from;
        }
        // --- force compensation: the game pushes along world y / z / x; the lap frame rotates those axes
        var zf = fsmFloat("zforce"), yf = fsmFloat("yforce"), sL = fsmFloat("SteerForceLeft"), sR = fsmFloat("SteerForceRight");
        var steer = (keysHeld.left ? sL : 0) + (keysHeld.right ? sR : 0);
        var g = v3(frame.yh, G0);                                           // gravity itself, rotated into the frame
        g = vadd(g, v3(vsub(frame.zh, [0, 0, 1]), zf / BALL_MASS));
        g = vadd(g, v3(vsub(frame.yh, [0, 1, 0]), yf / BALL_MASS));
        g = vadd(g, v3(vsub(frame.xh, [1, 0, 0]), steer / BALL_MASS));
        var label = "";
        if (idx > 0) {
            var last = seg, dd = vsub(ballPos, last.pos), along = vdot(dd, last.from.fwd), vh = vlen([ballVel[0], 0, ballVel[2]]);
            if (!track.whip && along > 12) track.whip = { since: performance.now() };
            if (track.whip && performance.now() - track.whip.since > 1500) track.whip = null;
            if (track.whip && last.turn && along > -2 && along < 70 && vh > 3) {   // yaw turn: swing the horizontal velocity onto the new heading
                var nf = [last.fwd[0], last.fwd[2]], nl = Math.sqrt(nf[0] * nf[0] + nf[1] * nf[1]); nf = [nf[0] / nl, nf[1] / nl];
                var speed = Math.max(vh, 30), want = [speed * nf[0], speed * nf[1]];
                var ax = 10 * (want[0] - ballVel[0]), az = 10 * (want[1] - ballVel[2]), m = Math.sqrt(ax * ax + az * az);
                if (m > 400) { ax *= 400 / m; az *= 400 / m; }
                g = vadd(g, [ax, 0, az]);
                if (performance.now() - track.whip.since < 500) g[1] += Math.min(40, Math.abs(yf) / BALL_MASS) * 0.6;
                label = last.yaw > last.from.yaw ? "turn →" : "← turn";
            } else if (last.twist && !seg.done) {
                label = "twist ahead";
            } else if (last.twist && track.whip && performance.now() - track.whip.since < 1500) {
                label = Math.round(last.roll * 180 / Math.PI) % 360 === 0 ? "upright" : "twist " + Math.round(last.roll * 180 / Math.PI) + "°";
            }
        }
        writeGravity(g[0], g[1], g[2]);
        // --- camera: the rig takes the frame's rotation; the chase target is re-aimed so the clamped rig does not matter
        var camTarget = (track.whip || seg.done || idx === 0) ? seg.R : frame.R;
        var cq = track.camQ, t = 0.12;
        if (vdot(cq, camTarget) < 0) camTarget = [-camTarget[0], -camTarget[1], -camTarget[2], -camTarget[3]];
        cq = [cq[0] + (camTarget[0] - cq[0]) * t, cq[1] + (camTarget[1] - cq[1]) * t, cq[2] + (camTarget[2] - cq[2]) * t, cq[3] + (camTarget[3] - cq[3]) * t];
        var nl2 = Math.sqrt(vdot(cq, cq) + cq[3] * cq[3] - cq[3] * cq[3]); nl2 = Math.sqrt(cq[0] * cq[0] + cq[1] * cq[1] + cq[2] * cq[2] + cq[3] * cq[3]);
        cq = [cq[0] / nl2, cq[1] / nl2, cq[2] / nl2, cq[3] / nl2]; track.camQ = cq;
        writeRigQ(cq);
        var rp = rigPos();
        if (rp) {
            var desired = vadd(ballPos, qrot(cq, CHASE_WORLD_OFF));
            var local = qrot(qconj(cq), vsub(desired, rp));
            writeChaseLocal(local[0], local[1], local[2]);
        }
        if (gravBadge && gravBadge.textContent !== label) { gravBadge.textContent = label; gravBadge.classList.toggle("on", !!label); }
    }
    // The fall-out kill box hangs under the spawner; with the spawner rolled it would cut through the lane.
    // While a track mode runs it is parked far below (the free-fall watchdog restarts the run instead).
    function parkKillZone(park) {
        var f = heap32(); if (!f) return;
        if (H.kill < 0) {
            var k = liveOnly(nearSeq([10, -10, 300], 1e-3));                // its scale, unique
            for (var i = 0; i < k.length; i++) { var a = k[i] - 7; if (Math.abs(f[a] - 0.125) < 0.01 && Math.abs(f[a + 1] + 5.15) < 0.01 && Math.abs(f[a + 2] - 18.779) < 0.01) { H.kill = a; break; } }
            if (H.kill < 0) { H.kill = -2; return; }
        }
        if (H.kill < 0) return;
        f[H.kill + 1] = park ? -5000 : -5.15;
    }
    var pendingTwistNext = 0;

    function setGravityMode(m) {
        if (GRAVITY_MODES.indexOf(m) < 0) m = "off";
        gravityMode = m; lsSet(KEY_GRAVITY, m);
        if (m === "off") { writeGravity(0, G0, 0); writeSpawnRot(spawnQ(0, 0)); writeRigQ([0, 0, 0, 1]); parkKillZone(false); if (gravBadge) { gravBadge.textContent = ""; gravBadge.classList.remove("on"); } }
    }
    ["keydown", "keyup"].forEach(function (type) {
        window.addEventListener(type, function (e) {
            var t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
            var down = type === "keydown", k = e.key;
            if (k === "ArrowLeft" || k === "a" || k === "A" || k === "q" || k === "Q") keysHeld.left = down;
            else if (k === "ArrowRight" || k === "d" || k === "D") keysHeld.right = down;
        }, true);
    });
    window.addEventListener("blur", function () { keysHeld.left = keysHeld.right = false; });

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
        setTurn: function (dir) { pendingTurnNext = (dir < 0 ? -1 : 1) * Math.PI / 2; },
        setTwist: function (dir) { pendingTwistNext = (dir < 0 ? -1 : 1) * Math.PI / 2; },
        heading: function () { if (!track || !ballPos) return null; var sg = track.segs[track.passed]; var fr = (track.passed > 0 && !sg.done) ? sg.from : sg; return +(fr.yaw * 180 / Math.PI).toFixed(1); },
        roll: function () { if (!track || !ballPos) return null; var sg = track.segs[track.passed]; var fr = (track.passed > 0 && !sg.done) ? sg.from : sg; return +(fr.roll * 180 / Math.PI).toFixed(0); },
        track: function () { var f = heap32(); return { mode: gravityMode, heap: { grav: H.grav.length, spawn: H.spawn.length, spawnLive: H.spawnLive, spawnCache: H.spawnCache, rigCands: H.rigCands ? H.rigCands.length : -1, rig: H.rig, chase: H.chase, ball: H.ball, vars: Object.keys(H.vars).map(function (k) { return k + ":" + H.vars[k].length; }) }, pos: ballPos, vel: ballVel.map(function (v) { return +v.toFixed(1); }), yawCmd: track ? +(track.yaw * 180 / Math.PI).toFixed(1) : null, rollCmd: track ? +(track.roll * 180 / Math.PI).toFixed(0) : null, camQ: track ? track.camQ.map(function (v) { return +v.toFixed(2); }) : null, kill: H.kill, laps: track ? track.laps : 0, segs: track ? track.segs.length - 1 : 0, passed: track ? track.passed : 0, spawnPos: spawnPos(), spawnQ: (function () { var f = heap32(); return f && H.spawnLive >= 0 ? [f[H.spawnLive], f[H.spawnLive + 1], f[H.spawnLive + 2], f[H.spawnLive + 3]].map(function (v) { return +v.toFixed(3); }) : null; })(), spawnCachePos: (function () { var f = heap32(); return f && H.spawnCache >= 0 ? [f[H.spawnCache + 4], f[H.spawnCache + 5], f[H.spawnCache + 6]].map(function (v) { return +v.toFixed(1); }) : null; })(), rigPos: rigPos(), rig: H.rig, shift: track && track.written ? track.written.map(function (v) { return +v.toFixed(1); }) : null, zforce: fsmFloat("zforce"), yforce: fsmFloat("yforce"), steer: [fsmFloat("SteerForceLeft"), fsmFloat("SteerForceRight")], grav: f && H.grav.length ? [f[H.grav[0]], f[H.grav[0] + 1], f[H.grav[0] + 2]].map(function (v) { return +v.toFixed(2); }) : null, keys: keysHeld }; },
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
