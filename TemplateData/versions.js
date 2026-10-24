/* Slope mod: version picker. The page at the site root is the latest version; older releases are complete
   copies under versions/<tag>/ (made by tools/snapshot_version.py) that share the unchanged engine files and
   music with the root. versions/index.json lists them. This file is copied into every snapshot, so an old
   version can always get back to the latest one, and a broken latest version never takes the old ones down. */
(function () {
    var m = location.pathname.match(/\/versions\/([^\/]+)\/(?:index\.html)?$/);
    var tag = m ? decodeURIComponent(m[1]) : "latest", root = m ? "../../" : "./";
    function go(t) { location.href = root + (t === "latest" ? "" : "versions/" + encodeURIComponent(t) + "/"); }
    function build(man) {
        var sel = document.createElement("select"); sel.id = "hud-version"; sel.className = "hud-input hud-select"; sel.title = "Play another version of the mod. Older versions keep working if the latest one breaks.";
        function opt(value, text) { var o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); }
        var L = man.latest || {}; opt("latest", "Latest" + (L.title ? " – " + L.title : "") + (L.date ? " (" + L.date + ")" : ""));
        (man.versions || []).slice().sort(function (a, b) { return (b.date || "") < (a.date || "") ? -1 : 1; }).forEach(function (v) { opt(v.tag, v.tag + (v.title ? " – " + v.title : "") + (v.date ? " (" + v.date + ")" : "")); });
        sel.value = tag; if (sel.value !== tag) { opt(tag, tag + " (unlisted)"); sel.value = tag; }
        sel.addEventListener("change", function () { if (sel.value !== tag) go(sel.value); });
        var label = document.createElement("label"); label.className = "hud-label"; label.htmlFor = "hud-version"; label.textContent = "Version";
        var hud = document.getElementById("hud"), spacer = hud && hud.querySelector(".hud-spacer");
        var options = document.getElementById("mod-options");
        if (options) { options.appendChild(label); options.appendChild(sel); }
        else if (spacer) { var sep = document.createElement("span"); sep.className = "hud-sep"; hud.insertBefore(sep, spacer); hud.insertBefore(label, spacer); hud.insertBefore(sel, spacer); }
        else { var box = document.createElement("div"); box.className = "version-box"; box.appendChild(label); box.appendChild(sel); document.body.appendChild(box); }
        if (tag !== "latest") {
            var note = document.createElement("div"); note.className = "version-note";
            var cur = (man.versions || []).filter(function (v) { return v.tag === tag; })[0];
            note.textContent = "Playing " + tag + (cur && cur.date ? " from " + cur.date : "") + ". ";
            var a = document.createElement("a"); a.href = root; a.textContent = "Back to the latest version"; note.appendChild(a);
            document.body.appendChild(note);
        }
    }
    function start() {
        fetch(root + "versions/index.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }).then(build).catch(function () {});
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
