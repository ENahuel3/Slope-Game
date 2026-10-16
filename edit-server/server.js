#!/usr/bin/env node
/* slope-edit: lets visitors of the modded Slope page ask Claude Code to change
 * the mod, from a sandboxed clone, within a spend budget, and publishes the
 * result by pushing to the `mod` branch (GitHub Pages redeploys it).
 *
 * No dependencies. Configuration via environment variables (see README.md).
 * Layers of containment, outermost first:
 *   1. systemd unit: unprivileged user, ProtectSystem=strict, only DATA_DIR writable
 *   2. Claude Code permissions (claude-settings.json): Read/Glob/Grep/Edit/Write
 *      only inside the clone, no Bash / network tools, headless => anything else is denied
 *   3. post-run validation: only allow-listed files changed, JS parses, no new
 *      external URLs; otherwise the clone is reset and nothing is published
 *   4. budget ledger: per-run cap (--max-budget-usd), daily and monthly caps,
 *      per-visitor rate limit, one job at a time
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const CFG = {
    port: +env("SLOPE_EDIT_PORT", 8787),
    host: env("SLOPE_EDIT_HOST", "127.0.0.1"),
    dataDir: env("SLOPE_EDIT_DATA", path.resolve(__dirname, "../data")),   // ledger + logs
    repoDir: env("SLOPE_EDIT_REPO", path.resolve(__dirname, "../repo")),   // sandboxed clone of the game
    branch: env("SLOPE_EDIT_BRANCH", "mod"),
    remote: env("SLOPE_EDIT_REMOTE", "origin"),
    claudeBin: env("SLOPE_EDIT_CLAUDE", "claude"),
    claudeConfigDir: env("SLOPE_EDIT_CLAUDE_CONFIG", ""),                   // CLAUDE_CONFIG_DIR for the sandbox user
    settingsFile: env("SLOPE_EDIT_SETTINGS", path.join(__dirname, "claude-settings.json")),
    model: env("SLOPE_EDIT_MODEL", "claude-sonnet-5-5"),
    perJobUsd: +env("SLOPE_EDIT_JOB_USD", 0.75),
    dailyUsd: +env("SLOPE_EDIT_DAILY_USD", 3),
    monthlyUsd: +env("SLOPE_EDIT_MONTHLY_USD", 20),
    jobTimeoutMs: +env("SLOPE_EDIT_TIMEOUT_MS", 6 * 60 * 1000),
    perIpPerHour: +env("SLOPE_EDIT_IP_PER_HOUR", 6),
    maxQueue: +env("SLOPE_EDIT_MAX_QUEUE", 6),
    maxPrompt: +env("SLOPE_EDIT_MAX_PROMPT", 700),
    allowOrigins: env("SLOPE_EDIT_ORIGINS", "https://enahuel3.github.io,http://127.0.0.1:8765,http://localhost:8765").split(",").map(s => s.trim()).filter(Boolean),
    editable: env("SLOPE_EDIT_FILES", "TemplateData/mod.js,TemplateData/mod.css").split(",").map(s => s.trim()).filter(Boolean),
    urlAllow: env("SLOPE_EDIT_URL_ALLOW", "github.io,githubusercontent.com,cdnjs.cloudflare.com,fonts.googleapis.com,fonts.gstatic.com,unpkg.com,cdn.jsdelivr.net,id.net,y8.com,unity3d.com,doubleclick.net,googlesyndication.com,google-analytics.com").split(",").map(s => s.trim()).filter(Boolean),
    push: env("SLOPE_EDIT_PUSH", "1") !== "0",
    authorName: env("SLOPE_EDIT_AUTHOR", "Slope community editor"),
    authorEmail: env("SLOPE_EDIT_EMAIL", "slope-edit@users.noreply.github.com"),
};

fs.mkdirSync(CFG.dataDir, { recursive: true });
const LEDGER = path.join(CFG.dataDir, "ledger.json");
const JOBLOG = path.join(CFG.dataDir, "jobs.log");

// ---------------------------------------------------------------- ledger
function loadLedger() {
    try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch (e) { return { days: {}, months: {}, recent: [] }; }
}
function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }
const dayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
function budget() {
    const l = loadLedger();
    const dayUsed = l.days[dayKey()] || 0, monthUsed = l.months[monthKey()] || 0;
    return { dayUsed, dayCap: CFG.dailyUsd, monthUsed, monthCap: CFG.monthlyUsd, perJob: CFG.perJobUsd,
             dayLeft: Math.max(0, CFG.dailyUsd - dayUsed), monthLeft: Math.max(0, CFG.monthlyUsd - monthUsed) };
}
function charge(usd, job) {
    const l = loadLedger();
    l.days[dayKey()] = (l.days[dayKey()] || 0) + usd;
    l.months[monthKey()] = (l.months[monthKey()] || 0) + usd;
    l.recent.unshift({ id: job.id, at: job.finishedAt, prompt: job.prompt.slice(0, 120), state: job.state, cost: +usd.toFixed(4), commit: job.commit || null });
    l.recent = l.recent.slice(0, 40);
    saveLedger(l);
}
function logLine(s) { fs.appendFileSync(JOBLOG, new Date().toISOString() + " " + s + "\n"); }

// ---------------------------------------------------------------- git helpers
function git(args, opts) {
    const r = spawnSync("git", args, { cwd: CFG.repoDir, encoding: "utf8", timeout: 120000, ...opts });
    if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + (r.stderr || r.stdout || r.error));
    return r.stdout.trim();
}
function syncRepo() {
    git(["fetch", "--quiet", CFG.remote, CFG.branch]);
    git(["checkout", "--quiet", "-B", CFG.branch, CFG.remote + "/" + CFG.branch]);
    git(["reset", "--quiet", "--hard", CFG.remote + "/" + CFG.branch]);
    git(["clean", "--quiet", "-fd"]);
}
function changedFiles() {
    const out = git(["status", "--porcelain", "--untracked-files=all"]);
    return out ? out.split("\n").map(l => l.slice(3).trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------- validation
const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;
function validate(job) {
    const files = changedFiles();
    if (!files.length) return "Claude made no changes to the game files.";
    const bad = files.filter(f => !CFG.editable.includes(f));
    if (bad.length) return "The edit touched files outside the allowed set (" + bad.join(", ") + "), so it was discarded.";
    for (const f of files) {
        const p = path.join(CFG.repoDir, f);
        if (!fs.existsSync(p)) return f + " was deleted; discarded.";
        const size = fs.statSync(p).size;
        if (size > 512 * 1024) return f + " grew past 512 KB; discarded.";
        if (f.endsWith(".js")) {
            const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
            if (r.status !== 0) return "The new " + f + " does not parse:\n" + (r.stderr || "").split("\n").slice(0, 6).join("\n");
        }
    }
    // no new external URLs outside the allow-list (keeps visitors safe from redirects / exfiltration)
    const diff = git(["diff", "--unified=0"]);
    const added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
    for (const line of added) {
        let m;
        while ((m = URL_RE.exec(line)) !== null) {
            const host = m[1].toLowerCase();
            if (!CFG.urlAllow.some(a => host === a || host.endsWith("." + a))) return "The edit added a link to " + host + ", which is not allowed; discarded.";
        }
        if (/<script[\s>]/i.test(line) || /document\.cookie|\.credentials|password/i.test(line)) return "The edit added something that looks unsafe (script tag / credentials access); discarded.";
    }
    return null;
}

// ---------------------------------------------------------------- claude runner
const SYSTEM_RULES = `You are editing a small browser game mod on behalf of an anonymous visitor who typed a request into the game's page. Rules:
- You may only change TemplateData/mod.js and TemplateData/mod.css. Read index.html and README.md for context if useful, but never modify them or anything else.
- Keep the game working: the page must still load and play. Do not remove the network shim, the fullscreen/HUD basics, or the SlopeMod init/onGameReady entry points. Prefer small, well-contained changes; add new features as new functions.
- Do not add external scripts, iframes, fetches to other sites, links, tracking, cookies, or anything that reads or sends visitor data. Do not add offensive, hateful, sexual or deceptive content. If the request asks for any of that, or for something outside this game, make no changes and explain why in one sentence.
- You cannot run the game or any commands: reason carefully, keep JavaScript syntactically valid, and finish within a few edits.
- When done, reply with one or two plain sentences describing what you changed (this is shown to the visitor).`;

function runClaude(job, onEvent) {
    return new Promise((resolve) => {
        const args = ["-p", job.prompt, "--output-format", "stream-json", "--verbose",
                      "--permission-mode", "default",
                      "--allowedTools", "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write",
                      "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit", "KillShell", "BashOutput",
                      "--max-budget-usd", String(CFG.perJobUsd),
                      "--no-session-persistence",
                      "--append-system-prompt", SYSTEM_RULES];
        if (CFG.model) args.push("--model", CFG.model);
        if (fs.existsSync(CFG.settingsFile)) args.push("--settings", CFG.settingsFile);
        const childEnv = { ...process.env };
        if (CFG.claudeConfigDir) childEnv.CLAUDE_CONFIG_DIR = CFG.claudeConfigDir;
        childEnv.CI = "1"; childEnv.DISABLE_AUTOUPDATER = "1"; childEnv.DISABLE_TELEMETRY = "1";
        const child = spawn(CFG.claudeBin, args, { cwd: CFG.repoDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
        let buf = "", result = null, stderr = "";
        const timer = setTimeout(() => { onEvent("Time limit reached, stopping."); try { child.kill("SIGKILL"); } catch (e) {} }, CFG.jobTimeoutMs);
        child.stdout.on("data", d => {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line) continue;
                let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
                if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
                    for (const c of ev.message.content) {
                        if (c.type === "text" && c.text.trim()) onEvent(c.text.trim().slice(0, 600));
                        else if (c.type === "tool_use") {
                            const inp = c.input || {}; const f = inp.file_path ? path.relative(CFG.repoDir, inp.file_path) : (inp.pattern || inp.path || "");
                            onEvent("→ " + c.name + (f ? " " + f : ""));
                        }
                    }
                } else if (ev.type === "result") {
                    result = ev;
                }
            }
        });
        child.stderr.on("data", d => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, result, stderr }); });
        child.on("error", e => { clearTimeout(timer); resolve({ code: -1, result: null, stderr: String(e) }); });
    });
}

// ---------------------------------------------------------------- jobs
const jobs = new Map();          // id -> job
const queue = [];                // ids
let running = null;
const ipHits = new Map();        // ip -> [timestamps]

function newJob(prompt, ip) {
    const id = crypto.randomBytes(6).toString("hex");
    const job = { id, prompt, ip, state: "queued", createdAt: Date.now(), startedAt: null, finishedAt: null, log: [], cost: 0, commit: null, summary: null, error: null };
    jobs.set(id, job); queue.push(id);
    setImmediate(pump);
    return job;
}
function position(job) { const i = queue.indexOf(job.id); return i < 0 ? 0 : i + 1; }

async function pump() {
    if (running || !queue.length) return;
    const job = jobs.get(queue.shift()); running = job;
    job.state = "running"; job.startedAt = Date.now();
    const say = s => { job.log.push(s); if (job.log.length > 60) job.log.shift(); };
    try {
        const b = budget();
        if (b.dayLeft < CFG.perJobUsd || b.monthLeft < CFG.perJobUsd) throw new Error("The editing budget for today is used up. It resets at midnight UTC.");
        say("Syncing the game files…"); syncRepo();
        say("Asking Claude…");
        const { code, result, stderr } = await runClaude(job, say);
        const cost = result && typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
        job.cost = cost;
        if (!result) throw new Error("Claude did not finish (exit " + code + ")" + (stderr ? ": " + stderr.split("\n").filter(Boolean).slice(-2).join(" ") : ""));
        job.summary = (result.result || "").toString().slice(0, 800);
        if (result.is_error) throw new Error("Claude reported an error: " + job.summary);
        const problem = validate(job);
        if (problem) throw new Error(problem);
        const files = changedFiles();
        say("Validated: " + files.join(", "));
        git(["add", "--", ...files]);
        const title = job.prompt.replace(/\s+/g, " ").slice(0, 60);
        git(["-c", "user.name=" + CFG.authorName, "-c", "user.email=" + CFG.authorEmail, "commit", "--quiet", "-m",
             "Community edit: " + title + "\n\nRequest: " + job.prompt + "\n\nMade by Claude Code through the in-game editor (cost $" + cost.toFixed(3) + ")."]);
        job.commit = git(["rev-parse", "--short", "HEAD"]);
        if (CFG.push) { say("Publishing…"); git(["push", "--quiet", CFG.remote, "HEAD:" + CFG.branch]); say("Pushed " + job.commit + ". GitHub Pages serves it in about a minute; reload to see it."); }
        else say("Committed " + job.commit + " (push disabled).");
        job.state = "done";
    } catch (e) {
        job.error = String(e.message || e).slice(0, 1200);
        job.state = "failed";
        say("✗ " + job.error);
        try { git(["reset", "--quiet", "--hard"]); git(["clean", "--quiet", "-fd"]); } catch (e2) { /* ignore */ }
    } finally {
        job.finishedAt = Date.now();
        charge(job.cost || 0, job);
        logLine(job.id + " " + job.state + " $" + (job.cost || 0).toFixed(4) + " " + (job.commit || "-") + " ip=" + job.ip + " :: " + job.prompt.replace(/\s+/g, " ").slice(0, 200) + (job.error ? " :: " + job.error.replace(/\s+/g, " ").slice(0, 200) : ""));
        running = null;
        setImmediate(pump);
    }
}

function publicJob(job) {
    return { id: job.id, state: job.state, position: position(job), prompt: job.prompt, log: job.log, cost: +(job.cost || 0).toFixed(4),
             commit: job.commit, summary: job.summary, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt };
}

// ---------------------------------------------------------------- http
function send(res, code, body, origin) {
    const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (origin) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"; h["Access-Control-Allow-Headers"] = "Content-Type"; }
    res.writeHead(code, h); res.end(JSON.stringify(body));
}
function clientIp(req) {
    const xf = req.headers["x-forwarded-for"];
    return (xf ? String(xf).split(",")[0].trim() : req.socket.remoteAddress) || "?";
}
const server = http.createServer((req, res) => {
    const origin = req.headers.origin && CFG.allowOrigins.includes(req.headers.origin) ? req.headers.origin : (CFG.allowOrigins.includes("*") ? "*" : null);
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") { send(res, 204, {}, origin); return; }
    if (url.pathname === "/api/status" && req.method === "GET") {
        const l = loadLedger();
        send(res, 200, { ok: true, budget: budget(), queue: queue.length, running: !!running, recent: l.recent.slice(0, 10), editable: CFG.editable, model: CFG.model }, origin);
        return;
    }
    let m = url.pathname.match(/^\/api\/job\/([a-f0-9]{12})$/);
    if (m && req.method === "GET") {
        const job = jobs.get(m[1]);
        if (!job) { send(res, 404, { error: "unknown job" }, origin); return; }
        send(res, 200, publicJob(job), origin); return;
    }
    if (url.pathname === "/api/edit" && req.method === "POST") {
        let body = "";
        req.on("data", d => { body += d; if (body.length > 10000) req.destroy(); });
        req.on("end", () => {
            let prompt = "";
            try { prompt = String(JSON.parse(body).prompt || ""); } catch (e) { send(res, 400, { error: "bad json" }, origin); return; }
            prompt = prompt.replace(/\r/g, "").trim();
            if (prompt.length < 4) { send(res, 400, { error: "Say what you want changed." }, origin); return; }
            if (prompt.length > CFG.maxPrompt) { send(res, 400, { error: "Keep it under " + CFG.maxPrompt + " characters." }, origin); return; }
            const ip = clientIp(req), now = Date.now();
            const hits = (ipHits.get(ip) || []).filter(t => now - t < 3600e3);
            if (hits.length >= CFG.perIpPerHour) { send(res, 429, { error: "You have used your " + CFG.perIpPerHour + " edits for this hour." }, origin); return; }
            if (queue.length >= CFG.maxQueue) { send(res, 429, { error: "The queue is full; try again in a few minutes." }, origin); return; }
            const b = budget();
            if (b.dayLeft < CFG.perJobUsd || b.monthLeft < CFG.perJobUsd) { send(res, 429, { error: "The editing budget for today is used up. It resets at midnight UTC." }, origin); return; }
            hits.push(now); ipHits.set(ip, hits);
            const job = newJob(prompt, ip);
            send(res, 202, publicJob(job), origin);
        });
        return;
    }
    send(res, 404, { error: "not found" }, origin);
});

// sanity at startup
try { git(["rev-parse", "--is-inside-work-tree"]); } catch (e) { console.error("SLOPE_EDIT_REPO is not a git clone: " + CFG.repoDir); process.exit(1); }
server.listen(CFG.port, CFG.host, () => {
    console.log("slope-edit listening on http://" + CFG.host + ":" + CFG.port + " repo=" + CFG.repoDir + " model=" + CFG.model +
                " caps: $" + CFG.perJobUsd + "/job $" + CFG.dailyUsd + "/day $" + CFG.monthlyUsd + "/month push=" + CFG.push);
});
