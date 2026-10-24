/* Deterministic checks for restart signals and the real stuck-watch function.
 * Run: node tools/restart_check.js [path/to/mod.js]
 * Unity/clock/heap reads are stubbed so delayed frames and duplicate audio
 * notifications are reproducible without relying on random courses.
 */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '../TemplateData/mod.js'), 'utf8');
const watch = source.slice(source.indexOf('    var stuck = '), source.indexOf('    function examineFrame('));
const examine = source.slice(source.indexOf('    function examineFrame('), source.indexOf('    // Background pillars follow the music:'));
let failures = 0;
function check(name, fn) {
    try { fn(); console.log('PASS ' + name); }
    catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); }
}
function expect(value, want) { if (value !== want) throw new Error(JSON.stringify({got: value, want})); }
function watcher() {
    const c = vm.createContext({now: 5000, frameNo: 1000, lastRestart: 0, lastRestartAt: 0,
        gameRunning: true, build: null, restartSeq: null, gravityMode: 'off',
        ballPos: [5, -20, 12], stuckRestarts: 0, restarts: 0, document: {hidden: false},
        stackWanted: () => 3, trackBall() {}, note() {}, vdot: (a,b) => a.reduce((s,v,i)=>s+v*b[i],0),
        FWD0: [0, -Math.SQRT1_2, Math.SQRT1_2]});
    c.performance = {now: () => c.now}; c.requestRestart = () => { c.restarts++; };
    vm.runInContext(watch, c);
    c.step = (ms, pos) => { c.now = ms; c.frameNo++; if (pos) c.ballPos = pos; vm.runInContext('stepStuckWatch()', c); };
    return c;
}
check('background/frame gap is not a stuck ball', () => {
    const c = watcher(); c.step(5000); c.step(5500); c.step(8500);
    expect(c.restarts, 0);
});
check('startup grace uses seconds even at high frame rates', () => {
    const c = watcher();
    for (let t=0; t<=3000; t+=100) c.step(t);
    expect(c.restarts, 0);
});
check('hidden page cannot trigger a stuck restart', () => {
    const c = watcher(); c.step(5000); c.document.hidden = true;
    for (let t=5100; t<=7000; t+=100) c.step(t);
    expect(c.restarts, 0);
});
check('a genuinely jammed run still restarts', () => {
    const c = watcher();
    for (let t=5000; t<=6700; t+=100) c.step(t);
    expect(c.restarts, 1);
});
check('sideways steering does not hide a jam', () => {
    const c = watcher();
    for (let t=5000; t<=6700; t+=100) c.step(t, [5+(t-5000)/1000,-20,12]);
    expect(c.restarts, 1);
});
check('a moving ball keeps going', () => {
    const c = watcher();
    for (let t=5000; t<=8000; t+=100) c.step(t, [5,-20-(t-5000)/100,12+(t-5000)/100]);
    expect(c.restarts, 0);
});
function runSignals() {
    const c = vm.createContext({frameNo: 1000, lastRestart: 0, lastRestartAt: 0, gameRunning: false,
        musicStarted: false, musicStopped: false, lastCourseCount: 0, COURSE_BATCH: 5190,
        RESTART_GRACE: 15, restartSeq: null, build: null, builds: 0, deaths: 0,
        gravityMode: 'off', performance: {now: () => 10000},
        resetTrackRun() {}, stepRestart() {}, stepBuild() {}, stepStuckWatch() {},
        stackWanted: () => 3, setState() {}, requestRestart() {}});
    c.startBuild = () => {c.builds++; c.build = {};};
    vm.runInContext(examine, c);
    c.start = () => {c.musicStarted = true; vm.runInContext('examineFrame([])',c);};
    return c;
}
check('late/duplicate music-start notifications do not rebuild a live stack', () => {
    const c=runSignals(); c.start(); expect(c.builds,1); c.build=null;
    for(let i=0;i<3;i++) {c.frameNo+=100; c.start(); c.build=null;}
    expect(c.builds,1);
});
check('a new run after a real death still builds a stack', () => {
    const c=runSignals(); c.start(); c.build=null; c.frameNo+=100;
    c.musicStopped=true; vm.runInContext('examineFrame([])',c); expect(c.gameRunning,false);
    c.start(); expect(c.builds,2);
});
process.exitCode = failures ? 1 : 0;
