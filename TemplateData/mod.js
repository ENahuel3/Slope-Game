/* Slope mod runtime.
 *
 * 1. Network shim: the Unity build phones home to id.net / y8.com for ads,
 *    autologin and leaderboards, and to Unity Analytics. Every XHR, fetch
 *    and injected <script> aimed at those hosts is failed locally before it
 *    leaves the browser. The game already handles "failed to load ads".
 *
 * 2. Stacked courses (the rapid-Enter glitch, automated). When the ball
 *    dies, the game's EventManager FSM runs "death complete", which despawns
 *    every course block. An Enter restart that lands within ~4 frames of the
 *    death frame cancels that despawn, so the old course stays in the world,
 *    exactly aligned, and the next run spawns a fresh random course on top of
 *    it. Humans need ~700 presses per minute to hit that window; the mod
 *    watches the WebGL draw list every frame, spots the death frame (the
 *    ball's draw call vanishes while the course is still drawn) and fires a
 *    synthetic Enter in that same frame. It does so while fewer than N
 *    courses are stacked; the next death at N is a normal game over, which
 *    clears the stack.
 *
 * 3. Rainbow neon: every fragment shader is rewritten at compile time so
 *    that green-hued output pixels get their hue replaced by a moving
 *    rainbow (a sweep across the screen that cycles over time). Red stays
 *    red. The rotation is applied only for draws that hit the default
 *    framebuffer, so scenes that go through an image-effect pass are
 *    recoloured once, at the final blit.
 *
 * 4. HUD: fullscreen button (or F key), session timer, auto-hide while
 *    playing, reappear on mouse move.
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
    // Draw-call index counts of this build, used as state fingerprints:
    //   5190 = one course's static batch; it appears once per stacked course
    //   6    = a UI quad; the game-over / menu screens draw many of them
    var COURSE_BATCH = 5190, UI_QUAD = 6, UI_QUADS_MIN = 5;

    var frameDraws = [];          // index counts of draws in the frame being rendered
    var defaultFbBound = true;    // is the default framebuffer the current draw target?
    var currentProgram = null;
    var hue = 0;                  // 0..1, advanced every frame when the rainbow is on
    var shaderPatched = 0, shaderFailed = 0;

    var HUE_UNIFORM = "_slopeHue";
    // GLSL helper: replace the hue of green-ish pixels, keep saturation/value.
    var GLSL_HELPER = [
        "uniform float " + HUE_UNIFORM + ";",
        "vec3 slopeRainbow(vec3 c) {",
        "  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn;",
        "  if (" + HUE_UNIFORM + " < 0.0 || mx <= 0.0 || d < 0.03 * mx) return c;",
        "  float h;",
        "  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;",
        "  if (abs(h - 2.0) > 0.9) return c;",                       // keep anything that is not green-ish
        "  float H = mod(" + HUE_UNIFORM + " * 6.0 + gl_FragCoord.x * 0.0025 + (h - 2.0), 6.0);",
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
            if (prog.__slopeHueLoc) gl.uniform1f(prog.__slopeHueLoc, (rainbowOn && defaultFbBound) ? hue : -1.0);
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
    // instant the ball dies, for falls and crashes alike. That is the
    // earliest death signal there is; the game-over UI follows ~1.7 s later.
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
    // 2. Stacked courses: per-frame game monitor + synthetic Enter
    // ======================================================================
    var ENTER_INIT = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    var TAP_HOLD = 2, TAP_GAP = 1;   // spam rhythm: Enter held 2 frames, up 1 (a press every 3 frames). The restart is only accepted
                                     // in a ~4-frame window when the game-over UI appears (~1.7 s after the death),
                                     // so presses must come at least that often (humans manage it at ~700 bpm, barely)
    var SPAM_MAX = 240;       // give up after 4 s if no restart is observed
    var GUARD_FRAMES = 110;   // keep spamming this long after a restart: a ball that spawns
                              // inside leftover geometry dies instantly, with no despawn delay,
                              // and only an already-pressed Enter restarts it in time
    var RESTART_GRACE = 15;   // a restart also stops the previous track a frame or two later
    var prevUi = false;       // did the previous frame draw the game-over UI?
    var stacked = 1;          // courses currently in the world (our best estimate)
    var lastCourseCount = 0;  // course batches drawn in the last frame
    var deaths = 0, autoRestarts = 0;
    var frameNo = 0, debugLog = [];   // debugLog: last 40 decisions, for diagnostics
    function note(ev) { debugLog.push(frameNo + ':' + ev); if (debugLog.length > 40) debugLog.shift(); }

    // phase: "alive" | "spam" (dead: Enter held + re-pressed until the run restarts)
    //        | "guard" (restarted, keep pressing through the fly-in) | "dying" (let the game clear)
    var phase = "alive", phaseSince = 0, lastRestart = -1000;
    var enterDown = false;

    function keyTarget() { return document.querySelector("#gameContainer canvas") || document.body; }
    function press() { if (!enterDown) { keyTarget().dispatchEvent(new KeyboardEvent("keydown", ENTER_INIT)); enterDown = true; } }
    function release() { if (enterDown) { keyTarget().dispatchEvent(new KeyboardEvent("keyup", ENTER_INIT)); enterDown = false; } }
    function setPhase(ph) { phase = ph; phaseSince = frameNo; }
    function spamTick() {
        var t = (frameNo - phaseSince) % (TAP_HOLD + TAP_GAP);
        if (t < TAP_HOLD) press(); else release();
    }

    function examineFrame(draws) {
        var course = 0, quads = 0;
        for (var i = 0; i < draws.length; i++) {
            if (draws[i] === COURSE_BATCH) course++;
            else if (draws[i] === UI_QUAD) quads++;
        }
        lastCourseCount = course;
        var ui = quads >= UI_QUADS_MIN;
        var restarted = musicStarted;                   // a run (re)started this frame
        if (restarted) lastRestart = frameNo;
        // music cut without a restart = the ball died (fall or crash alike)
        var died = musicStopped && !musicStarted && frameNo - lastRestart > RESTART_GRACE;
        musicStopped = musicStarted = false;

        if (phase === "alive") {
            // Death signals: the music is cut at the instant the ball dies; as
            // a fallback, the game-over UI starts drawing while the course is
            // still in the world (the despawn follows a few frames later).
            if (course > 0 && (died || (ui && !prevUi))) {
                deaths++;
                if (stackTarget > 1 && stacked < stackTarget) {
                    setPhase("spam"); spamTick();
                    note("death -> spam (c=" + course + ")");
                } else {
                    setPhase("dying");
                    note("death -> let it clear (c=" + course + ")");
                }
            }
        } else if (phase === "spam" || phase === "guard") {
            if (restarted && course > 0) {
                stacked++; autoRestarts++;
                note("restarted, stacked=" + stacked);
                if (stacked < stackTarget) { setPhase("guard"); spamTick(); }
                else { release(); setPhase("alive"); }
            } else if (course === 0) {
                note(phase === "spam" ? "despawned before restart" : "despawned during guard");
                stacked = 1; release(); setPhase("alive");
            } else if (phase === "guard" && died) {
                deaths++; setPhase("spam"); spamTick();     // instant re-death: keep pressing
                note("died during guard -> spam");
            } else if (phase === "guard" && frameNo - phaseSince > GUARD_FRAMES) {
                release(); setPhase("alive");
            } else if (phase === "spam" && frameNo - phaseSince > SPAM_MAX) {
                note("spam timeout"); release(); setPhase("alive");
            } else {
                spamTick();
            }
        } else { // dying
            if (course === 0) { stacked = 1; note("cleared"); setPhase("alive"); }
            else if (restarted) { stacked++; note("player restarted early, stacked=" + stacked); setPhase("alive"); }
        }
        if (phase === "alive" && course === 0 && stacked !== 1) { stacked = 1; note("cleared"); }
        updateBadge();
        prevUi = ui;
    }

    function frameLoop() {
        frameNo++;
        var draws = frameDraws; frameDraws = [];
        try { examineFrame(draws); } catch (e) { /* never break the game loop */ }
        if (rainbowOn) hue = (hue + 1 / 480) % 1;   // one full cycle every 8 s at 60 fps
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
        if (stackTarget <= 1) { badgeEl.textContent = ""; badgeEl.classList.remove("on"); return; }
        badgeEl.textContent = "stack " + Math.min(stacked, stackTarget) + " / " + stackTarget;
        badgeEl.classList.add("on");
    }

    function setStackTarget(n) {
        n = parseInt(n, 10);
        if (!(n >= 1)) n = 1;
        if (n > STACK_MAX) n = STACK_MAX;
        stackTarget = n;
        lsSet(KEY_STACK, n);
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
        stats: function () { return { deaths: deaths, autoRestarts: autoRestarts, shaderPatched: shaderPatched, shaderFailed: shaderFailed, rainbow: rainbowOn }; },
        setStack: setStackTarget,
        setRhythm: function (hold, gap) { TAP_HOLD = hold; TAP_GAP = gap; },
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
