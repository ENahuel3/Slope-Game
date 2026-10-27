/* Deterministic ramp rendering regression: node tools/ramp_batch_check.js [ramps.js].
 * A fake GL records geometry and submission counts without needing a Unity run.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '../TemplateData/ramps.js'), 'utf8');
for (const vaoMode of ['gl2', 'oes', null]) {
    let scene, frames = [], uploads = [], draws = [], failUpload = false;
    const context = {
        console, Float32Array, performance: { now: () => 1 },
        localStorage: { getItem: () => null, setItem() {} },
        document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
        SlopeShaders: { onScene(fn) { scene = fn; } },
        SlopeCoins: { frames: () => frames, ballPos: () => [0, 0, 0], camera: () => new Float32Array(16), underTunnel: () => false, muteBlock() {} }
    };
    context.window = context;
    vm.runInNewContext(source, context);
    const api = context.SlopeRamps;
    api.params.every = 1;
    const gl = { COMPILE_STATUS: 1, LINK_STATUS: 2 };
    const g = new Proxy({
        getShaderParameter: () => true, getProgramParameter: () => true,
        createVertexArray: () => ({}), createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
        getParameter: () => 0, getVertexAttrib: () => 0, getVertexAttribOffset: () => 0, isEnabled: () => false,
        bufferData(target, data) { if (failUpload) throw Error('upload failed'); uploads.push(Array.from(data)); },
        drawArrays(mode, start, count) { draws.push(count); }
    }, { get: (obj, key) => obj[key] || (() => {}) });
    const h = { g, gl, vaoMode, vaoExt: { createVertexArrayOES: () => ({}), bindVertexArrayOES() {} } };
    function frame(key, s) {
        return { key, lane: true, kind: 'slope', org: [0, -s * Math.SQRT1_2, s * Math.SQRT1_2],
            right: [1, 0, 0], fwd: [0, -Math.SQRT1_2, Math.SQRT1_2], up: [0, Math.SQRT1_2, Math.SQRT1_2] };
    }
    frames = [frame('a', 200), frame('b', 400)];
    scene(h);
    assert.equal(api.stats().drawn, 2);
    assert.equal(uploads.length, 1, 'one initial upload');
    assert.equal(draws.length, 1, 'one draw for multiple ramps');
    assert.equal(draws[0], uploads[0].length / 6);
    const initial = uploads[0];
    for (let i = 0; i < 120; i++) scene(h);
    assert.equal(uploads.length, 1, 'stationary ramps never re-upload');
    assert.equal(draws.length, 121);
    frames = [frames[1]];
    scene(h);
    assert.deepEqual(uploads[1], initial.slice(initial.length / 2), 'despawn preserves remaining geometry');
    frames.push(frame('c', 600));
    scene(h);
    assert.equal(api.stats().drawn, 2);
    assert.equal(uploads.length, 3, 'new ramp invalidates buffer');
    frames = [];
    scene(h);
    assert.equal(draws.length, 123, 'empty scene skips rendering');
    api.setEnabled(false); scene(h);
    api.setEnabled(true); frames = [frame('d', 800)]; scene(h);
    assert.equal(uploads.length, 4, 'toggle rebuilds geometry');
    assert.equal(draws.at(-1), initial.length / 12);
    // A new GL context needs its own buffer even when the geometry is unchanged.
    scene({ ...h, gl: { ...gl } });
    assert.equal(uploads.length, 5, 'new context uploads geometry');
    frames.push(frame('e', 1000)); failUpload = true;
    scene(h);
    failUpload = false; scene(h);
    assert.equal(uploads.length, 6, 'failed uploads retry next frame');
    assert.equal(api.stats().errors, 1);
    console.log('PASS ramp batching, geometry, despawn, toggles, contexts and upload retry: ' + (vaoMode || 'no VAO'));
}
