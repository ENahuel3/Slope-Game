/* Keep Unity's drawing buffer within a frame budget while leaving the page/HUD at
 * native size. This Unity build obtains its render size through canvas.clientWidth
 * and clientHeight on each update; its CSS size and input bounds stay unchanged.
 * Loaded after shaders.js. Full resolution is an explicit, persistent opt-out.
 */
(function () {
    'use strict';
    var KEY = 'slope-mod.quality', PIXELS = 1200000, MIN_SCALE = 0.5;
    function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
    var mode = read() === 'native' ? 'native' : 'auto';
    var canvas = null, renderScale = 1, scale = 1, ceiling = 1, changes = 0, last = 0, sum = 0, samples = 0, slow = 0, stableSince = 0, changedAt = 0;
    var widthGet, heightGet;
    var intervals = new Float32Array(300), intervalCount = 0, intervalAt = 0, renderAt = 0, reportedAt = 0;
    var pacing = { fps: 0, low1Fps: 0, p99Ms: 0 };
    function record(t) {
        if (document.hidden || (window.SlopeMod && SlopeMod.paused())) { renderAt = 0; return; }
        if (renderAt && t > renderAt) { intervals[intervalAt] = t - renderAt; intervalAt = (intervalAt + 1) % intervals.length; intervalCount = Math.min(intervalCount + 1, intervals.length); }
        renderAt = t;
        if (!intervalCount || t - reportedAt < 1000) return;
        reportedAt = t;
        var list = Array.prototype.slice.call(intervals, 0, intervalCount).sort(function (a, b) { return a - b; });
        var total = 0, tail = 0, n = Math.max(1, Math.ceil(list.length * 0.01));
        for (var i = 0; i < list.length; i++) { total += list[i]; if (i >= list.length - n) tail += list[i]; }
        pacing = { fps: 1000 * list.length / total, low1Fps: 1000 * n / tail, p99Ms: list[Math.ceil(list.length * 0.99) - 1] };
    }
    function getter(name) {
        var proto = HTMLCanvasElement.prototype;
        while (proto) { var d = Object.getOwnPropertyDescriptor(proto, name); if (d && d.get) return d.get; proto = Object.getPrototypeOf(proto); }
    }
    function playing() { return !!(window.SlopeMod && SlopeMod.isPlaying && SlopeMod.isPlaying()); }
    function reset() { last = sum = samples = slow = 0; stableSince = 0; }
    function resize() {
        if (!canvas) return;
        var w = widthGet.call(canvas), h = heightGet.call(canvas);
        ceiling = Math.max(MIN_SCALE, Math.min(1, Math.sqrt(PIXELS / Math.max(1, w * h))));
        scale = mode === 'native' ? 1 : Math.min(scale, ceiling);
        renderScale = mode === 'auto' && playing() ? scale : 1;
        reset();
    }
    function attach(target) {
        if (!target || canvas) return;
        widthGet = getter('clientWidth'); heightGet = getter('clientHeight');
        if (!widthGet || !heightGet) return;
        canvas = target;
        Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: function () { return Math.max(1, Math.round(widthGet.call(this) * renderScale)); } });
        Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: function () { return Math.max(1, Math.round(heightGet.call(this) * renderScale)); } });
        resize();
        if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    }
    function setMode(value) {
        if (value !== 'auto' && value !== 'native') return false;
        mode = value; scale = mode === 'native' ? 1 : ceiling; renderScale = mode === 'auto' && playing() ? scale : 1; reset();
        try { localStorage.setItem(KEY, mode); } catch (e) { /* storage blocked */ }
        var select = document.getElementById('hud-quality'); if (select) select.value = mode;
        return true;
    }
    function scene(info) {
        var timestamp = info && typeof info.timestamp === 'number' ? info.timestamp : performance.now(); record(timestamp);
        if (!canvas || mode !== 'auto') return;
        // Keep Unity's legacy menu coordinates and the DOM leaderboard at native
        // resolution; adapt only while the ball is live.
        if (!playing()) { renderScale = 1; reset(); return; }
        renderScale = scale;
        var t = timestamp, dt = last ? t - last : 0; last = t;
        if (document.hidden || (window.SlopeMod && SlopeMod.paused()) || dt > 250) { reset(); return; }
        if (dt <= 0) return;
        sum += dt; samples++; if (dt > 22) slow++;
        if (samples < 30) return;
        var mean = sum / samples, overloaded = mean > 19 && slow >= 4;
        sum = samples = slow = 0;
        if (overloaded) {
            stableSince = 0;
            if (t - changedAt > 1500 && scale > MIN_SCALE + 0.01) {
                scale = Math.max(MIN_SCALE, scale * 0.85); renderScale = scale; changes++; changedAt = t; last = 0;
            }
        } else if (mean < 17.5) {
            if (!stableSince) stableSince = t;
            // Recover slowly and only within the pixel ceiling; avoid resize oscillation.
            if (t - stableSince > 12000 && t - changedAt > 12000 && scale < ceiling - 0.01) {
                scale = Math.min(ceiling, scale / 0.9); renderScale = scale; changes++; changedAt = t; stableSince = 0; last = 0;
            }
        } else stableSince = 0;
    }
    if (window.SlopeShaders) SlopeShaders.onScene(scene);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function () { reset(); renderAt = 0; });
    function wire() {
        var select = document.getElementById('hud-quality');
        if (select) { select.value = mode; select.addEventListener('change', function () { setMode(select.value); select.blur(); }); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
    window.SlopePerformance = { attach: attach, setMode: setMode, stats: function () {
        return { fps: +pacing.fps.toFixed(1), low1Fps: +pacing.low1Fps.toFixed(1), p99Ms: +pacing.p99Ms.toFixed(1), mode: mode, scale: +renderScale.toFixed(3), targetScale: +scale.toFixed(3), ceiling: +ceiling.toFixed(3), changes: changes,
            width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 };
    } };
})();
