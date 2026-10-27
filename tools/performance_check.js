/* Deterministic checks for resolution control, CSS size independence and pacing.
 * node tools/performance_check.js
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = 10000, scene, hidden = false, paused = false, playing = true, display = [1920, 1200];
class Canvas { get clientWidth() { return display[0]; } get clientHeight() { return display[1]; } }
const canvas = new Canvas(); canvas.width = 1920; canvas.height = 1200;
const storage = new Map(), listeners = {};
const ctx = { performance: { now: () => now }, HTMLCanvasElement: Canvas,
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) },
    document: { readyState: 'loading', get hidden() { return hidden; }, addEventListener: (e,f) => { listeners[e] = f; }, getElementById: () => null },
    SlopeMod: { isPlaying: () => playing, paused: () => paused }, SlopeShaders: { onScene: f => { scene = f; } },
    addEventListener: (e,f) => { listeners[e] = f; } };
ctx.window = ctx;
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../TemplateData/performance.js'),'utf8'), ctx);
const api = ctx.SlopePerformance;
api.attach(canvas);
assert(canvas.clientWidth > 1300 && canvas.clientWidth < 1500);
assert.equal(canvas.clientWidth / canvas.clientHeight > 1.59, true);
const start = api.stats().scale;
for(let i=0;i<100;i++) { now+=33.3; scene(); }
assert(api.stats().scale < start, 'sustained slow frames lower resolution');
for(let i=0;i<400;i++) { now+=33.3; scene(); }
assert.equal(api.stats().scale, .5, 'minimum resolution enforced');
assert.equal(api.setMode('native'), true);
assert.equal(canvas.clientWidth,1920); assert.equal(canvas.clientHeight,1200);
for(let i=0;i<200;i++) { now+=50; scene(); }
assert.equal(api.stats().scale,1,'full resolution is an opt-out');
api.setMode('auto');
const before = api.stats().scale;
for(let i=0;i<50;i++) { now+=16.67; scene(); }
now+=5000;scene();
for(let i=0;i<50;i++) { now+=16.67;scene(); }
assert.equal(api.stats().scale,before,'isolated suspension never lowers quality');
hidden=true;
for(let i=0;i<100;i++) { now+=100; scene(); }
hidden=false; paused=true;
for(let i=0;i<100;i++) { now+=100; scene(); }
paused=false;
assert.equal(api.stats().scale,before,'hidden/paused frames ignored');
for(let i=0;i<100;i++) { now+=33.3;scene(); }
assert(api.stats().scale<before);
for(let i=0;i<2000;i++) { now+=16.67;scene(); }
assert(api.stats().scale<=api.stats().ceiling,'recovery respects pixel budget');
display=[800,500];listeners.resize();
assert.equal(api.setMode('auto'),true);
assert.equal(canvas.clientWidth,800);assert.equal(canvas.clientHeight,500);
assert.equal(api.setMode('bogus'),false);
assert.equal(storage.get('slope-mod.quality'),'auto');
assert(api.stats().fps>58 && api.stats().fps<61,'diagnostics measure actual scene cadence');
assert(api.stats().low1Fps>58 && api.stats().low1Fps<61,'1% low uses rendered intervals');
display=[1920,1200];listeners.resize();playing=false;now+=17;scene();
assert.equal(canvas.clientWidth,1920,'menus keep native coordinates');
playing=true;now+=17;scene();
assert(canvas.clientWidth<1500,'live play reapplies render budget');
let stamp=now;
for(let i=0;i<600;i++) { stamp+=1000/60; now=stamp+(i%2)*8;scene({timestamp:stamp}); }
assert(api.stats().low1Fps>59.5,'CPU submission phase jitter is not a missed rendered frame');
console.log('PASS automatic resolution budget, aspect, bounds, opt-out, suspension, pause, recovery and resize');
