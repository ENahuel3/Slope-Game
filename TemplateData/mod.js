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
 * 4. HUD: fullscreen button (or F key), session timer, Courses and Rainbow
 *    controls, auto-hide while playing, reappear on mouse move.
 */
(function () {
    "use strict";

    // ======================================================================
    // Settings (localStorage, with safe fallbacks)
    // ======================================================================
    var KEY_STACK = "slope-mod.stack";
    var KEY_RAINBOW = "slope-mod.rainbow";
    var STACK_MAX = 99;

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }

    var stackTarget = (function () { var n = parseInt(lsGet(KEY_STACK), 10); return (n >= 1 && n <= STACK_MAX) ? n : 1; })();
    var rainbowOn = lsGet(KEY_RAINBOW) !== "0";

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
    // every restart. That is the earliest death signal there is.
    // ======================================================================
    var MUSIC_MIN_SECONDS = 10;
    var musicStopped = false, musicStarted = false;   // flags for the frame being examined
    if (window.AudioBufferSourceNode) {
        var absStart = AudioBufferSourceNode.prototype.start, absStop = AudioBufferSourceNode.prototype.stop;
        AudioBufferSourceNode.prototype.start = function () {
            this.__slopeDur = this.buffer ? this.buffer.duration : 0;
            if (this.__slopeDur >= MUSIC_MIN_SECONDS) musicStarted = true;
            return absStart.apply(this, arguments);
        };
        AudioBufferSourceNode.prototype.stop = function () {
            if (this.__slopeDur >= MUSIC_MIN_SECONDS) musicStopped = true;
            return absStop.apply(this, arguments);
        };
    }

    // ======================================================================
    // 2. Stacked courses: instant builder + instant restart after a death
    // ======================================================================
    // Hidden courses are spawned directly: Sphere "Restart Game" puts the
    // ball and the spawn point back at the origin, t_Spawner "spawn go tunnel
    // run" drops a start section there, and each "Check score" generates one
    // lap (the spawner's own per-speed-up path, so laps go easy -> medium ->
    // hard like a real run). Only the last course goes through the normal
    // EventManager "resetGame" restart, so the game's own state is clean; the
    // music restarting is the confirmation that it went through.
    // Hold-at-top: while building, the ball is lifted back to the start every
    // few frames; a reset issued after the ball has landed kills it.
    var LAPS_PER_COURSE = 8;       // laps pre-generated on every hidden course
    var HOLD_EVERY = 6;            // frames between ball lifts during a build
    var FINAL_SETTLE = 8;          // frames between the last lift and the final reset (lets its delayed destroySelf land first)
    var RESET_TIMEOUT = 60;        // frames to wait for the final reset's music restart
    var RESET_RETRIES = 3;
    var DEATH_BEAT = 30;           // frames to show the death before the instant restart
    var RESTART_GRACE = 15;        // a restart also stops the previous track a frame or two later
    var SPAWNER = "t_Spawner", EVENT_MANAGER = "EventManager", SPHERE = "Sphere";

    var stacked = 1;              // courses currently in the world (our best estimate)
    var lastCourseCount = 0;      // skyline draws in the last frame (0 = world cleared / menu)
    var pendingTarget = null;     // a Courses change made mid-run, applied next run
    var builds = 0, resetsSent = 0, deaths = 0, instantRestarts = 0;
    var lastRestart = -1000;
    var frameNo = 0, debugLog = [];   // debugLog: last 40 decisions, for diagnostics
    function note(ev) { debugLog.push(frameNo + ':' + ev); if (debugLog.length > 40) debugLog.shift(); }

    // build: null | { phase: "course" | "laps" | "settle" | "final", hidden, laps, since, started, tries, lastLift }
    var build = null;
    // dying: null | { phase: "beat" | "clear", since }
    var dying = null;

    function setState(obj, state) {
        if (!game || typeof game.SendMessage !== "function") return false;
        try { game.SendMessage(obj, "SetState", state); return true; } catch (e) { note("SendMessage failed: " + e); return false; }
    }
    function liftBall() { setState(SPHERE, "Restart Game"); build.lastLift = frameNo; }
    function startBuild(existing) {
        // `existing` courses are already in the world with their start section
        // at the origin (1 right after a restart, 0 after a clear); they become
        // hidden layers under the ones built here
        build = { phase: existing > 0 ? "laps" : "course", hidden: existing, laps: 0, since: frameNo, started: frameNo, tries: 0, lastLift: -1000 };
        stacked = Math.max(existing, 1);
        builds++; note("building " + stackTarget + " courses from " + existing);
    }
    function sendFinalReset() {
        resetsSent++; build.tries++;
        setState(EVENT_MANAGER, "resetGame");
        build.phase = "final"; build.since = frameNo;
    }
    function stepBuild(restarted) {
        if (build.phase === "course") {
            liftBall();                                   // SpawnPos -> origin
            setState(SPAWNER, "spawn go tunnel run");     // start section there
            build.hidden++; build.laps = 0; build.phase = "laps"; stacked = build.hidden;
        } else if (build.phase === "laps") {
            if (frameNo - build.lastLift >= HOLD_EVERY) liftBall();
            if (build.laps < LAPS_PER_COURSE) { setState(SPAWNER, "Check score"); build.laps++; }
            else if (build.hidden < stackTarget - 1) build.phase = "course";
            else { build.phase = "settle"; build.since = frameNo; }
        } else if (build.phase === "settle") {
            if (frameNo - build.lastLift >= FINAL_SETTLE) { build.tries = 0; sendFinalReset(); }
        } else if (restarted) {                           // final: the game restarted on its own path
            stacked = build.hidden + 1;
            note("stack of " + stacked + " complete in " + (frameNo - build.started) + " frames");
            build = null;
        } else if (frameNo - build.since > RESET_TIMEOUT) {
            if (build.tries < RESET_RETRIES) { note("final reset not seen, retrying"); sendFinalReset(); }
            else { note("giving up at " + build.hidden); stacked = build.hidden; build = null; }
        }
    }

    function examineFrame(draws) {
        var c = 0;
        for (var i = 0; i < draws.length; i++) if (draws[i] === COURSE_BATCH) c++;
        lastCourseCount = c;
        var restarted = musicStarted; if (restarted) lastRestart = frameNo;
        var died = musicStopped && !musicStarted && frameNo - lastRestart > RESTART_GRACE;
        musicStopped = musicStarted = false;

        if (dying) {
            if (dying.phase === "beat") {
                if (frameNo - dying.since >= DEATH_BEAT) {
                    setState(SPAWNER, "DestroyBlocksPool");     // despawn every block (and pauses time; "start game" unpauses)
                    dying.phase = "clear"; dying.since = frameNo;
                }
            } else if (c === 0 || frameNo - dying.since > 30) {
                dying = null;
                if (pendingTarget !== null) { stackTarget = pendingTarget; pendingTarget = null; lsSet(KEY_STACK, stackTarget); }
                startBuild(0);
            }
        } else if (build) {
            stepBuild(restarted);
        } else if (restarted) {                         // a run just started (Enter at the menu / game over)
            stacked = 1;
            if (pendingTarget !== null) { stackTarget = pendingTarget; pendingTarget = null; lsSet(KEY_STACK, stackTarget); }
            if (stackTarget > 1) startBuild(1);
        } else if (c === 0) {                           // game over cleared the world, or menu
            if (stacked !== 1) note("cleared");
            stacked = 1;
            if (pendingTarget !== null) { stackTarget = pendingTarget; pendingTarget = null; lsSet(KEY_STACK, stackTarget); }
        } else if (died && stackTarget > 1) {           // instant restart with the stack rebuilt
            deaths++; instantRestarts++;
            dying = { phase: "beat", since: frameNo };
            note("death -> instant restart");
        }
        updateBadge();
    }

    function frameLoop() {
        frameNo++;
        var draws = frameDraws; frameDraws = [];
        try { examineFrame(draws); } catch (e) { /* never break the game loop */ }
        if (rainbowOn) { hue = (hue + 1 / 210) % 1; rainbowTime += 1 / 60; }   // hues scroll through a full cycle every 3.5 s
        requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);   // registered before Unity's loop, so it runs first each frame

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
            if (!t || t.id !== STACK_INPUT_ID) return;
            e.stopImmediatePropagation();
            if (type === "keydown" && (e.key === "Enter" || e.key === "Escape")) { e.preventDefault(); t.blur(); }
        }, true);
    });

    var game = null;
    var hud, timerEl, fsBtn, stackInput, badgeEl, rainbowBox;
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
            if (document.activeElement === stackInput) return;   // keep it visible while typing
            hud.classList.add("hidden");
        }, 2500);
    }

    function updateBadge() {
        if (!badgeEl) return;
        var target = pendingTarget !== null ? pendingTarget : stackTarget;
        if (target <= 1 && stacked <= 1) { badgeEl.textContent = ""; badgeEl.classList.remove("on"); return; }
        var txt = "stack " + Math.min(stacked, Math.max(target, stacked)) + " / " + target;
        if (build || dying) txt += " \u2026";             // building / restarting
        else if (pendingTarget !== null) txt += " (next run)";
        badgeEl.textContent = txt;
        badgeEl.classList.add("on");
    }

    function setStackTarget(n) {
        n = parseInt(n, 10);
        if (!(n >= 1)) n = 1;
        if (n > STACK_MAX) n = STACK_MAX;
        if (dying || (lastCourseCount > 0 && !build && stacked > 1)) {
            // a run is in progress with a stack already built: apply on the next run
            pendingTarget = n;
        } else if (lastCourseCount > 0 && !build && n > 1) {
            // running on a single course: build right away (the ball goes back to the start)
            stackTarget = n; lsSet(KEY_STACK, n); pendingTarget = null; startBuild(1);
        } else {
            stackTarget = n; lsSet(KEY_STACK, n); pendingTarget = null;
            if (build && stacked >= stackTarget) build = null;
        }
        if (stackInput && String(stackInput.value) !== String(n)) stackInput.value = n;
        updateBadge();
    }

    function toggleFullscreen() {
        var container = document.getElementById("gameContainer");
        if (document.fullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
            return;
        }
        if (game && game.Module && game.Module.SetFullscreen) {
            game.SetFullscreen(1);
        } else if (container && container.requestFullscreen) {
            container.requestFullscreen();
        }
    }

    window.SlopeMod = {
        blockedCount: function () { return blockedCount; },
        stackTarget: function () { return stackTarget; },
        stacked: function () { return stacked; },
        courseBatches: function () { return lastCourseCount; },
        log: function () { return debugLog.slice(); },
        frame: function () { return frameNo; },
        stats: function () { return { builds: builds, resetsSent: resetsSent, deaths: deaths, instantRestarts: instantRestarts, building: !!build, dying: !!dying, shaderPatched: shaderPatched, shaderFailed: shaderFailed, rainbow: rainbowOn }; },
        setStack: setStackTarget,
        setLaps: function (n) { LAPS_PER_COURSE = n; },
        init: function (gameInstance) {
            game = gameInstance;
            hud = document.getElementById("hud");
            timerEl = document.getElementById("hud-timer");
            fsBtn = document.getElementById("hud-fs");
            stackInput = document.getElementById("hud-stack");
            badgeEl = document.getElementById("hud-stack-badge");
            rainbowBox = document.getElementById("hud-rainbow");

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
            if (fsBtn) fsBtn.addEventListener("click", function () {
                toggleFullscreen();
                fsBtn.blur(); // give the keyboard back to the game
            });
            document.addEventListener("keydown", function (e) {
                if (document.activeElement === stackInput) return;
                if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen();
            });
            ["mousemove", "touchstart"].forEach(function (ev) {
                document.addEventListener(ev, showHud, { passive: true });
            });
            setInterval(tickTimer, 1000);
            tickTimer();
            updateBadge();
            showHud();
        },
        onGameReady: function () {
            startedAt = Date.now();
            tickTimer();
            showHud();
        }
    };
})();
