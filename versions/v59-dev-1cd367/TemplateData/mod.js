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
 * 3. Visual styles (Rainbow, Neon glow, Synthwave, CRT, ...) are post-
 *    processing passes over the finished frame, in TemplateData/shaders.js
 *    (loaded before this file). This file only exposes the ball's speed to
 *    it (SlopeMod.speed) and keeps its own draw-call counting hook.
 *
 * 4. HUD: fullscreen (F, whole page so the HUD stays), R restarts, T pauses, V cycles
 *    the style, session timer, Courses / Style / Music / Track controls,
 *    auto-hide while playing.
 *
 * 5. Dev mode: typing "devmode" opens a password-locked box that asks Claude Code
 *    (via edit-server/) to change this mod; see edit-server/README.md.
 *
 * 6. Track shaping (Curves / Turns): the course itself bends, built by
 *    rotating the spawn point; camera, forces and gravity follow (WASM heap).
 */
(function () {
    "use strict";
    // ---- game clock (installed before Unity loads): Unity reads time through performance.now() / Date.now(); while
    // the game is paused (T) both stand still, and afterwards they run on minus the paused time, so on resume the
    // game does not catch up on the seconds it was paused
    var clockPaused = false, clockPauseAt = 0, clockOffset = 0;
    var realPerfNow = performance.now.bind(performance), realDateNow = Date.now.bind(Date);
    performance.now = function () { return (clockPaused ? clockPauseAt : realPerfNow()) - clockOffset; };
    Date.now = function () { return realDateNow() - clockOffset - (clockPaused ? realPerfNow() - clockPauseAt : 0); };
    function freezeClock(on) {
        if (on && !clockPaused) { clockPauseAt = realPerfNow(); clockPaused = true; }
        else if (!on && clockPaused) { clockOffset += realPerfNow() - clockPauseAt; clockPaused = false; }
    }

    // ======================================================================
    // Settings (localStorage, with safe fallbacks)
    // ======================================================================
    var KEY_STACK = "slope-mod.stack";
    var KEY_MUSIC = "slope-mod.music";
    var KEY_GRAVITY = "slope-mod.gravity";
    var STACK_MAX = 99;

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }

    var stackTarget = (function () { var n = parseInt(lsGet(KEY_STACK), 10); return (n >= 1 && n <= STACK_MAX) ? n : 1; })();
    var TRACKS = [
        { id: "original", name: "Original" },
        { id: "aria", name: "Aria Math (Phonk Remix)", file: "../../TemplateData/music/aria-math-phonk-remix.mp3" },
        { id: "billie", name: "Mort Jackson \u2013 Billie Jean", file: "../../TemplateData/music/mort-jackson-billie-jean.mp3" },
        { id: "sax", name: "Epic Sax Gandalf", file: "../../TemplateData/music/epic-sax-gandalf.mp3" }
    ];
    var GRAVITY_MODES = ["off", "curves", "twists", "both"];
    var gravityMode = (function () { var m = lsGet(KEY_GRAVITY); return GRAVITY_MODES.indexOf(m) >= 0 ? m : "off"; })();
    var musicId = (function () { var id = lsGet(KEY_MUSIC); return TRACKS.some(function (t) { return t.id === id; }) ? id : "original"; })();

    function themeSetting(name) { var saved = lsGet("slope-mod." + name); return saved === null ? musicId === "billie" : saved === "true"; }
    var mortEnabled = musicId === "billie", julienEnabled = musicId === "billie";
    function setMort(on) { mortEnabled = !!on; lsSet("slope-mod.mort", mortEnabled); var el = document.getElementById("hud-mort"); if (el) el.checked = mortEnabled; syncBuilding(); }
    function setJulien(on) { julienEnabled = !!on; lsSet("slope-mod.julien", julienEnabled); var el = document.getElementById("hud-julien"); if (el) el.checked = julienEnabled; }

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
    // WebGL hook: draw-call counts for the stacker. (The visual styles live in
    // shaders.js, which captured the raw entry points before this wrapper, so
    // its own passes are not counted here.)
    // ======================================================================
    // Draw-call fingerprint of this build: a 5190-index draw is the city
    // skyline, which the game spawns once per restart (one second in) and
    // which lives in the same pool as the blocks, so it is a reliable sign
    // that the world has been cleared (count drops to 0) or is in a run.
    var COURSE_BATCH = 5190;

    var frameDraws = [];          // index counts of draws in the frame being rendered

    function hookContext(P) {
        var origDE = P.drawElements, origDA = P.drawArrays;
        var origDEI = P.drawElementsInstanced, origDAI = P.drawArraysInstanced;
        P.drawElements = function (mode, count) { frameDraws.push(count); return origDE.apply(this, arguments); };
        P.drawArrays = function (mode, first, count) { frameDraws.push(count); return origDA.apply(this, arguments); };
        if (origDEI) P.drawElementsInstanced = function (mode, count) { frameDraws.push(count); return origDEI.apply(this, arguments); };
        if (origDAI) P.drawArraysInstanced = function (mode, first, count) { frameDraws.push(count); return origDAI.apply(this, arguments); };
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
    var musicNode = null;          // the currently audible (or suppressed) source
    var musicRoot = null;          // the source Unity owns and will stop on death
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
            if (this.context) gameAudioCtx = this.context;
            this.__slopeDur = this.buffer ? this.buffer.duration : 0;
            if (this.__slopeDur < MUSIC_MIN_SECONDS) return absStart.apply(this, arguments);
            musicStarted = true;
            musicRoot = musicNode = this;
            this.__slopeDead = false;
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
            if (this.__slopeDur >= MUSIC_MIN_SECONDS && this === musicRoot) {
                musicStopped = true;
                pauseCustom();
                this.__slopeDead = true;
                if (musicNode && musicNode !== this) {
                    // Switching back to Original creates a source Unity does not know about.
                    // Its lifetime must still follow the source Unity stops.
                    if (!musicNode.__slopeDead && !musicNode.__slopeSuppressed) absStop.apply(musicNode, arguments);
                    musicNode.__slopeDead = true;
                }
            }
            if (this.__slopeSuppressed) return;            // never started, or already stopped for a music switch
            return absStop.apply(this, arguments);
        };
    }

    function setMusic(id) {
        var t = trackById(id); id = t.id;
        if (id === musicId) return;
        var was = musicId; musicId = id; lsSet(KEY_MUSIC, id);
        setMort(id === "billie"); setJulien(id === "billie");   // the Mort and King Julien themes follow the Mort Jackson track
        var node = musicNode;
        if (!node || node.__slopeDead) return;             // changing the selection after death must stay silent
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
    var builds = 0, resetsSent = 0, deaths = 0, restarts = 0, stuckRestarts = 0;
    var lastRestart = -1000, lastRestartAt = 0, gameRunning = false;
    var frameNo = 0, debugLog = [];   // debugLog: last 40 decisions, for diagnostics
    var lastLoopT = 0, worstGap = 0, worstGapFrame = 0, bigGaps = [], lastDraws = [];   // diagnostics: main-thread stalls between frames, last frame's draw list
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
    // Hidden courses are built in one frame, so they cannot follow the roll of a shaped track: the straight
    // hidden lanes cut through the rolled live lane and wedge the ball. The stack applies on a straight track only.
    // Hidden courses are built in one frame (flat, at the roll the spawn transform had), so on a shaped track they
    // cut through the rolled live lane. Allowed anyway as an experiment (the stuck-ball watchdog restarts a wedged run).
    var STACK_ON_TRACK = true;
    function stackWanted() { return gravityMode === "off" || STACK_ON_TRACK ? stackTarget : 1; }
    function refreshStackNote() {
        if (!stackInput) return;
        var off = gravityMode !== "off" && stackTarget > 1 && !STACK_ON_TRACK, warn = gravityMode !== "off" && stackTarget > 1 && STACK_ON_TRACK;
        stackInput.classList.toggle("muted", off); stackInput.classList.toggle("warn", warn);
        stackInput.title = off ? "Courses stack only on a straight track (hidden courses cannot follow a rolled lane); this number applies again when Track is Straight" : warn ? "Experimental: stacked courses on a rolled track. The hidden courses stay straight and cut through the twists; expect wedges and falls (a stuck run restarts by itself)" : "Type a number: 1 = normal game";
    }
    function startBuild(existing) {
        // `existing` courses are already in the world with their start section
        // at the origin (1 right after a restart, 0 after a clear); they become
        // hidden layers under the ones built here
        build = { phase: existing > 0 ? "laps" : "course", hidden: existing, hiddenTarget: Math.max(stackWanted() - 1, 0),
                  laps: 0, since: frameNo, started: frameNo, tries: 0, lastLift: -1000, startSent: false };
        if (build.hidden >= build.hiddenTarget) build.phase = "settle";
        builds++; note("building " + stackWanted() + " courses from " + existing);
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

    // A ball that cannot move forward never dies: wedged between two stacked courses at a section drop (the ball sits
    // alive in the gap, steering still slides it sideways), or in a kink of a rolled lane. In the modded modes (a
    // stack, or a track mode) such a run is restarted like a death; in a plain game the ball is left alone.
    var stuck = { pos: null, since: 0, lastTick: 0, sRef: 0, sSince: 0 };
    var STUCK_SECONDS = 1.5, STUCK_GRACE_MS = 4000, STUCK_MAX_GAP_MS = 500;
    var CREEP_SECONDS = 2, CREEP_UNITS = 10;   // a ball that advances less than this along the course in this time is creeping in a wedge (a rolled lane against a hidden straight one)
    function stepStuckWatch() {
        var now = performance.now(), gap = now - stuck.lastTick; stuck.lastTick = now;
        // Startup waits are measured in seconds, independent of display refresh rate.
        // A suspended tab or delayed frame is not evidence that physics is stuck:
        // Unity has not had a chance to advance the ball when this callback runs.
        if (!gameRunning || build || restartSeq || now - lastRestartAt < STUCK_GRACE_MS || document.hidden || gap > STUCK_MAX_GAP_MS || (stackWanted() <= 1 && gravityMode === "off")) { stuck.pos = null; return; }
        trackBall(); var p = ballPos; if (!p) return;
        var sNow = vdot(p, FWD0);
        if (!stuck.pos) { stuck.pos = p.slice(); stuck.since = now; stuck.sRef = sNow; stuck.sSince = now; return; }
        if (Math.abs(p[1] - stuck.pos[1]) > 0.05 || Math.abs(p[2] - stuck.pos[2]) > 0.05) { stuck.pos = p.slice(); stuck.since = now; }   // any forward or vertical movement resets; sideways alone does not
        if (sNow - stuck.sRef > CREEP_UNITS) { stuck.sRef = sNow; stuck.sSince = now; }
        var why = now - stuck.since > STUCK_SECONDS * 1000 ? "stuck for " + STUCK_SECONDS + " s" : now - stuck.sSince > CREEP_SECONDS * 1000 ? "creeping (under " + (CREEP_UNITS / CREEP_SECONDS) + " u/s)" : null;
        if (why) { stuckRestarts++; note("ball " + why + " at s=" + sNow.toFixed(0) + ", restarting"); stuck.pos = null; requestRestart(false); }
    }
    function examineFrame(draws) {
        var c = 0;
        for (var i = 0; i < draws.length; i++) if (draws[i] === COURSE_BATCH) c++;
        lastCourseCount = c;
        var wasRunning = gameRunning;
        var restarted = musicStarted; if (restarted) { lastRestart = frameNo; lastRestartAt = performance.now(); gameRunning = true; resetTrackRun(); }
        var died = musicStopped && !musicStarted && frameNo - lastRestart > RESTART_GRACE;
        if (died) gameRunning = false;                 // (the skyline draw count is not used here: the camera may simply be looking away)
        musicStopped = musicStarted = false;

        if (restartSeq) {
            stepRestart();
        } else if (build) {
            stepBuild(restarted);
        } else if (restarted && !wasRunning) {          // Enter at the menu / game over, not a late reset confirmation
            if (stackWanted() > 1) startBuild(1);
        } else if (died) {
            deaths++;
            if (gravityMode !== "off") setState(SPAWNER, "Offset Buildings to Match Spawner");   // park a run that is still spawning block by block before the game's death flow interrupts it
            if (stackWanted() > 1) requestRestart(true);  // instant restart with the stack rebuilt
        }
        stepStuckWatch();
    }

    // Background pillars use the Mort toggle, otherwise follow the music. Skyline chunks use
    // ModBuilding (tools/patch_buildings.py): original pillars, Aria zombies or Mort models.
    // Changes apply to new chunks, or the whole crowd after restarting.
    var buildingPtr = null, buildingWritten = 0;
    function syncBuilding() {
        if (!H.vars.ModBuilding) return;
        if (!buildingPtr) {
            var p0 = readGoVar("ModBuildingFlat"), pz = readGoVar("ModBuildingZombie"), pm = readGoVar("ModBuildingMort");
            if (!(p0 && pz && pm && readGoVar("ModBuilding") === p0)) return;   // not discovered yet, or not the layout we expect
            buildingPtr = { original: p0, aria: pz, billie: pm }; note("building prefabs: flat " + p0 + " zombie " + pz + " mort " + pm);
        }
        var want = mortEnabled ? buildingPtr.billie : musicId === "aria" ? buildingPtr.aria : buildingPtr.original;
        if (want !== buildingWritten) { writeGoVar("ModBuilding", want); buildingWritten = want; }
    }
    // ---- pause (T): freezes Unity's main loop (Emscripten Module.pauseMainLoop), suspends the game's WebAudio
    // context and the custom track, and holds every mod sequencer and watchdog so nothing counts frames meanwhile
    var paused = false, pauseOverlay = null, pauseResumeAudio = false, gameAudioCtx = null;
    function setPaused(on) {
        var M = game && game.Module; on = !!on;
        if (on === paused || !M || typeof M.pauseMainLoop !== "function") return;
        paused = on;
        if (on) {
            freezeClock(true);
            M.pauseMainLoop();
            if (gameAudioCtx && gameAudioCtx.state === "running") gameAudioCtx.suspend();
            pauseResumeAudio = !!(audioEl && !audioEl.paused); if (pauseResumeAudio) audioEl.pause();
            if (autoKey) { keyEvent("keyup", autoKey, autoKey === "ArrowLeft" ? 37 : 39); autoKey = null; }
        } else {
            if (gameAudioCtx && gameAudioCtx.state === "suspended") gameAudioCtx.resume();
            if (pauseResumeAudio && audioEl) { var pr = audioEl.play(); if (pr && pr.catch) pr.catch(function () {}); }
            lastLoopT = 0; lastFrameT = 0;                               // no giant frame gap after the pause
            freezeClock(false);
            M.resumeMainLoop();
        }
        if (!pauseOverlay) {
            pauseOverlay = document.createElement("div"); pauseOverlay.className = "pause-overlay";
            pauseOverlay.innerHTML = '<div class="pause-title">PAUSED</div><div class="pause-hint">press T to resume</div>';
            document.body.appendChild(pauseOverlay);
        }
        pauseOverlay.classList.toggle("on", on);
        note(on ? "paused" : "resumed");
    }
    function frameLoop() {
        if (paused) { requestAnimationFrame(frameLoop); return; }
        frameNo++;
        var nowL = performance.now(); if (lastLoopT) { var gapL = nowL - lastLoopT; if (gapL > worstGap) { worstGap = gapL; worstGapFrame = frameNo; } if (gapL > 300) { bigGaps.push([frameNo, Math.round(gapL)]); if (bigGaps.length > 60) bigGaps.shift(); } } lastLoopT = nowL;
        var draws = frameDraws; frameDraws = [];
        lastDraws = draws;
        try { examineFrame(draws); } catch (e) { /* never break the game loop */ }
        try { syncBuilding(); } catch (e) { /* diagnostics only */ }
        try { stepAhead(); } catch (e) { /* never break the game loop */ }
        try { stepTrack(gameRunning && !build && !restartSeq); } catch (e) { if (!trackDebug.err) { trackDebug.err = String(e); note("track error: " + e); } }
        requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);   // registered before Unity's loop, so it runs first each frame

    // ======================================================================
    // 6. Track shaping: the course rolls about its own centre line.
    //    A roll profile theta(s) is planned along the course axis (s = distance
    //    along FWD0 from the start). The spawner builds a lap by translating the
    //    SpawnPos transform forward in its own frame and every block copies its
    //    rotation (scene patch), so each frame the transform gets the rotation
    //    for its current s and is shifted sideways so the lane's centre line
    //    stays put while the lane turns about it (the lane spans 0..10 along
    //    the spawner's lateral axis; the ball rides 5 in). Gravity, the forward
    //    push, steering (all hard-wired to world axes in the game; the mod reads
    //    the magnitudes from the PlayMaker variables and adds the difference
    //    through gravity) and the camera rig use the frame at the ball's own s,
    //    so the ball rides the twisting ribbon continuously. Everything is found
    //    in the WebAssembly heap by value once, at the menu.
    // ======================================================================
    var G0 = -9.8100004196167, BALL_MASS = 30;
    var PITCH_SX = -0.70710678, PITCH_CX = 0.70710678;         // SpawnPos rest rotation after the scene patch: -90 degrees about x (blocks copy it)
    var H = { grav: [], spawn: [], spawnLive: -1, spawnCache: -1, rig: -1, chase: -1, ball: -1, ballCands: [], vars: {}, kill: -1 };
    var ballPos = null, ballVel = [0, 0, 0], ballT = 0;
    var CAMERA_OFFSET = [0, 3.0560860633850098, -1.2071590423583984];
    var CAMERA_ROTATION = [0.4355890154838562, 0, 0, 0.9001456499099731];
    var cameraFollowing = false;
    var track = null;                 // per-run state, see resetTrackRun()
    var keysHeld = { left: false, right: false };
    var trackDebug = { laps: 0, twists: 0 };
    var spawnTrace = [];              // debug: [frame, s] whenever the game moved the spawn point
    var twistQueue = [];              // debug/test: forced rolls in degrees for the next planned laps (0 = straight lap)
    var LANE_HALF = 5;                // the ball's line is 5 along the lateral axis from the spawn point
    var BLOCK_LEN = 14.1421;          // a lane block along the course
    var RATE_DEG = 4.5, RATE = RATE_DEG * Math.PI / 180;   // roll per block inside a roll: the twisted block prefabs (scene patch) are helicoids of exactly this much
    var TWIST_AT = 30;                // a 90-degree twist (20 blocks) starts this far into the lap
    var CURVE_AT = 10;                // a slow roll (120..240 degrees, one block at a time) starts this far into the lap
    var SECTION_DELAY = 0.001;        // ModSectionDelay (scene patch): any positive Wait takes a frame, so one block per frame
    var sectionDelayWritten = -1, frameDt = 1 / 60, lastFrameT = 0;
    var sectionDelayOverride = null;   // debug/test
    var autopilot = false, autoKey = null, autoErr = null, autoPred = null;   // debug/test: steer the ball toward the lane's centre line
    var gravBadge = null, gravWritten = false;

    function heap32() { return game && game.Module ? game.Module.HEAPF32 : null; }
    function heapU32() { return game && game.Module ? game.Module.HEAPU32 : null; }
    function heapU8() { return game && game.Module ? game.Module.HEAPU8 : null; }
    function heapU16() { return game && game.Module ? game.Module.HEAPU16 : null; }
    function fbits(f) { var b = new Float32Array([f]); return new Uint32Array(b.buffer)[0]; }
    function findTriple(a, b, c) {
        var u = heapU32(); if (!u) return [];
        var A = fbits(a), B = fbits(b), C = fbits(c), out = [];
        for (var i = 0, n = u.length - 2; i < n; i++) if (u[i] === A && u[i + 1] === B && u[i + 2] === C) out.push(i);
        return out;
    }
    function nearSeq(vals, eps) { return nearSeqMulti([[vals, eps]])[0]; }
    function nearSeqMulti(specs) {          // tolerant scans for runs of floats, all in one pass over the heap
        var f = heap32(); if (!f) return specs.map(function () { return []; });
        var outs = specs.map(function () { return []; }), n = f.length - 10, m = specs.length, i, j, k, sp, vals, eps;
        for (i = 0; i < n; i++) {
            var v = f[i];
            for (j = 0; j < m; j++) {
                sp = specs[j]; vals = sp[0]; eps = sp[1];
                if (!(Math.abs(v - vals[0]) < eps)) continue;                      // NaN never matches
                for (k = 1; k < vals.length; k++) if (!(Math.abs(f[i + k] - vals[k]) < eps)) break;
                if (k === vals.length) outs[j].push(i);
            }
        }
        return outs;
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
    // All names at once: the string objects' addresses go into a bitmap, then ONE pass over the heap finds every
    // object whose +12 field points at one of them (a per-string pass took seconds each: 80 copies of a name = 16 s).
    function findFsmFloatsMulti(names) {
        var u = heapU32(), out = {}, owner = {}, flags = new Uint8Array((u.length >> 3) + 1), any = false;
        names.forEach(function (nm) {
            out[nm] = [];
            findStringObjects(nm).forEach(function (a) { owner[a] = nm; flags[a >> 5] |= 1 << ((a >> 2) & 7); any = true; });
        });
        if (!any) return out;
        for (var i = 0, n = u.length; i < n; i++) {
            var v = u[i];
            if ((v & 3) === 0 && (flags[v >> 5] & (1 << ((v >> 2) & 7))) && owner[v] !== undefined) out[owner[v]].push(i * 4 - 12);   // object whose +12 field is the name
        }
        return out;
    }
    function findFsmFloats(name) { return findFsmFloatsMulti([name])[name]; }
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
    // A variable-name match is only the object itself when it has an object header: a class pointer (4-aligned, inside
    // the heap), a zero monitor word, and the class shared by the known variables of that type (FsmFloat: the game's
    // own zforce/yforce; FsmQuaternion: the ModQ variable resting at the spawn rotation). The other matches are the
    // name inside raw FSM data and unrelated objects whose field happens to point at the string: writing the value
    // at +24 of those corrupted memory the game uses at lap spawns and at game over (an abort(218) a few seconds later).
    var varKlass = {};
    function headerOk(a) { var u = heapU32(); if (!u) return false; var k = u[a >> 2]; return k > 0 && (k & 3) === 0 && k < u.length * 4 && u[(a + 4) >> 2] === 0; }
    function majorityKlass(addrs) { var u = heapU32(), n = {}, best = 0, bk = 0; addrs.forEach(function (a) { if (!headerOk(a)) return; var k = u[a >> 2]; n[k] = (n[k] || 0) + 1; if (n[k] > best) { best = n[k]; bk = k; } }); return bk; }
    function varKind(nm) { return /^ModCamera(?:Offset|Position)$/.test(nm) ? "vec3" : /^ModQ/.test(nm) ? "quat" : /^Mod(Block|Building)/.test(nm) ? "go" : /^(Score|SpeedUpCount)$/.test(nm) ? "int" : "float"; }
    function learnKlasses(found) {
        var u = heapU32(), f = heap32(); if (!u) return;
        if (!varKlass.float) varKlass.float = majorityKlass(["zforce", "yforce", "SteerForceLeft", "SteerForceRight"].reduce(function (acc, nm) { return acc.concat(liveOnly(found[nm] || H.vars[nm] || [])); }, []));
        if (!varKlass.quat) { var qs = ["ModQ1", "ModQ2", "ModQ3"].reduce(function (acc, nm) { return acc.concat(liveOnly(found[nm] || H.vars[nm] || [])); }, []);
            var rest = qs.filter(function (a) { return headerOk(a) && Math.abs(f[(a + 24) >> 2] - PITCH_SX) < 1e-3 && Math.abs(f[(a + 36) >> 2] - PITCH_CX) < 1e-3; });
            varKlass.quat = rest.length ? u[rest[0] >> 2] : majorityKlass(qs); }
        if (!varKlass.vec3) {
            var offsets = liveOnly(found.ModCameraOffset || H.vars.ModCameraOffset || []).filter(function (a) {
                return headerOk(a) && Math.abs(f[(a + 24) >> 2]) < 1e-3 && Math.abs(f[(a + 28) >> 2] - CAMERA_OFFSET[1]) < 1e-3 && Math.abs(f[(a + 32) >> 2] - CAMERA_OFFSET[2]) < 1e-3;
            });
            varKlass.vec3 = majorityKlass(offsets);
        }
        // FsmInt (the game's Score, counted by the ScorePoint triggers, and SpeedUpCount): same layout as FsmFloat, value at +24
        if (!varKlass.int) varKlass.int = majorityKlass(["Score", "SpeedUpCount"].reduce(function (acc, nm) { return acc.concat(liveOnly(found[nm] || H.vars[nm] || [])); }, []));
        if (!varKlass.go) varKlass.go = majorityKlass(Object.keys(found).filter(function (nm) { return varKind(nm) === "go"; }).reduce(function (acc, nm) { return acc.concat(liveOnly(found[nm])); }, []));
    }
    function varObjects(nm, list) { var u = heapU32(), k = varKlass[varKind(nm)]; if (varKind(nm) === "vec3" && !k) return []; return liveOnly(list).filter(function (a) { return headerOk(a) && (!k || u[a >> 2] === k); }); }
    // Heap discovery runs in slices (one per frame) so the page never freezes: pass A walks the heap as u32 with
    // exact bit patterns as cheap prefilters, pass B finds the managed strings of the FSM variable names, pass C
    // finds the variable objects pointing at them. trackReady() turns true when all three are done.
    var discover = null;
    function discoverHeap() {
        if (discover) return;
        var u = heapU32(), f = heap32(), u16 = heapU16(); if (!u) return;
        var t0 = performance.now(), N = u.length, STEP = 4 << 20;
        var B = { g: fbits(G0), b5: fbits(5), b105: fbits(10.5), bm4: fbits(-4), one: fbits(1), b10: fbits(10), bm10: fbits(-10), b300: fbits(300) };
        var names = ["zforce", "yforce", "SteerForceLeft", "SteerForceRight", "Score", "SpeedUpCount", "ModSectionDelay", "ModQ1", "ModBlock", "ModBlockFlat", "ModBlockP", "ModBlockN", "ModBuilding", "ModBuildingFlat", "ModBuildingZombie", "ModBuildingMort", "ModHold", "ModMark", "ModCameraOffset", "ModQCamera", "ModCameraTick"].filter(function (nm) { return !H.vars[nm]; });
        var firsts = {}; names.forEach(function (nm) { firsts[nm.charCodeAt(0)] = (firsts[nm.charCodeAt(0)] || []).concat([nm]); });
        var strs = {}, owner = {}, flags = null, found = {};
        names.forEach(function (nm) { strs[nm] = []; found[nm] = []; });
        var grav = [], ballCands = [], rigCands = [], spawnCands = [], chase = [], kill = [];
        var st = { pass: 0, i: 0 };
        function passA(i0, i1) {
            for (var i = i0; i < i1; i++) {
                var v = u[i];
                if (v === 0) {
                    if (u[i + 1] === B.g && u[i + 2] === 0) grav.push(i);
                    if (u[i + 1] === 0 && u[i + 2] === 0 && u[i + 3] === B.one && Math.abs(f[i + 4] - 5) < 2e-3 && Math.abs(f[i + 5] - 6.482) < 2e-3 && Math.abs(f[i + 6] + 4.737) < 2e-3 && u[i + 7] === B.one && u[i + 8] === B.one && u[i + 9] === B.one) rigCands.push(i);
                } else if (v === B.b5) { if (u[i + 1] === B.b105 && u[i + 2] === B.bm4) ballCands.push(i); }
                else if (v === B.b10) { if (u[i + 1] === B.bm10 && u[i + 2] === B.b300) kill.push(i); }
                else if (u[i + 1] === 0 && u[i + 2] === 0) {
                    var x = f[i];
                    if (Math.abs(x - PITCH_SX) < 3e-4 && Math.abs(f[i + 3] - PITCH_CX) < 3e-4) spawnCands.push(i);
                    else if (Math.abs(x - 0.43559) < 3e-4 && Math.abs(f[i + 3] - 0.90015) < 3e-4 && Math.abs(f[i + 4]) < 3e-4 && Math.abs(f[i + 5] - 3.056) < 3e-4 && Math.abs(f[i + 6] + 1.207) < 3e-4 && u[i + 7] === B.one && u[i + 8] === B.one && u[i + 9] === B.one) chase.push(i);
                }
            }
        }
        function passB(i0, i1) {               // managed strings: length at obj+8, chars at obj+12
            for (var i = i0; i < i1; i++) {
                var cands = firsts[u16[i]]; if (!cands) continue;
                for (var c = 0; c < cands.length; c++) {
                    var nm = cands[c], k;
                    for (k = 1; k < nm.length; k++) if (u16[i + k] !== nm.charCodeAt(k)) break;
                    if (k < nm.length) continue;
                    var byteAddr = i * 2; if (byteAddr % 4) continue;
                    if (u[(byteAddr - 4) >> 2] === nm.length) { var a = byteAddr - 12; strs[nm].push(a); owner[a] = nm; }
                }
            }
        }
        function passC(i0, i1) {
            for (var i = i0; i < i1; i++) { var v = u[i]; if ((v & 3) === 0 && (flags[v >> 5] & (1 << ((v >> 2) & 7))) && owner[v] !== undefined) found[owner[v]].push(i * 4 - 12); }
        }
        function finish() {
            try {
                if (!H.grav.length) H.grav = grav;
                if (!H.ballCands.length) H.ballCands = liveOnly(ballCands);
                if (!H.spawn.length) {
                    var all = liveOnly(spawnCands); H.spawnCacheCands = all.slice();
                    for (var i0 = 0; i0 < all.length; i0++) {
                        var a0 = all[i0];
                        if (f[a0 - 3] === 0 && f[a0 - 2] === 0 && f[a0 - 1] === 0 && Math.abs(f[a0 + 4] - 1) < 1e-3 && Math.abs(f[a0 + 5] - 1) < 1e-3 && Math.abs(f[a0 + 6] - 1) < 1e-3) H.spawn.push(a0);
                    }
                }
                if (!H.rigCands) H.rigCands = liveOnly(rigCands);
                if (H.chase < 0) { var c = liveOnly(chase); if (c.length) H.chase = c[c.length - 1]; }
                if (H.kill < 0) { var ks = liveOnly(kill); for (var k = 0; k < ks.length; k++) { var a = ks[k] - 7; if (Math.abs(f[a] - 0.125) < 0.01 && Math.abs(f[a + 1] + 5.15) < 0.01 && Math.abs(f[a + 2] - 18.779) < 0.01) { H.kill = a; break; } } if (H.kill < 0) H.kill = -2; }
                learnKlasses(found);
                names.forEach(function (nm) { H.vars[nm] = varObjects(nm, found[nm]); });
                note("heap (" + Math.round(performance.now() - t0) + " ms, sliced): gravity x" + H.grav.length + ", spawn recs " + H.spawn.length + ", rig cands " + H.rigCands.length + ", chase " + (H.chase >= 0) + ", kill " + (H.kill >= 0) + ", vars z/L/R/delay/q " + [H.vars.zforce, H.vars.SteerForceLeft, H.vars.SteerForceRight, H.vars.ModSectionDelay, H.vars.ModQ1].map(function (v) { return v ? v.length : 0; }).join("/"));
            } catch (e) { note("heap scan failed: " + e); }
            discover = null;
        }
        function slice() {
            try {
                var budget = performance.now() + 12;      // ms of work per frame
                while (performance.now() < budget) {
                    if (st.pass === 0) { if (st.i >= N - 10) { st.pass = 1; st.i = 0; continue; } var e = Math.min(st.i + STEP, N - 10); passA(st.i, e); st.i = e; }
                    else if (st.pass === 1) { if (!names.length || st.i >= u16.length - 20) { st.pass = 2; st.i = 0; flags = new Uint8Array((N >> 3) + 1); Object.keys(owner).forEach(function (a) { a = +a; flags[a >> 5] |= 1 << ((a >> 2) & 7); }); continue; } var e1 = Math.min(st.i + 2 * STEP, u16.length - 20); passB(st.i, e1); st.i = e1; }
                    else if (st.pass === 2) { if (!names.length || st.i >= N) { finish(); return; } var e2 = Math.min(st.i + STEP, N); passC(st.i, e2); st.i = e2; }
                }
            } catch (e) { note("heap scan failed: " + e); discover = null; return; }
            discover = setTimeout(slice, 0);
        }
        discover = setTimeout(slice, 0);
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
    // CameraDummy copies the ball position, clamping x to 3..7 in close mode.
    // This diagnostic reproduces that rule; the rolled camera reads Sphere directly.
    function rigPos() { return ballPos ? [Math.min(7, Math.max(3, ballPos[0])), ballPos[1], ballPos[2]] : null; }
    function writeChaseLocal(x, y, z) { var f = heap32(); if (!f || H.chase < 0) return; f[H.chase + 4] = x; f[H.chase + 5] = y; f[H.chase + 6] = z; }

    function trackBall() {
        var f = heap32(); if (!f) return;
        if (H.ball < 0) {
            for (var i = 0; i < H.ballCands.length; i++) { var a = H.ballCands[i]; if (a < LIVE_MIN) continue; if (Math.abs(f[a] - 5) > 0.05 || Math.abs(f[a + 1] - 10.5) > 0.05 || Math.abs(f[a + 2] + 4) > 0.05) { H.ball = a; note("ball tracked at " + a); break; } }
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
    function frameQ(roll) { return qaxis(FWD0, roll); }        // world rotation of the course frame: roll about the course axis
    function spawnQ(roll) { return qmul(frameQ(roll), Q_REST); }
    function frameAxes(roll) {                                  // axes of the frame at a roll angle
        var R = frameQ(roll);
        return { R: R, n: qrot(R, N0), xh: qrot(R, [1, 0, 0]), yh: qrot(R, [0, 1, 0]), zh: qrot(R, [0, 0, 1]) };
    }
    function v3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
    function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
    function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
    function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function vlen(a) { return Math.sqrt(vdot(a, a)); }
    // ---- per-run track state -------------------------------------------------
    function resetTrackRun() {
        track = { jobs: [], sections: [], roll: 0, lastSpawn: null, moving: false, stillFrames: 0, laps: 0, camQ: [0, 0, 0, 1], dApplied: [0, 0, 0], fallFrames: 0, wroteA0: 0, wroteA1: 0, wroteDir: 0, lastPlanS: -1000 };
        note("track reset" + (twistQueue.length ? " (forced " + twistQueue[0] + ")" : ""));
        ballPos = null; ballVel = [0, 0, 0]; cameraFollowing = false; writeFloatVar("ModCameraTick", 0);
        if (window.SlopeCoins) SlopeCoins.reset();   // a new run: the coins of the old course are gone with it
        writeSpawnRot(spawnQ(0)); writeQuatVar("ModQ1", spawnQ(0)); writeBlockChoice(0); writeRigQ([0, 0, 0, 1]); writeChaseLocal(0, 3.056, -1.207);
    }
    function writeSpawnRot(q) {
        var f = heap32(); if (!f || H.spawnLive < 0) return;
        var a = H.spawnLive, b = H.spawnCache;
        f[a] = q[0]; f[a + 1] = q[1]; f[a + 2] = q[2]; f[a + 3] = q[3];
        if (b >= 0) { f[b] = q[0]; f[b + 1] = q[1]; f[b + 2] = q[2]; f[b + 3] = q[3]; }
    }
    function writeRigQ(q) { var f = heap32(); if (!f || H.rig < 0) return; f[H.rig] = q[0]; f[H.rig + 1] = q[1]; f[H.rig + 2] = q[2]; f[H.rig + 3] = q[3]; }
    // The roll of the course as actually built: every block record carries the roll at its start (a0) and end (a1); a
    // twisted block is a helicoid between them, so the frame is linear within a block and continuous across blocks.
    function sectionIndexAt(s) {      // index of the block record the ball is on (the course as actually built)
        var secs = track.sections, k = -1;
        for (var i = 0; i < secs.length; i++) { if (s < secs[i].s0) break; k = i; }
        return k;
    }
    function sectionAt(s) { var k = sectionIndexAt(s); return k >= 0 ? track.sections[k] : null; }
    function sectionRollAt(s) {
        var secs = track.sections, k = sectionIndexAt(s); if (k < 0) return 0;
        var a = secs[k];
        if (s >= a.s1) { if (k + 1 < secs.length && secs[k + 1].s0 > a.s1) { var b = secs[k + 1]; return a.a1 + (b.a0 - a.a1) * Math.min(1, (s - a.s1) / (b.s0 - a.s1)); } return a.a1; }
        return a.a0 + (a.a1 - a.a0) * (s - a.s0) / (a.s1 - a.s0);
    }
    function rollAt(s) { return track ? sectionRollAt(s) : 0; }
    function keyEvent(type, key, code) {
        var e = new KeyboardEvent(type, { key: key, code: key, bubbles: true, cancelable: true });
        try { Object.defineProperty(e, "keyCode", { get: function () { return code; } }); Object.defineProperty(e, "which", { get: function () { return code; } }); } catch (x) {}
        document.dispatchEvent(e); var c = document.querySelector("canvas"); if (c) c.dispatchEvent(e);
    }
    function stepAutopilot(sb, fr) {   // debug/test: lateral error from the lane's centre line; optionally hold left/right
        var sec = sectionAt(sb), want = null;
        autoErr = null; autoPred = null;
        if (sec && sec.lat !== undefined) { var err = vdot(ballPos, fr.xh) - sec.lat, vLat = vdot(ballVel, fr.xh), pred = err + vLat * 0.25; autoErr = +err.toFixed(2); autoPred = +pred.toFixed(2); want = pred > 0.3 ? "ArrowLeft" : pred < -0.3 ? "ArrowRight" : null; }
        if (!autopilot) return;
        if (want === autoKey) return;
        if (autoKey) keyEvent("keyup", autoKey, autoKey === "ArrowLeft" ? 37 : 39);
        if (want) keyEvent("keydown", want, want === "ArrowLeft" ? 37 : 39);
        autoKey = want;
    }
    function rollingAt(s) { var sec = sectionAt(s); return sec && sec.a1 !== sec.a0 ? sec : null; }
    // A roll is a job: from s0 on, the next `blocks` lane blocks are helicoids of RATE in direction dir, one block at a
    // time as the spawner gets to them; the roll of the course after them stays. Jobs run in order.
    function planNextLap(sEnd) {              // called when a run has finished spawning: decide the roll of the next one
        var mode = gravityMode, step = 0, at = 0;
        if (sEnd < track.lastPlanS + 20) return;   // the spawner idling where it already planned (start of a run)
        track.lastPlanS = sEnd; track.laps++;
        if (twistQueue.length) { step = twistQueue.shift(); at = TWIST_AT; }
        else if (mode === "twists" || (mode === "both" && Math.random() < 0.5)) {
            if (Math.random() < 0.7) { step = Math.random() < 0.5 ? -90 : 90; at = TWIST_AT; }
        } else if (mode === "curves" || mode === "both") {
            step = (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 120); at = CURVE_AT;
        }
        if (!step) return;
        var blocks = Math.max(1, Math.round(Math.abs(step) / RATE_DEG)), dir = step > 0 ? 1 : -1;
        track.jobs.push({ s0: sEnd + at, dir: dir, blocks: blocks }); trackDebug.twists++;
        note("lap " + track.laps + ": roll " + (dir * blocks * RATE_DEG) + " over " + blocks + " blocks from s " + Math.round(sEnd + at));
    }
    function nextBlockDir(s) {               // twist direction for a block starting at s: the oldest unfinished job, once reached
        for (var i = 0; i < track.jobs.length; i++) { var j = track.jobs[i]; if (j.blocks > 0) return s >= j.s0 ? j.dir : 0; }
        return 0;
    }
    function consumeBlock() { for (var i = 0; i < track.jobs.length; i++) { if (track.jobs[i].blocks > 0) { track.jobs[i].blocks--; return; } } }
    function watchSpawner() {
        var sp = spawnPos(); if (!sp) return;
        var gamePos = vsub(sp, track.dApplied);                  // where the game itself has put the spawn point
        if (!track.lastSpawn) {
            track.lastSpawn = gamePos;
            if (vlen(gamePos) > 1) { track.moving = true; track.stillFrames = 7; }   // already built: treat as a chain at rest
            return;
        }
        var sNow = vdot(gamePos, FWD0), sPrev = vdot(track.lastSpawn, FWD0);
        if (vlen(vsub(gamePos, track.lastSpawn)) > 0.05) {
            // the game spawned a step (one per frame with the scene patch's delay; a whole run when it is 0) with the
            // prefab and rotation written last frame: a block covers the BLOCK_LEN ahead of the new spawn point
            track.moving = true; track.stillFrames = 0;
            if (sNow > sPrev) {
                // only a step that spawned a block from ModBlock can be a helicoid; a rigid piece (tilted lane, thin lanes, dogleg,
                // jump) keeps the roll it was spawned at, so the roll does not advance across it
                var laneStep = fsmFloat("ModMark") > 0.5, a1 = laneStep ? track.wroteA1 : track.wroteA0, fx = frameAxes(track.wroteA0).xh;   // ModMark: the step spawned a block from ModBlock (scene patch)
                track.sections.push({ s0: sNow, s1: sNow + BLOCK_LEN, a0: track.wroteA0, a1: a1, lat: vdot(gamePos, fx) + LANE_HALF * fx[0] });   // lane centre = game spawn line + 5 along world x, along the block's lateral axis
                track.roll = a1; if (laneStep && track.wroteDir) consumeBlock();
            }
            spawnTrace.push([frameNo, +sNow.toFixed(1), +gamePos[0].toFixed(1), +(track.wroteA0 * 180 / Math.PI).toFixed(1), +(track.wroteA1 * 180 / Math.PI).toFixed(1), +(sNow - sPrev).toFixed(0)]); if (spawnTrace.length > 400) spawnTrace.shift();
        }
        else if (track.moving && ++track.stillFrames >= 8) { track.moving = false; planNextLap(sNow); }   // a run just finished: the jump block sits here
        track.lastSpawn = gamePos;
        // whatever spawns next starts where the last block ended: its start roll goes to the spawn transform (every piece
        // copies it) and to ModQ1, its prefab (flat, or a helicoid of +-RATE) to ModBlock, and the spawn point is moved
        // sideways so the lane's centre line stays where the game's own spawn line + 5 puts it
        var a0 = track.roll, dir = nextBlockDir(sNow + BLOCK_LEN), a1 = a0 + dir * RATE, fr = frameAxes(a0);
        writeSpawnRot(spawnQ(a0)); writeQuatVar("ModQ1", spawnQ(a0)); writeBlockChoice(dir);
        track.wroteA0 = a0; track.wroteA1 = a1; track.wroteDir = dir;
        var d = v3(vsub(fr.xh, [1, 0, 0]), -LANE_HALF), dd = vsub(d, track.dApplied);
        if (vlen(dd) > 1e-4) { shiftSpawnBy(dd); track.dApplied = d; }
    }

    function writeQuatVar(name, q) {       // FsmQuaternion variable objects: value (4 floats) at +24, like FsmFloat's
        var f = heap32(), objs = H.vars[name]; if (!f || !objs) return;
        for (var i = 0; i < objs.length; i++) { var a = (objs[i] + 24) >> 2; f[a] = q[0]; f[a + 1] = q[1]; f[a + 2] = q[2]; f[a + 3] = q[3]; }
    }
    function followCamera(frame) {
        var f = heap32(), objects = H.vars.ModCameraOffset;
        if (!f || !varKlass.vec3 || !objects || !objects.length || !(H.vars.ModQCamera && H.vars.ModQCamera.length)) return;
        var offset = qrot(frame, CAMERA_OFFSET);
        objects.forEach(function (a) { var i = (a + 24) >> 2; f[i] = offset[0]; f[i + 1] = offset[1]; f[i + 2] = offset[2]; });
        writeQuatVar("ModQCamera", qmul(frame, CAMERA_ROTATION));
        if (!cameraFollowing || fsmFloat("ModCameraTick") < 0.5) setState("CameraDummy/Main Camera", "Mod follow roll");
        writeFloatVar("ModCameraTick", 0); cameraFollowing = true;
    }
    function writeFloatVar(name, v) { var f = heap32(), objs = H.vars[name]; if (!f || !objs) return; for (var i = 0; i < objs.length; i++) f[(objs[i] + 24) >> 2] = v; }
    function readGoVar(name) { var u = heapU32(), objs = H.vars[name]; return u && objs && objs.length ? u[(objs[0] + 24) >> 2] : 0; }   // FsmGameObject value: a reference at +24
    function writeGoVar(name, ptr) { var u = heapU32(), objs = H.vars[name]; if (!u || !objs || !ptr) return; for (var i = 0; i < objs.length; i++) u[(objs[i] + 24) >> 2] = ptr; }
    var blockPtr = null;                   // the three block prefabs' object pointers, read once from ModBlockFlat / ModBlockP / ModBlockN
    function writeBlockChoice(dir) {       // the prefab the spawner's next lane block comes from: flat, or a helicoid of +RATE / -RATE
        if (!blockPtr) {
            var p0 = readGoVar("ModBlockFlat"), p1 = readGoVar("ModBlockP"), p2 = readGoVar("ModBlockN");
            if (!(p0 && p1 && p2 && readGoVar("ModBlock") === p0)) return;   // not discovered yet, or not the layout we expect
            blockPtr = { "0": p0, "1": p1, "-1": p2 }; note("block prefabs: flat " + p0 + " P " + p1 + " N " + p2);
        }
        writeGoVar("ModBlock", blockPtr[String(dir)]);
    }
    function setSectionDelay(v) {
        var f = heap32(), objs = H.vars.ModSectionDelay; if (!f || !objs || !objs.length) return;
        for (var i = 0; i < objs.length; i++) f[(objs[i] + 24) >> 2] = v;
        sectionDelayWritten = v;
    }
    function stepTrack(playing) {
        if (!trackReady()) return;
        var nowT = performance.now(); if (lastFrameT) frameDt = frameDt * 0.9 + Math.min(0.1, (nowT - lastFrameT) / 1000) * 0.1; lastFrameT = nowT;
        // one spawn step per mod frame while a track mode runs (the spawner's step states wait on ModGo, which the mod
        // sets after writing the next block's prefab and roll; the state clears it), the vanilla one-frame burst otherwise
        var perFrame = gravityMode !== "off" && gameRunning && !build && !restartSeq && (sectionDelayOverride === null || sectionDelayOverride > 0);
        writeFloatVar("ModHold", perFrame ? 1000 : 0);               // every spawner step re-arms its Wait from this: 0 = burst, 1000 s = hold
        setSectionDelay(0);                                          // ...and the mod releases one step per frame (the step re-arms before any further update)
        if (playing) resolveRig();
        if (gravityMode === "off" || !playing || !track) {
            if (playing && cameraFollowing) followCamera([0, 0, 0, 1]);
            if (gravWritten) writeGravity(0, G0, 0);
            if (autopilot && playing && gravityMode === "off") { trackBall(); if (ballPos) { var wantS = ballPos[0] > 5.6 ? "ArrowLeft" : ballPos[0] < 4.4 ? "ArrowRight" : null; if (wantS !== autoKey) { if (autoKey) keyEvent("keyup", autoKey, autoKey === "ArrowLeft" ? 37 : 39); if (wantS) keyEvent("keydown", wantS, wantS === "ArrowLeft" ? 37 : 39); autoKey = wantS; } } }   // test: straight-lane autopilot
            if (track && gravityMode === "off") { writeSpawnRot(spawnQ(0)); writeQuatVar("ModQ1", spawnQ(0)); writeBlockChoice(0); writeRigQ([0, 0, 0, 1]); parkKillZone(false); if (vlen(track.dApplied) > 0) { shiftSpawnBy(v3(track.dApplied, -1)); track.dApplied = [0, 0, 0]; } }
            return;
        }
        trackBall(); watchSpawner();
        if (H.spawnLive < 0) return;                                       // not until the live spawn record has shown itself
        parkKillZone(true);                                                // the kill box is a child of the spawner and would rotate into the lane
        if (!ballPos || H.rig < 0) return;
        var sb = vdot(ballPos, FWD0), th = sectionRollAt(sb), fr = frameAxes(th);
        stepAutopilot(sb, fr);
        // fell off: moving fast along the frame's "down" for a while (the kill box is parked)
        if (-vdot(ballVel, fr.n) > 70) { if (++track.fallFrames > 45 && !restartSeq && !build) { note("free fall at s=" + sb.toFixed(0) + ", restarting"); requestRestart(true); return; } } else track.fallFrames = 0;
        // --- force compensation: the game pushes along world y / z / x; the frame rotates those axes
        var zf = fsmFloat("zforce"), yf = fsmFloat("yforce"), sL = fsmFloat("SteerForceLeft"), sR = fsmFloat("SteerForceRight");
        var steer = (keysHeld.left ? sL : 0) + (keysHeld.right ? sR : 0);
        var g = v3(fr.yh, G0);                                             // gravity itself, rotated into the frame
        g = vadd(g, v3(vsub(fr.zh, [0, 0, 1]), zf / BALL_MASS));
        g = vadd(g, v3(vsub(fr.yh, [0, 1, 0]), yf / BALL_MASS));
        g = vadd(g, v3(vsub(fr.xh, [1, 0, 0]), steer / BALL_MASS));
        writeGravity(g[0], g[1], g[2]);
        // Native transform actions mark the camera dirty and run after physics.
        // Raw writes into the rig's stale local record never rolled the rendered view.
        track.camQ = fr.R.slice();
        followCamera(fr.R);
        var deg = Math.round(rollAt(sb) * 180 / Math.PI), rolling = rollingAt(sb);
        var label = rolling ? "rolling " + deg + "°" : (deg % 360 === 0 ? "" : deg + "°");
        if (gravBadge && gravBadge.textContent !== label) { gravBadge.textContent = label; gravBadge.classList.toggle("on", !!label); }
    }
    // The fall-out kill box hangs under the spawner; with the spawner rolled it would cut through the lane.
    // While a track mode runs it is parked far below (the free-fall watchdog restarts the run instead).
    function parkKillZone(park) {
        var f = heap32(); if (!f) return;
        if (H.kill < 0) return;                                            // found by discoverHeap (-2: not there)
        f[H.kill + 1] = park ? -5000 : -5.15;
    }

    function setGravityMode(m) {
        if (GRAVITY_MODES.indexOf(m) < 0) m = "off";
        gravityMode = m; lsSet(KEY_GRAVITY, m); refreshStackNote();
        if (m === "off") { writeGravity(0, G0, 0); writeSpawnRot(spawnQ(0)); writeQuatVar("ModQ1", spawnQ(0)); writeBlockChoice(0); writeRigQ([0, 0, 0, 1]); parkKillZone(false); if (gravBadge) { gravBadge.textContent = ""; gravBadge.classList.remove("on"); } }
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
    ["keydown", "keypress", "keyup"].forEach(function (type) {
        window.addEventListener(type, function (e) {
            var t = e.target;
            if (!t || !t.closest || !t.closest("#hud, #edit-panel")) return;
            // Returning focus to the closed menu button must still allow play.
            if (t.id === "mod-menu-button" && !(modMenu && modMenu.open) && /^(ArrowLeft|ArrowRight|[aAdDqQrRfFvVlL])$/.test(e.key)) return;
            e.stopImmediatePropagation();
            if (type !== "keydown") return;
            // The shield also stops events reaching target/document listeners, so handle
            // editor shortcuts here before returning control to the browser.
            if (t.closest("#edit-panel")) {
                if (e.key === "Escape") { e.preventDefault(); closePanel(); }
                else if (e.key === "Enter" && t === passBox) { e.preventDefault(); unlock(); }
                else if (e.key === "Enter" && t === editBox && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!editSend.disabled) submitEdit(); }
            } else if (e.key === "Escape" && modMenu && modMenu.open) { e.preventDefault(); modMenu.close(); }
            else if (e.key === "Escape" || (e.key === "Enter" && t.tagName !== "BUTTON" && t.type !== "checkbox")) { e.preventDefault(); t.blur(); }
        }, true);
    });

    var game = null;
    var hud, timerEl, fsBtn, stackInput, musicSel, gravSel, modMenu;
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
            if (modMenu && modMenu.open) return;
            if (ae && hud.contains(ae) && ae.tagName !== "BUTTON") return;   // keep it visible while choosing
            hud.classList.add("hidden");
        }, 2500);
    }

    // Render distance: how many speed-up sections (laps) of track are built ahead. The game builds one more lap each time
    // the ball passes a speed-up arch ("Check score" on the spawner), so building N-1 extra laps once at the start of a
    // run keeps N laps ahead for the rest of it. 1 = the normal game. The extras go one at a time, once the spawner is idle.
    var KEY_VIEW = "slope-mod.viewDist", VIEW_MAX = 10;
    var viewDist = (function () { var n = parseInt(lsGet(KEY_VIEW), 10); return (n >= 1 && n <= VIEW_MAX) ? n : 1; })();
    var aheadRun = -1, aheadLeft = 0, aheadLast = 0, aheadPrimed = false;
    function stepAhead() {
        if (!gameRunning || build || restartSeq) return;
        if (aheadRun !== lastRestart) { aheadRun = lastRestart; aheadLeft = viewDist - 1; aheadLast = frameNo + 60; }   // a new run: let its first section spawn before adding more
        if (aheadLeft <= 0 || frameNo - aheadLast < 10) return;
        if (gravityMode !== "off" && !(track && !track.moving)) return;                                               // a shaped track spawns block by block: wait until the spawner is idle
        if (!aheadPrimed) { if (setState(SPAWNER, "Offset Buildings to Match Spawner")) { aheadPrimed = true; aheadLast = frameNo - 7; } return; }   // line the building chunk up with the spawner first, so the scenery lands beside the new lap and not on it
        if (setState(SPAWNER, "Check score")) { aheadLeft--; aheadLast = frameNo; aheadPrimed = false; }
    }
    function setViewDist(n) {
        n = parseInt(n, 10);
        if (!(n >= 1)) n = 1;
        if (n > VIEW_MAX) n = VIEW_MAX;
        if (gameRunning && aheadRun === lastRestart) aheadLeft = Math.max(0, aheadLeft + n - viewDist);   // raised mid-run: build the difference
        viewDist = n; lsSet(KEY_VIEW, n);
        var rng = document.getElementById("hud-view"), val = document.getElementById("hud-view-val");
        if (rng && String(rng.value) !== String(n)) rng.value = n;
        if (val) val.textContent = n;
    }

    function setStackTarget(n) {
        n = parseInt(n, 10);
        if (!(n >= 1)) n = 1;
        if (n > STACK_MAX) n = STACK_MAX;
        stackTarget = n;                                // applies at the next run, restart or R
        lsSet(KEY_STACK, n);
        if (stackInput && String(stackInput.value) !== String(n)) stackInput.value = n;
        refreshStackNote();
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
    // 5. Dev mode: type "devmode" to open a password-locked box that sends a request
    //    to the slope-edit service (edit-server/), which runs Claude Code on a
    //    sandboxed clone and publishes the change for everyone.
    // ======================================================================
    var EDIT_API = (window.SLOPE_EDIT_API || "").replace(/\/+$/, "");
    var MAGIC = "devmode";
    var typed = "";
    var panel = null, editBox = null, editSend = null, editStatus = null, editLog = null, editBudget = null, passRow = null, passBox = null, passBtn = null, editRow = null;
    var editJob = null, editPoll = null;
    var DEV_TOKEN_KEY = "slope-dev.token";
    function devToken() { try { return sessionStorage.getItem(DEV_TOKEN_KEY) || ""; } catch (e) { return ""; } }
    function setDevToken(t) { try { if (t) sessionStorage.setItem(DEV_TOKEN_KEY, t); else sessionStorage.removeItem(DEV_TOKEN_KEY); } catch (e) {} }

    function api(pathname, opts) {
        if (!EDIT_API) return Promise.reject(new Error("Dev mode is not connected on this page."));
        opts = Object.assign({ cache: "no-store" }, opts || {});
        var h = Object.assign({}, opts.headers || {}); var t = devToken(); if (t) h["Authorization"] = "Bearer " + t; opts.headers = h;
        return fetch(EDIT_API + pathname, opts).then(function (r) {
            return r.json().then(function (j) {
                if (r.status === 401) { setDevToken(""); showLocked(); }
                if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j;
            });
        });
    }
    function fmtTok(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : String(n); }
    function refreshBudget() {
        if (!editBudget) return;
        api("/api/status").then(function (st) {
            if (st.locked) { showLocked(); return; }
            var b = st.budget;
            editBudget.textContent = "Today " + fmtTok(b.dayTokens) + (b.dayTokenCap ? " / " + fmtTok(b.dayTokenCap) : "") + " tokens" + (b.dayTokenCap ? "" : " (no daily cap)") + (b.dayUsd ? " · $" + b.dayUsd.toFixed(2) : "") +
                (st.queue ? " · " + st.queue + " waiting" : "") + (st.running ? " · one running" : "");
            showUnlocked();
        }).catch(function (e) { editBudget.textContent = e.message; });
    }
    function showLocked() { if (!panel) return; passRow.style.display = ""; editRow.style.display = "none"; editBox.style.display = "none"; editLog.style.display = "none"; editStatus.textContent = ""; setTimeout(function () { passBox.focus(); }, 50); }
    function showUnlocked() { if (!panel) return; passRow.style.display = "none"; editRow.style.display = ""; editBox.style.display = ""; editLog.style.display = ""; }
    function buildPanel() {
        if (panel) return panel;
        panel = document.createElement("div");
        panel.id = "edit-panel";
        panel.className = "edit-panel";
        panel.innerHTML =
            '<div class="edit-head"><span class="edit-title">Dev mode · edit this game with Claude Code</span>' +
            '<button type="button" class="edit-close" title="Close (Esc)">×</button></div>' +
            '<p class="edit-hint">Describe a change to the page (visuals, styles, HUD, rules…). Claude Code edits the game files in a sandbox on the owner\'s server, the result is checked, the current version is frozen in the Version list, and the new one is published for everyone.</p>' +
            '<div class="edit-row edit-pass"><input type="password" class="edit-passbox" placeholder="dev-mode password" autocomplete="off"><button type="button" class="edit-unlock hud-btn">Unlock</button></div>' +
            '<textarea class="edit-box" rows="3" maxlength="1200" placeholder="e.g. make the ball leave a short glowing trail"></textarea>' +
            '<div class="edit-row edit-send-row"><button type="button" class="edit-send hud-btn">Send to Claude</button><span class="edit-status"></span></div>' +
            '<pre class="edit-log"></pre>' +
            '<div class="edit-budget"></div>';
        document.body.appendChild(panel);
        editBox = panel.querySelector(".edit-box"); editSend = panel.querySelector(".edit-send"); editRow = panel.querySelector(".edit-send-row");
        editStatus = panel.querySelector(".edit-status"); editLog = panel.querySelector(".edit-log"); editBudget = panel.querySelector(".edit-budget");
        passRow = panel.querySelector(".edit-pass"); passBox = panel.querySelector(".edit-passbox"); passBtn = panel.querySelector(".edit-unlock");
        panel.querySelector(".edit-close").addEventListener("click", closePanel);
        editSend.addEventListener("click", submitEdit);
        passBtn.addEventListener("click", unlock);
        return panel;
    }
    function unlock() {
        var pw = passBox.value || ""; if (!pw) return;
        passBtn.disabled = true; editStatus.textContent = "Checking…";
        api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) })
            .then(function (r) { setDevToken(r.token); passBox.value = ""; editStatus.textContent = ""; showUnlocked(); refreshBudget(); setTimeout(function () { editBox.focus(); }, 50); })
            .catch(function (e) { editStatus.textContent = e.message; })
            .then(function () { passBtn.disabled = false; });
    }
    function openPanel() {
        buildPanel(); panel.classList.add("open"); showHud();
        if (!EDIT_API) { editStatus.textContent = "Dev mode is not connected on this page (no SLOPE_EDIT_API)."; editSend.disabled = true; passBtn.disabled = true; return; }
        if (devToken()) refreshBudget(); else showLocked();
    }
    function closePanel() { if (panel) panel.classList.remove("open"); if (editBox) editBox.blur(); if (passBox) passBox.blur(); }
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
            else if (job.state === "done") { editStatus.textContent = "Published " + (job.commit || "") + " (" + fmtTok(job.tokens) + " tokens" + (job.version ? ", previous version kept as " + job.version : "") + "). Live in about a minute; reload to see it."; if (job.summary) setLog(job.log.concat(["", job.summary])); }
            else if (job.state === "answered") editStatus.textContent = "Answered, nothing changed (" + fmtTok(job.tokens) + " tokens).";
            else if (job.state === "failed") { editStatus.textContent = "Not applied."; if (job.summary) setLog(job.log.concat(["", job.summary])); }
            if (job.state === "done" || job.state === "answered" || job.state === "failed") { editSend.disabled = false; refreshBudget(); return; }
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
        stats: function () { return { builds: builds, resetsSent: resetsSent, deaths: deaths, restarts: restarts, stuckRestarts: stuckRestarts, building: !!build, restarting: !!restartSeq, running: gameRunning, phase: build ? build.phase : restartSeq ? restartSeq.phase : null, frame: frameNo, worstGap: Math.round(worstGap), worstGapFrame: worstGapFrame, bigGaps: bigGaps.slice(), music: musicId, shaders: window.SlopeShaders ? SlopeShaders.stats() : null }; },
        setStack: setStackTarget,
        setLaps: function (n) { LAPS_PER_COURSE = n; },
        setMusic: setMusic,
        music: function () { return musicId; },
        mort: function () { return mortEnabled; },
        julien: function () { return julienEnabled; },
        setMort: setMort,
        setJulien: setJulien,
        setGravity: setGravityMode,
        setTwistQueue: function (q) { twistQueue = q.slice(); },   // degrees per upcoming lap, 0 = straight
        setLaneHalf: function (v) { LANE_HALF = +v; },               // debug/test
        setSectionDelay: function (v) { sectionDelayOverride = v; },   // debug/test (null = automatic)
        key: function (type, k) { keyEvent(type, k, k === "ArrowLeft" ? 37 : 39); },   // debug/test
        setAutopilot: function (on) { autopilot = !!on; if (!on && autoKey) { keyEvent("keyup", autoKey, autoKey === "ArrowLeft" ? 37 : 39); autoKey = null; } },
        frameDt: function () { return frameDt; },
        pause: function (on) { setPaused(on === undefined ? !paused : on); return paused; },
        paused: function () { return paused; },
        speed: function () { return Math.sqrt(ballVel[0] * ballVel[0] + ballVel[1] * ballVel[1] + ballVel[2] * ballVel[2]); },
        score: function () { var u = heapU32(), objs = H.vars.Score || []; if (!u || !objs.length) return null; var best = 0; for (var i = 0; i < objs.length; i++) { var v = u[(objs[i] + 24) >> 2] | 0; if (v > best) best = v; } return best; },
        addScore: function (n) {               // the game's own score counter (FsmInt "Score"): coins count like lane blocks
            var u = heapU32(), objs = H.vars.Score || []; if (!u || !objs.length || !gameRunning) return 0;
            for (var i = 0; i < objs.length; i++) { var k = (objs[i] + 24) >> 2; u[k] = Math.max(0, (u[k] | 0) + (n | 0)); }
            return objs.length;
        },   // units/s, for speed-driven styles (shaders.js)
        spawnTrace: function () { return spawnTrace.slice(); },
        profileScans: function () { var r = {}, t; t = performance.now(); findTriple(0, G0, 0); r.triple = Math.round(performance.now() - t); t = performance.now(); nearSeqMulti([[[PITCH_SX, 0, 0, PITCH_CX], 3e-4], [[0, 0, 0, 1, 5, 6.482, -4.737, 1, 1, 1], 2e-3], [[0.43559, 0, 0, 0.90015, 0, 3.056, -1.207, 1, 1, 1], 3e-4]]); r.near3 = Math.round(performance.now() - t); t = performance.now(); nearSeq([PITCH_SX, 0, 0, PITCH_CX], 3e-4); r.near1 = Math.round(performance.now() - t); t = performance.now(); ["zforce", "yforce", "SteerForceLeft", "SteerForceRight", "ModSectionDelay"].forEach(findStringObjects); r.strings5 = Math.round(performance.now() - t); t = performance.now(); findFsmFloatsMulti(["zforce", "yforce", "SteerForceLeft", "SteerForceRight", "ModSectionDelay"]); r.multi = Math.round(performance.now() - t); return r; },
        fsmGet: function (name) { var f = heap32(); return varObjects(name, findFsmFloats(name)).map(function (a) { return [a, f[(a + 24) >> 2]]; }); },
        fsmGetInt: function (name) { var u = heapU32(); return varObjects(name, findFsmFloats(name)).map(function (a) { return [a, u[(a + 24) >> 2] | 0]; }); },
        fsmSet: function (name, v) { var f = heap32(), objs = varObjects(name, findFsmFloats(name)); objs.forEach(function (a) { f[(a + 24) >> 2] = v; }); return objs.length; },
        setTwistParams: function (o) { if (o.at) TWIST_AT = o.at; },   // debug/test
        roll: function () { return track && ballPos ? +(rollAt(vdot(ballPos, FWD0)) * 180 / Math.PI).toFixed(1) : null; },
        track: function () { var f = heap32(); return { mode: gravityMode, heap: { grav: H.grav.length, spawn: H.spawn.length, spawnLive: H.spawnLive, spawnCache: H.spawnCache, rigCands: H.rigCands ? H.rigCands.length : -1, rig: H.rig, chase: H.chase, ball: H.ball, vars: Object.keys(H.vars).map(function (k) { return k + ":" + H.vars[k].length; }) }, pos: ballPos, vel: ballVel.map(function (v) { return +v.toFixed(1); }), s: ballPos ? +vdot(ballPos, FWD0).toFixed(1) : null, sections: track ? track.sections.length : 0, latErr: autoErr, latPred: autoPred, jobs: track ? track.jobs.map(function (j) { return [Math.round(j.s0), j.dir, j.blocks]; }) : null, hold: fsmFloat("ModHold"), delay: fsmFloat("ModSectionDelay"), running: gameRunning, build: !!build, restarting: !!restartSeq, roll: track ? +(track.roll * 180 / Math.PI).toFixed(1) : null, blockPtr: blockPtr, secHead: track ? track.sections.slice(0, 4).map(function (x) { return [Math.round(x.s0), +(x.a0 * 180 / Math.PI).toFixed(1), +(x.a1 * 180 / Math.PI).toFixed(1)]; }) : null, secTail: track ? track.sections.slice(-3).map(function (x) { return [Math.round(x.s0), +(x.a0 * 180 / Math.PI).toFixed(1), +(x.a1 * 180 / Math.PI).toFixed(1)]; }) : null, camQ: track ? track.camQ.map(function (v) { return +v.toFixed(2); }) : null, kill: H.kill, laps: track ? track.laps : 0, spawnPos: spawnPos(), spawnQ: (function () { var f = heap32(); return f && H.spawnLive >= 0 ? [f[H.spawnLive], f[H.spawnLive + 1], f[H.spawnLive + 2], f[H.spawnLive + 3]].map(function (v) { return +v.toFixed(3); }) : null; })(), dApplied: track ? track.dApplied.map(function (v) { return +v.toFixed(2); }) : null, rigPos: rigPos(), zforce: fsmFloat("zforce"), yforce: fsmFloat("yforce"), steer: [fsmFloat("SteerForceLeft"), fsmFloat("SteerForceRight")], grav: f && H.grav.length ? [f[H.grav[0]], f[H.grav[0] + 1], f[H.grav[0] + 2]].map(function (v) { return +v.toFixed(2); }) : null, keys: keysHeld }; },
        audio: function () { var a = audioEl; return a ? { paused: a.paused, time: a.currentTime, ready: a.readyState, src: a.src.split("/").pop(), error: a.error && a.error.code } : null; },
        restart: function () { if (game) requestRestart(false); },
        drawCounts: function () { return lastDraws.slice(); },   // test: index/vertex counts of the last frame's draw calls
        heapVars: function () { return H.vars; },   // test: the variable objects per FSM variable name
        varKlass: function () { return varKlass; },
        openEditor: openPanel,
        init: function (gameInstance) {
            game = gameInstance;
            hud = document.getElementById("hud");
            modMenu = document.getElementById("mod-menu");
            var menuButton = document.getElementById("mod-menu-button");
            if (modMenu && menuButton) {
                menuButton.addEventListener("click", function () { keyEvent("keyup", "ArrowLeft", 37); keyEvent("keyup", "ArrowRight", 39); modMenu.showModal(); menuButton.setAttribute("aria-expanded", "true"); showHud(); });
                document.getElementById("mod-menu-close").addEventListener("click", function () { modMenu.close(); });
                modMenu.addEventListener("close", function () { if (modMenu.open) return; menuButton.setAttribute("aria-expanded", "false"); menuButton.focus(); showHud(); });
                modMenu.addEventListener("click", function (e) { if (e.target === modMenu) { var r = modMenu.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modMenu.close(); } });
            }
            [["hud-mort", mortEnabled, setMort], ["hud-julien", julienEnabled, setJulien]].forEach(function (item) {
                var el = document.getElementById(item[0]); if (!el) return;
                el.checked = item[1]; el.addEventListener("change", function () { item[2](el.checked); });
            });
            timerEl = document.getElementById("hud-timer");
            fsBtn = document.getElementById("hud-fs");
            stackInput = document.getElementById("hud-stack");
            musicSel = document.getElementById("hud-music");
            gravSel = document.getElementById("hud-gravity");
            gravBadge = document.getElementById("hud-gravity-badge");
            if (gravSel) {
                gravSel.value = gravityMode;
                gravSel.addEventListener("change", function () { setGravityMode(gravSel.value); gravSel.blur(); });
                gravSel.addEventListener("focus", showHud);
                gravSel.addEventListener("blur", showHud);
            }

            var viewRange = document.getElementById("hud-view");
            if (viewRange) {
                viewRange.value = viewDist; var viewVal = document.getElementById("hud-view-val"); if (viewVal) viewVal.textContent = viewDist;
                viewRange.addEventListener("input", function () { setViewDist(viewRange.value); });
                viewRange.addEventListener("change", function () { viewRange.blur(); });
            }
            if (stackInput) {
                stackInput.value = stackTarget; refreshStackNote();
                stackInput.addEventListener("input", function () { setStackTarget(stackInput.value); });
                stackInput.addEventListener("change", function () { setStackTarget(stackInput.value); stackInput.blur(); });
                stackInput.addEventListener("focus", showHud);
                stackInput.addEventListener("blur", showHud);
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
                if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA" || (ae.closest && ae.closest("#edit-panel")))) return;
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.key === "f" || e.key === "F") toggleFullscreen();
                else if (e.key === "r" || e.key === "R") { if (paused) setPaused(false); requestRestart(false); }
                else if (e.key === "t" || e.key === "T") setPaused(!paused);
            });
            window.addEventListener("blur", function () { /* keep the player's choice: no auto-resume, no auto-pause */ });
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
