/* Mort Jackson theme: put King Julien's PNG on the game's red obstacle textures.
 * Identify only the four shipped red textures by their exact compressed/decoded
 * bytes. Swap a paired GL texture for a draw, then restore Unity's binding so
 * its state cache, collisions, other music, and post-processing stay intact.
 */
(function () {
    'use strict';
    var base = new URL('themes/julien/', document.currentScript.src).href;
    var HASHES = {"2572600127": "polygonRedThin", "2805200293": "polygonRedThin", "1867884713": "polygonRedThin", "3496628545": "borderRed", "381873637": "borderRed", "3769686357": "borderRed"};
    var images = {}, canvases = {}, records = [];
    var counts = { tagged: 0, created: 0, draws: 0, errors: 0 };
    ['king-julien', 'borderRedThin', 'borderRed', 'polygonRed', 'polygonRedThin'].forEach(function (name) {
        var im = new Image(); im.onload = function () { images[name] = im; }; im.src = base + name + '.png';
    });
    function hash(data, offset, length) {
        if (!ArrayBuffer.isView(data)) return null;
        var n = length || data.byteLength - (offset || 0);
        if (!(n > 0) || (offset || 0) + n > data.byteLength) return null;
        var bytes = new Uint8Array(data.buffer, data.byteOffset + (offset || 0), n), h = 2166136261;
        for (var i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
        return String(h);
    }
    function canvas(name) {
        if (canvases[name]) return canvases[name];
        var face = images['king-julien'], red = images[name];
        if (!face || !red) return null;
        var c = document.createElement('canvas'); c.width = c.height = 256;
        var d = c.getContext('2d');
        d.imageSmoothingEnabled = false; d.drawImage(red, 0, 0, 256, 256);
        // Select the head/crown from the original transparent PNG. This is a
        // texture-space decal; the source PNG is kept unchanged and credited.
        var sx = face.width * .14, sy = 0, sw = face.width * .56, sh = face.height * .73;
        var height = 224, width = height * sw / sh;
        d.imageSmoothingEnabled = true;
        d.drawImage(face, sx, sy, sw, sh, (256 - width) / 2, 16, width, height);
        canvases[name] = c; return c;
    }
    function hook(P) {
        if (!P) return;
        var bind = P.bindTexture, active = P.activeTexture, upload = P.texImage2D;
        var subUpload = P.texSubImage2D, subCompressed = P.compressedTexSubImage2D;
        var compressed = P.compressedTexImage2D, create = P.createTexture, param = P.texParameteri;
        var store = P.pixelStorei, get = P.getParameter, bindBuffer = P.bindBuffer;
        function units(ctx) { return ctx.__julienUnits || (ctx.__julienUnits = []); }
        P.activeTexture = function (unit) { this.__julienActive = unit - this.TEXTURE0; return active.apply(this, arguments); };
        P.bindTexture = function (target, tex) {
            if (target === this.TEXTURE_2D) units(this)[this.__julienActive || 0] = tex;
            return bind.apply(this, arguments);
        };
        function remember(ctx, target, level, width, height, data, offset, length) {
            if (target !== ctx.TEXTURE_2D || level !== 0 || width !== 32 || height !== 32) return;
            var tex = units(ctx)[ctx.__julienActive || 0], name = HASHES[hash(data, offset, length)];
            if (tex && name && !tex.__julienName) { tex.__julienName = name; counts.tagged++; records.push(name); }
        }
        P.texImage2D = function () {
            var result = upload.apply(this, arguments);
            if (arguments.length >= 9) remember(this, arguments[0], arguments[1], arguments[3], arguments[4], arguments[8], (arguments[9] || 0) * (arguments[8] && arguments[8].BYTES_PER_ELEMENT || 1));
            return result;
        };
        if (compressed) P.compressedTexImage2D = function () {
            var result = compressed.apply(this, arguments);
            remember(this, arguments[0], arguments[1], arguments[3], arguments[4], arguments[6], arguments[7], arguments[8]);
            return result;
        };
        P.texSubImage2D = function () {
            var result = subUpload.apply(this, arguments);
            if (arguments.length >= 9 && !arguments[2] && !arguments[3]) remember(this, arguments[0], arguments[1], arguments[4], arguments[5], arguments[8], (arguments[9] || 0) * (arguments[8] && arguments[8].BYTES_PER_ELEMENT || 1));
            return result;
        };
        if (subCompressed) P.compressedTexSubImage2D = function () {
            var result = subCompressed.apply(this, arguments);
            if (!arguments[2] && !arguments[3]) remember(this, arguments[0], arguments[1], arguments[4], arguments[5], arguments[7], arguments[8], arguments[9]);
            return result;
        };
        function themed(ctx, original) {
            if (original.__julienTexture) return original.__julienTexture;
            var im = canvas(original.__julienName); if (!im) return null;
            var oldActive = get.call(ctx, ctx.ACTIVE_TEXTURE), oldTex, unpack;
            var flip = get.call(ctx, ctx.UNPACK_FLIP_Y_WEBGL), premultiply = get.call(ctx, ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
            active.call(ctx, ctx.TEXTURE0); oldTex = get.call(ctx, ctx.TEXTURE_BINDING_2D);
            var gl2 = !!ctx.PIXEL_UNPACK_BUFFER;
            if (gl2) { unpack = get.call(ctx, ctx.PIXEL_UNPACK_BUFFER_BINDING); bindBuffer.call(ctx, ctx.PIXEL_UNPACK_BUFFER, null); }
            var tex = create.call(ctx);
            try {
                bind.call(ctx, ctx.TEXTURE_2D, tex);
                store.call(ctx, ctx.UNPACK_FLIP_Y_WEBGL, true); store.call(ctx, ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                upload.call(ctx, ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, im);
                param.call(ctx, ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
                param.call(ctx, ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
                param.call(ctx, ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.REPEAT);
                param.call(ctx, ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.REPEAT);
                original.__julienTexture = tex; counts.created++;
            } finally {
                store.call(ctx, ctx.UNPACK_FLIP_Y_WEBGL, flip); store.call(ctx, ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
                if (gl2) bindBuffer.call(ctx, ctx.PIXEL_UNPACK_BUFFER, unpack);
                bind.call(ctx, ctx.TEXTURE_2D, oldTex); active.call(ctx, oldActive);
            }
            return tex;
        }
        ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements'].forEach(function (method) {
            var draw = P[method]; if (!draw) return;
            P[method] = function () {
                if (!window.SlopeMod || !SlopeMod.julien()) return draw.apply(this, arguments);
                var bound = units(this), changes = [], oldActive = this.TEXTURE0 + (this.__julienActive || 0);
                try {
                    for (var i = 0; i < bound.length; i++) {
                        var original = bound[i]; if (!original || !original.__julienName) continue;
                        var replacement = themed(this, original); if (!replacement) continue;
                        active.call(this, this.TEXTURE0 + i); bind.call(this, this.TEXTURE_2D, replacement);
                        changes.push([i, original]);
                    }
                    active.call(this, oldActive);
                    if (changes.length) counts.draws++;
                    return draw.apply(this, arguments);
                } finally {
                    for (var j = 0; j < changes.length; j++) {
                        active.call(this, this.TEXTURE0 + changes[j][0]); bind.call(this, this.TEXTURE_2D, changes[j][1]);
                    }
                    active.call(this, oldActive);
                }
            };
        });
    }
    hook(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    hook(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    window.SlopeJulien = { stats: function () { return { tagged: counts.tagged, created: counts.created, draws: counts.draws, textures: records.slice(), ready: !!images['king-julien'] }; } };
})();
