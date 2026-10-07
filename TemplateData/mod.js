/* Slope mod runtime.
 *
 * 1. Network shim: the Unity build phones home to id.net / y8.com for ads,
 *    autologin and leaderboards. Every XHR, fetch and injected <script>
 *    aimed at those hosts is failed locally before it leaves the browser.
 *    The game already handles "failed to load ads" gracefully.
 * 2. HUD: fullscreen button (or F key), session timer, auto-hide while
 *    playing, reappear on mouse move.
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

    // --- XMLHttpRequest -----------------------------------------------------
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

    window.SlopeMod = {
        blockedCount: function () { return blockedCount; },
        init: function (gameInstance) {
            game = gameInstance;
            hud = document.getElementById("hud");
            timerEl = document.getElementById("hud-timer");
            fsBtn = document.getElementById("hud-fs");
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
