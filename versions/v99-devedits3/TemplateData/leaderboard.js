/* Slope mod: a working leaderboard (loaded after mod.js).
 *
 * The game's own leaderboard was an id.net panel that no longer initialises (the white "Register to submit" box on
 * the game-over screen). This one keeps scores on the mod's own server (edit-server/server.js, /api/scores, the same
 * host as dev mode) and draws itself the way the game's menu is drawn: the 6809CHAR dot-matrix font the game's UI
 * uses, #00ff00 on black, 2 px outlined boxes, all sized from the game canvas height like the Unity canvas scaler
 * (the "Play" box is 74/600 of the height, the id.net panel 400/600 square starting 102/600 down, centred).
 *
 * On game over the panel appears exactly where the id.net panel was, covering it, with the top runs, the player's
 * rank and best, and a name entry ("TYPE NAME", as the original title screen had). A run's score (the game's own
 * counter, coins included) is posted when the ball dies, once a name is set. L opens and closes the panel at any
 * time the game is not running; before the first run a "Leaderboard" box also covers the title menu's own button.
 *
 * API: window.SlopeLeaderboard = { open, close, name, setName, refresh, stats }.
 */
(function () {
    "use strict";
    var KEY_NAME = "slope-mod.player";
    var API = (window.SLOPE_EDIT_API || "").replace(/\/+$/, "");
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }
    var playerName = (lsGet(KEY_NAME) || "").slice(0, 14);
    var root = null, panel = null, rowsEl = null, footEl = null, statusEl = null, nameInput = null, titleBtn = null;
    var open = false, lastTop = null, lastRank = null, lastBest = 0, pending = null, posted = 0, failed = 0, lastDeaths = 0, firstRun = true, lastRunScore = null;

    // ------------------------------------------------------------------ layout: follow the game canvas
    function canvas() { return document.querySelector("#gameContainer canvas") || document.querySelector("canvas"); }
    function layout() {
        var c = canvas(); if (!c || !root) return;
        var r = c.getBoundingClientRect();
        root.style.left = (r.left + window.scrollX) + "px"; root.style.top = (r.top + window.scrollY) + "px";
        root.style.width = r.width + "px"; root.style.height = r.height + "px";
        root.style.setProperty("--u", (r.height / 600) + "px");
    }
    function build() {
        if (root) return;
        root = document.createElement("div"); root.className = "lb-root";
        titleBtn = document.createElement("div"); titleBtn.className = "lb-box lb-btn lb-title-btn"; titleBtn.textContent = "Leaderboard";
        titleBtn.style.cssText = "width: calc(var(--u) * 314); height: calc(var(--u) * 74); left: calc(50% - var(--u) * 157); top: calc(var(--u) * 471); display: none;";
        titleBtn.addEventListener("click", function () { openPanel(); });
        panel = document.createElement("div"); panel.className = "lb-box lb-panel"; panel.style.display = "none";
        panel.innerHTML = '<div class="lb-head"><span>SLOPE LEADERBOARD</span><span class="lb-close" title="Close (L)">X</span></div>' +
            '<div class="lb-rows"></div>' +
            '<div class="lb-foot"><div class="lb-you"></div><div><span class="lb-dim">NAME </span><input class="lb-name-input" maxlength="14" placeholder="TYPE NAME" spellcheck="false" autocomplete="off"></div><div class="lb-status"></div></div>';
        rowsEl = panel.querySelector(".lb-rows"); footEl = panel.querySelector(".lb-you"); statusEl = panel.querySelector(".lb-status"); nameInput = panel.querySelector(".lb-name-input");
        nameInput.value = playerName;
        nameInput.addEventListener("change", function () { setName(nameInput.value); });
        nameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { setName(nameInput.value); nameInput.blur(); } e.stopPropagation(); });
        panel.querySelector(".lb-close").addEventListener("click", closePanel);
        root.appendChild(titleBtn); root.appendChild(panel);
        document.body.appendChild(root);
        window.addEventListener("resize", layout); setInterval(layout, 1000); layout();
    }
    function setName(n) {
        n = String(n || "").replace(/[^A-Za-z0-9 _.\-]/g, "").trim().slice(0, 14);
        playerName = n; lsSet(KEY_NAME, n || null); if (nameInput && nameInput.value !== n) nameInput.value = n;
        if (n && lastRunScore !== null && !lastRunScore.posted) post(lastRunScore);   // the run that just ended gets its name
        else refresh();
    }

    // ------------------------------------------------------------------ the server
    function api(path, opts) {
        if (!API) return Promise.reject(new Error("no server"));
        return fetch(API + path, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
    }
    function refresh() {
        if (!API) { render(null); return; }
        api("/api/scores?name=" + encodeURIComponent(playerName)).then(function (j) { lastTop = j.top; lastRank = j.rank; lastBest = j.best || 0; render(j); })
            .catch(function (e) { setStatus("Leaderboard unreachable: " + e.message); });
    }
    function post(run) {
        if (!API || !playerName || run.posted) return;
        run.posted = true; pending = run;
        api("/api/scores", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: playerName, score: run.score, mode: run.mode, version: run.version }) })
            .then(function (j) { posted++; lastRank = j.rank; lastBest = j.best; setStatus("Score " + run.score + " sent" + (j.rank ? ": rank " + j.rank : "") + "."); refresh(); })
            .catch(function (e) { failed++; run.posted = false; setStatus("Could not send the score: " + e.message); });
    }

    // ------------------------------------------------------------------ drawing the panel
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
    function setStatus(s) { if (statusEl) statusEl.textContent = s || ""; }
    function render(j) {
        if (!rowsEl) return;
        if (!j) { rowsEl.innerHTML = '<div class="lb-row"><span class="lb-name">' + (API ? "LOADING" : "NO SERVER ON THIS PAGE") + "</span></div>"; return; }
        var html = "", me = playerName.toLowerCase();
        var rows = (j.top || []).slice(0, 10);
        if (!rows.length) html = '<div class="lb-row"><span class="lb-name">NO SCORES YET. BE THE FIRST.</span></div>';
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i], mine = me && r.name.toLowerCase() === me;
            html += '<div class="lb-row' + (mine ? " me" : "") + '"><span class="lb-rank">' + (i + 1) + ".</span><span class=\"lb-name\">" + esc(r.name.toUpperCase()) + '</span><span class="lb-score">' + r.score + "</span></div>";
        }
        rowsEl.innerHTML = html;
        var you = "";
        if (lastRunScore) you += "RECENT SCORE " + lastRunScore.score + "   ";
        if (playerName) you += "BEST " + (j.best || lastBest || 0) + (j.rank ? "   RANK " + j.rank + " OF " + j.players : "");
        footEl.textContent = you;
    }
    function openPanel() { build(); open = true; panel.style.display = "flex"; titleBtn.style.display = "none"; layout(); render(null); refresh(); }
    function closePanel() { if (!panel) return; open = false; panel.style.display = "none"; if (firstRun && !running()) titleBtn.style.display = "flex"; }
    function running() { try { return !!(window.SlopeMod && SlopeMod.stats().running); } catch (e) { return false; } }

    // ------------------------------------------------------------------ the game's state: game over opens it, a run closes it
    function tick() {
        if (!window.SlopeMod) return;
        var st; try { st = SlopeMod.stats(); } catch (e) { return; }
        if (st.running) {
            if (open) closePanel();
            if (titleBtn && titleBtn.style.display !== "none") titleBtn.style.display = "none";
            firstRun = false;
            return;
        }
        if ((st.deaths || 0) > lastDeaths) {               // a run just ended: remember its score, send it, show the board where id.net's panel was
            lastDeaths = st.deaths;
            var score = 0; try { score = SlopeMod.score() || 0; } catch (e) { /* no score var */ }
            lastRunScore = { score: score, mode: (SlopeMod.track && SlopeMod.track().mode) || "off", version: (document.querySelector("#hud-version") || {}).value || "latest", posted: false };
            if (playerName) post(lastRunScore);
            setTimeout(openPanel, 400);
        }
        if (firstRun && !open && loaded()) { build(); if (titleBtn.style.display === "none") titleBtn.style.display = "flex"; }
    }
    function loaded() { try { return !SlopeMod.loaded || SlopeMod.loaded(); } catch (e) { return true; } }

    // ------------------------------------------------------------------ the shader style's colour (shaders.js recolours the game's green; match it)
    var TINTS = { "color-red": [1, 0.05, 0.05], "color-orange": [1, 0.5, 0], "color-yellow": [1, 0.95, 0.05], "color-blue": [0.1, 0.35, 1],
        "color-indigo": [0.3, 0.1, 0.85], "color-violet": [0.65, 0.15, 1], synthwave: [0.1, 0.55, 1], noir: [0.85, 0.85, 0.85] };
    function hueRgb(h) {   // fully saturated, full value
        var f = function (n) { var k = (n + h * 6) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)); };
        return [f(5), f(3), f(1)];
    }
    function styleRgb() {
        var S = window.SlopeShaders; if (!S) return null;
        try {
            if (S.enabled && !S.enabled()) return null;
            var id = S.style(), amt = S.intensity ? S.intensity() : 1, t;
            if (id === "rainbow") t = hueRgb((performance.now() / 3500 + 0.82) % 1);
            else if (TINTS[id]) { var c = TINTS[id], mx = Math.max(c[0], c[1], c[2]); t = [c[0] / mx, c[1] / mx, c[2] / mx]; }
            else return null;
            return [t[0] * amt, 1 + (t[1] - 1) * amt, t[2] * amt];   // blended from the game's green by the effect amount
        } catch (e) { return null; }
    }
    var lastTint = "";
    function tint() {
        if (!root) return;
        var c = styleRgb(), s = c ? "rgb(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + ")" : "#00ff00";
        if (s !== lastTint) { lastTint = s; root.style.setProperty("--lb-c", s); }
    }
    document.addEventListener("keydown", function (e) {
        var t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
        if ((e.key === "l" || e.key === "L") && !running()) { if (open) closePanel(); else openPanel(); }
        else if (e.key === "Escape" && open) closePanel();
    });
    function start() { build(); setInterval(tick, 250); setInterval(tint, 100); tint(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
    window.SlopeLeaderboard = {
        open: openPanel, close: closePanel, refresh: refresh,
        name: function () { return playerName; }, setName: setName,
        stats: function () { return { open: open, name: playerName, posted: posted, failed: failed, rank: lastRank, best: lastBest, top: lastTop ? lastTop.length : null, api: API }; }
    };
})();
