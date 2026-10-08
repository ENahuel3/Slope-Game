/* Slope mod runtime.
 *
 * 1. Network shim: the Unity build phones home to id.net / y8.com for ads,
 *    autologin and leaderboards. Every XHR, fetch and injected <script>
 *    aimed at those hosts is failed locally before it leaves the browser.
 *    The game already handles "failed to load ads" gracefully.
 * 2. HUD: fullscreen button (or F key), session timer, auto-hide while
 *    playing, reappear on mouse move.
 * 3. Stacked courses: the course is built by a PlayMaker spawner FSM that
 *    steps a spawn point forward by a float variable "BlockLength" (14.142)
 *    after every block. Dividing that step by N makes N random blocks
 *    overlap at every point of the run, which is what the rapid-Enter
 *    restart glitch produced by leaving the previous course in place.
 *    The value lives in the scene bundle inside Build/slope_data.unityweb;
 *    the bundle is stored uncompressed so it can be patched in-flight
 *    while the Unity loader downloads it. The setting is read once per
 *    page load, so changing it reloads the page.
 */
(function () {
    "use strict";

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

    // --- Stacked courses ---------------------------------------------------
    var STACK_KEY = "slope-mod.stack";
    var STACK_MAX = 5;
    var BLOCK_LENGTH = 14.14214038848877;            // 10 * sqrt(2): one block along the 45 degree slope
    // FsmFloat "BlockLength" as serialized in the t_Spawner FSM: name, padding,
    // empty tooltip/flags, then the float32 value 0x41624635.
    var STACK_SIG = [0x42,0x6c,0x6f,0x63,0x6b,0x4c,0x65,0x6e,0x67,0x74,0x68,
                     0,0,0,0,0,0,0,0,0,0,0,0,0, 0x35,0x46,0x62,0x41];
    var stackApplied = 0;   // 0 = not patched (N = 1), else the N that was written

    function readStack() {
        var n = 1;
        try { n = parseInt(localStorage.getItem(STACK_KEY), 10); } catch (e) { /* storage blocked */ }
        return (n >= 1 && n <= STACK_MAX) ? n : 1;
    }
    function writeStack(n) {
        try { localStorage.setItem(STACK_KEY, String(n)); } catch (e) { /* storage blocked */ }
    }
    var stackCount = readStack();

    function findSig(u8) {
        var first = STACK_SIG[0], L = STACK_SIG.length, end = u8.length - L;
        for (var i = 0; i <= end; i++) {
            if (u8[i] !== first) continue;
            var k = 1;
            while (k < L && u8[i + k] === STACK_SIG[k]) k++;
            if (k === L) return i;
        }
        return -1;
    }
    function patchDataFile(buffer) {
        if (stackCount <= 1 || !(buffer instanceof ArrayBuffer)) return buffer;
        var u8 = new Uint8Array(buffer);
        var at = findSig(u8);
        if (at < 0) { console.warn("[slope-mod] BlockLength not found in data file; stacking disabled"); return buffer; }
        new DataView(buffer).setFloat32(at + STACK_SIG.length - 4, BLOCK_LENGTH / stackCount, true);
        stackApplied = stackCount;
        console.log("[slope-mod] stacked courses x" + stackCount + " (BlockLength " + (BLOCK_LENGTH / stackCount).toFixed(3) + ")");
        return buffer;
    }
    function isDataFile(url) { return /slope_data\.unityweb(\?|#|$)/.test(String(url)); }

    // --- XMLHttpRequest -----------------------------------------------------
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__slopeBlocked = isBlocked(url);
        this.__slopeData = isDataFile(url);
        if (this.__slopeBlocked) noteBlocked("xhr", url);
        return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        if (this.__slopeData && stackCount > 1) {
            // The Unity loader assigns onload before send() and reads
            // xhr.response inside it; patch the buffer first and shadow the
            // prototype getter on this instance.
            var xhr = this, userOnload = xhr.onload;
            xhr.onload = function () {
                try {
                    if (xhr.response instanceof ArrayBuffer) {
                        var patched = patchDataFile(xhr.response);
                        Object.defineProperty(xhr, "response", { value: patched, configurable: true });
                    }
                } catch (e) { console.warn("[slope-mod] data patch failed", e); }
                if (typeof userOnload === "function") return userOnload.apply(this, arguments);
            };
        }
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

    // --- fetch -------------------------------------------------------------
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

    // --- injected <script src> ---------------------------------------------
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

    // --- HUD ---------------------------------------------------------------
    var game = null;
    var hud, timerEl, fsBtn;
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
        hideTimer = setTimeout(function () { hud.classList.add("hidden"); }, 2500);
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

    function buildStackMenu() {
        var box = document.getElementById("hud-stack");
        if (!box) return;
        for (var n = 1; n <= STACK_MAX; n++) {
            (function (n) {
                var b = document.createElement("button");
                b.type = "button"; b.className = "hud-btn hud-stack-btn" + (n === stackCount ? " active" : "");
                b.textContent = String(n);
                b.title = n === 1 ? "Normal course" : n + " courses stacked on top of each other";
                b.addEventListener("click", function () {
                    if (n === stackCount) return;
                    writeStack(n);
                    location.reload();   // the scene reads BlockLength once, at load
                });
                box.appendChild(b);
            })(n);
        }
    }

    window.SlopeMod = {
        blockedCount: function () { return blockedCount; },
        stackCount: function () { return stackCount; },
        stackApplied: function () { return stackApplied; },
        init: function (gameInstance) {
            game = gameInstance;
            hud = document.getElementById("hud");
            timerEl = document.getElementById("hud-timer");
            fsBtn = document.getElementById("hud-fs");
            buildStackMenu();
            if (fsBtn) fsBtn.addEventListener("click", function () {
                toggleFullscreen();
                fsBtn.blur(); // give the keyboard back to the game
            });
            document.addEventListener("keydown", function (e) {
                if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    toggleFullscreen();
                }
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
            tickTimer();
            showHud();
        }
    };
})();
