/* Mirror the GL state that the overlays save/restore. Querying these values in
 * Firefox can synchronize its WebGL command stream with the GPU on every frame.
 * Both Unity and overlay setters pass through these wrappers (loaded first).
 * Unknown/VAO-dependent parameters still use native queries. */
(function () {
    'use strict';
    var hits = 0, misses = 0, contexts = new WeakMap();
    function install(P) {
        if (!P || !Object.prototype.hasOwnProperty.call(P, 'getParameter')) return;
        var get = P.getParameter, enabled = P.isEnabled;
        function state(gl) {
            var s = contexts.get(gl);
            if (!s) {
                s = { values: Object.create(null), caps: Object.create(null), textures: Object.create(null), samplers: Object.create(null) };
                contexts.set(gl, s);
                if (!gl.__slopeStateEvents && gl.canvas && gl.canvas.addEventListener) {
                    gl.__slopeStateEvents = true;
                    gl.canvas.addEventListener('webglcontextlost', function () { gl.__slopeStateLost = true; contexts.delete(gl); });
                    gl.canvas.addEventListener('webglcontextrestored', function () { gl.__slopeStateLost = false; contexts.delete(gl); });
                }
            }
            return s;
        }
        var cached = {};
        [35725, 36006, 36010, 34964, 34016, 2978, 3107, 36007, 35055, 35053,
            34229, 2932, 2930, 2885, 2886, 32969, 32968, 32971, 32970, 37440, 37441].forEach(function (p) { cached[p] = true; });
        function active(gl, s) {
            if (!(34016 in s.values)) s.values[34016] = get.call(gl, 34016);
            return s.values[34016] - 33984;
        }
        function copy(v) { return ArrayBuffer.isView(v) ? new v.constructor(v) : Array.isArray(v) ? v.slice() : v; }
        P.getParameter = function (p) {
            if (this.__slopeStateLost) return get.call(this, p);
            var s = state(this), table = s.values, key = p;
            if (p === 32873 || p === 35097) { table = p === 32873 ? s.textures : s.samplers; key = active(this, s); }
            else if (!cached[p]) return get.call(this, p);
            if (key in table) { hits++; return copy(table[key]); }
            misses++; return copy(table[key] = get.call(this, p));
        };
        P.isEnabled = function (p) {
            if (this.__slopeStateLost) return enabled.call(this, p);
            var caps = state(this).caps;
            if (p in caps) { hits++; return caps[p]; }
            misses++; return (caps[p] = enabled.call(this, p));
        };
        function wrap(name, write) {
            var original = P[name]; if (!original) return;
            P[name] = function () { var result = original.apply(this, arguments); write.call(this, state(this), arguments); return result; };
        }
        function scalar(name, param, index) { wrap(name, function (s, a) { s.values[param] = a[index || 0]; }); }
        scalar('useProgram', 35725); scalar('activeTexture', 34016);
        scalar('bindRenderbuffer', 36007, 1); scalar('bindVertexArray', 34229);
        scalar('depthFunc', 2932); scalar('depthMask', 2930); scalar('cullFace', 2885); scalar('frontFace', 2886);
        wrap('enable', function (s, a) { s.caps[a[0]] = true; });
        wrap('disable', function (s, a) { s.caps[a[0]] = false; });
        wrap('bindBuffer', function (s, a) {
            var p = a[0] === 34962 ? 34964 : a[0] === 35052 ? 35055 : a[0] === 35051 ? 35053 : 0;
            if (p) s.values[p] = a[1];
        });
        wrap('bindFramebuffer', function (s, a) {
            if (a[0] !== 36008) s.values[36006] = a[1];
            if (this.READ_FRAMEBUFFER && a[0] !== 36009) s.values[36010] = a[1];
        });
        wrap('bindTexture', function (s, a) { if (a[0] === 3553) s.textures[active(this, s)] = a[1]; });
        wrap('bindSampler', function (s, a) { s.samplers[a[0]] = a[1]; });
        wrap('pixelStorei', function (s, a) { if (a[0] === 37440 || a[0] === 37441) s.values[a[0]] = !!a[1]; });
        wrap('viewport', function (s, a) {
            var v = s.values[2978] || (s.values[2978] = new Int32Array(4));
            for (var i = 0; i < 4; i++) v[i] = a[i];
        });
        wrap('colorMask', function (s, a) { s.values[3107] = [!!a[0], !!a[1], !!a[2], !!a[3]]; });
        wrap('blendFunc', function (s, a) { s.values[32969] = s.values[32971] = a[0]; s.values[32968] = s.values[32970] = a[1]; });
        wrap('blendFuncSeparate', function (s, a) { s.values[32969] = a[0]; s.values[32968] = a[1]; s.values[32971] = a[2]; s.values[32970] = a[3]; });
        // Deletion can implicitly unbind several objects, including VAO attachments.
        // Invalidate only bindings referring to the deleted object. Clearing the
        // whole mirror here would reintroduce a GPU round trip each time Unity
        // discards an unrelated transient vertex buffer.
        ['deleteBuffer','deleteTexture','deleteFramebuffer','deleteRenderbuffer','deleteProgram','deleteSampler','deleteVertexArray'].forEach(function (name) {
            wrap(name, function (s, a) {
                if (!a[0]) return;
                [s.values, s.textures, s.samplers].forEach(function (table) {
                    Object.keys(table).forEach(function (p) { if (table[p] === a[0]) delete table[p]; });
                });
            });
        });
        // OES VAOs share their binding parameter with WebGL 2, but the setter is
        // on an extension object rather than the context prototype.
        var getExt = P.getExtension;
        P.getExtension = function (name) {
            var ext = getExt.apply(this, arguments), gl = this;
            if (ext && ext.bindVertexArrayOES && !ext.__slopeStateWrapped) {
                ext.__slopeStateWrapped = true;
                var bind = ext.bindVertexArrayOES, del = ext.deleteVertexArrayOES;
                ext.bindVertexArrayOES = function (vao) { bind.call(ext, vao); state(gl).values[34229] = vao; };
                ext.deleteVertexArrayOES = function (vao) { del.call(ext, vao); var s = state(gl); if (s.values[34229] === vao) delete s.values[34229]; };
            }
            return ext;
        };
        audits.push(function (gl) {
            if (!(gl instanceof P.constructor)) return null;
            var s = state(gl), bad = [];
            function equal(a, b) { return a === b || ((ArrayBuffer.isView(a) || Array.isArray(a)) && JSON.stringify(Array.from(a)) === JSON.stringify(Array.from(b))); }
            Object.keys(s.values).forEach(function (p) { if (!equal(s.values[p], get.call(gl, +p))) bad.push(+p); });
            Object.keys(s.caps).forEach(function (p) { if (s.caps[p] !== enabled.call(gl, +p)) bad.push(+p); });
            var unit = get.call(gl, 34016);
            [s.textures, s.samplers].forEach(function (table, kind) {
                Object.keys(table).forEach(function (i) {
                    gl.activeTexture(33984 + (+i));
                    if (!equal(table[i], get.call(gl, kind ? 35097 : 32873))) bad.push((kind ? 'sampler' : 'texture') + i);
                });
            });
            gl.activeTexture(unit);
            return bad;
        });
    }
    var audits = [];
    install(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    install(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    window.SlopeGLState = { stats: function () { return { hits: hits, misses: misses }; }, audit: function (gl) {
        for (var i = audits.length - 1; i >= 0; i--) { var result = audits[i](gl); if (result) return result; }
        return [];
    } };
})();
