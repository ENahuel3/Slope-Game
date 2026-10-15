/* Slope mod runtime.
 *
 * 1. Network shim: the Unity build phones home to id.net / y8.com for ads,
 *    autologin and leaderboards, and to Unity Analytics. Every XHR, fetch
 *    and injected <script> aimed at those hosts is failed locally before it
 *    leaves the browser. The game already handles "failed to load ads".
 *
 * 2. Stacked courses, built instantly at the start of every run. The game
 *    is a set of PlayMaker state machines, and Unity's SendMessage bridge can
 *    switch their states by name. A normal restart is the EventManager's
 *    "resetGame" state: it broadcasts "Reset Game", which moves the ball and
 *    the spawn point back to the origin and spawns a fresh start section.
 *    Nothing in that path despawns the old course; only the "death complete"
 *    broadcast three seconds after a game over does. So the mod builds a
 *    stack while the ball is still falling into the start tunnel: it asks the
 *    spawner (t_Spawner, "Check score" / "easy run" / "medium run" /
 *    "hard run" states) for a run of laps, then forces "resetGame", and
 *    repeats until N courses sit exactly on top of each other. The last one
 *    is the live course the game keeps extending; the hidden ones are what
 *    the rapid-Enter glitch used to leave behind, without dying for them.
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
    // Draw-call fingerprint of this build: a 5190-index draw is the start
    // section's tunnel mesh, so it appears exactly once per stacked course.
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
    // 2. Stacked courses: run-start detector + reset/lap builder
    // ======================================================================
    var LAPS_PER_COURSE = 15;      // laps pre-generated on every hidden course
    var LAPS_PER_FRAME = 3;        // spread the spawning over a few frames
    var RESET_TIMEOUT = 90;        // frames to wait for a forced reset to show up
    var RESET_RETRIES = 3;
    var SPAWNER = "t_Spawner", EVENT_MANAGER = "EventManager";

    var stacked = 1;              // courses currently in the world (our best estimate)
    var lastCourseCount = 0;      // start sections drawn in the last frame
    var pendingTarget = null;     // a Courses change made mid-run, applied next run
    var builds = 0, resetsSent = 0;
    var frameNo = 0, debugLog = [];   // debugLog: last 40 decisions, for diagnostics
    function note(ev) { debugLog.push(frameNo + ':' + ev); if (debugLog.length > 40) debugLog.shift(); }

    // build: null | { course, lapsDone, phase: "laps" | "wait", expect, since, tries }
    var build = null;

    function setState(obj, state) {
        if (!game || typeof game.SendMessage !== "function") return false;
        try { game.SendMessage(obj, "SetState", state); return true; } catch (e) { note("SendMessage failed: " + e); return false; }
    }
    function lapState(j) { return j < 5 ? "easy run" : (j < 10 ? "medium run" : "hard run"); }
    function startBuild(c) {
        build = { course: 1, lapsDone: 0, phase: "laps", expect: c, since: frameNo, tries: 0 };
        builds++; note("run start, building " + stackTarget + " courses");
    }
    function sendReset(c) {
        resetsSent++; build.tries++;
        setState(EVENT_MANAGER, "resetGame");
        build.phase = "wait"; build.expect = c + 1; build.since = frameNo;
    }
    function stepBuild(c) {
        if (build.phase === "laps") {
            for (var k = 0; k < LAPS_PER_FRAME && build.lapsDone < LAPS_PER_COURSE; k++, build.lapsDone++) setState(SPAWNER, lapState(build.lapsDone));
            if (build.lapsDone >= LAPS_PER_COURSE) { build.tries = 0; sendReset(c); }
        } else if (c >= build.expect) {
            stacked = build.course + 1;
            note("course " + stacked + " up after " + (frameNo - build.since) + " frames");
            if (stacked >= stackTarget) { note("stack complete"); build = null; }
            else { build.course++; build.lapsDone = 0; build.phase = "laps"; }
        } else if (frameNo - build.since > RESET_TIMEOUT) {
            if (build.tries < RESET_RETRIES) { note("reset not seen, retrying"); sendReset(c - 1); }
            else { note("giving up at " + stacked); build = null; }
        }
    }

    function examineFrame(draws) {
        var c = 0;
        for (var i = 0; i < draws.length; i++) if (draws[i] === COURSE_BATCH) c++;
        var prev = lastCourseCount; lastCourseCount = c;

        if (c === 0) {                                  // game over cleared the world, or menu
            if (build) { note("world cleared mid-build"); build = null; }
            if (stacked !== 1) note("cleared");
            stacked = 1;
            if (pendingTarget !== null) { stackTarget = pendingTarget; pendingTarget = null; lsSet(KEY_STACK, stackTarget); }
        } else if (prev === 0 && !build) {              // a run just started
            stacked = 1;
            if (stackTarget > 1) startBuild(c);
        } else if (build) {
            stepBuild(c);
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
        if (build) txt += " \u2026";                      // building
        else if (pendingTarget !== null) txt += " (next run)";
        badgeEl.textContent = txt;
        badgeEl.classList.add("on");
    }

    function setStackTarget(n) {
        n = parseInt(n, 10);
        if (!(n >= 1)) n = 1;
        if (n > STACK_MAX) n = STACK_MAX;
        if (lastCourseCount > 0 && !build && stacked > 1) {
            // a run is in progress with a stack already built: apply on the next run
            pendingTarget = n;
        } else if (lastCourseCount > 0 && !build && n > 1) {
            // running on a single course: build right away (the ball goes back to the start)
            stackTarget = n; lsSet(KEY_STACK, n); pendingTarget = null; startBuild(lastCourseCount);
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
        stats: function () { return { builds: builds, resetsSent: resetsSent, building: !!build, shaderPatched: shaderPatched, shaderFailed: shaderFailed, rainbow: rainbowOn }; },
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
