#!/usr/bin/env node
/* slope-edit: "dev mode" for the modded Slope page. Someone who knows the dev-mode
 * password can ask Claude Code, running headlessly on this host inside a sandboxed
 * clone of the repository, to change the game page; the result is validated,
 * the version it replaces is frozen under versions/, and the new root is pushed
 * to the `mod` branch (GitHub Pages redeploys it). Git history is the undo button.
 *
 * No dependencies. Configuration via environment variables (see README.md).
 * Layers of containment, outermost first:
 *   1. systemd unit: unprivileged user, ProtectSystem=strict, only its own dirs writable
 *   2. password gate: the page is public, the password is not: only its scrypt hash
 *      lives on this host (env file, root-owned); logins are rate limited
 *   3. Claude Code permissions (claude-settings.json): Read/Glob/Grep/Edit/Write only
 *      on the allow-listed page files inside the clone, no Bash / network / subagents
 *   4. post-run validation: only allow-listed files changed, nothing under versions/,
 *      Build/, tools/, JS parses, no new external URLs, no script tags, API URL kept
 *   5. budget ledger: tokens per day (a share of the account's daily allowance),
 *      tokens per job (the run is stopped when it passes it), USD caps when billed by
 *      API key, per-visitor rate limit, one job at a time, wall-clock limit
 *   6. versions: the root being replaced is frozen as a new version before the push,
 *      existing versions are never modified
 *
 *   node server.js --hash      prints the scrypt hash of a password read from stdin
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
    dataDir: env("SLOPE_EDIT_DATA", path.resolve(__dirname, "../data")),   // ledger, sessions, logs
    repoDir: env("SLOPE_EDIT_REPO", path.resolve(__dirname, "../repo")),   // sandboxed clone of the game
    branch: env("SLOPE_EDIT_BRANCH", "mod"),
    remote: env("SLOPE_EDIT_REMOTE", "origin"),
    claudeBin: env("SLOPE_EDIT_CLAUDE", "claude"),
    claudeConfigDir: env("SLOPE_EDIT_CLAUDE_CONFIG", ""),                   // CLAUDE_CONFIG_DIR for the sandbox user
    settingsFile: env("SLOPE_EDIT_SETTINGS", path.join(__dirname, "claude-settings.json")),
    python: env("SLOPE_EDIT_PYTHON", "python3"),
    model: env("SLOPE_EDIT_MODEL", "claude-sonnet-5-5"),
    // access
    passwordHash: env("SLOPE_EDIT_PASSWORD_HASH", ""),                      // scrypt$<salt b64>$<hash b64>, from `node server.js --hash`
    sessionHours: +env("SLOPE_EDIT_SESSION_HOURS", 12),
    loginPerIp: +env("SLOPE_EDIT_LOGIN_PER_IP", 5),                         // attempts per 15 minutes
    loginGlobal: +env("SLOPE_EDIT_LOGIN_GLOBAL", 40),                       // attempts per hour, all visitors
    // tokens: the account's daily allowance and the share this service may use of it
    dailyTokens: +env("SLOPE_EDIT_DAILY_TOKENS", 1000000),
    share: +env("SLOPE_EDIT_SHARE", 0.10),
    perJobTokens: +env("SLOPE_EDIT_JOB_TOKENS", 80000),
    maxTurns: +env("SLOPE_EDIT_MAX_TURNS", 30),
    // USD caps only matter when billed by API key (OAuth logins report 0)
    perJobUsd: +env("SLOPE_EDIT_JOB_USD", 1.5),
    dailyUsd: +env("SLOPE_EDIT_DAILY_USD", 5),
    monthlyUsd: +env("SLOPE_EDIT_MONTHLY_USD", 40),
    jobTimeoutMs: +env("SLOPE_EDIT_TIMEOUT_MS", 8 * 60 * 1000),
    perIpPerHour: +env("SLOPE_EDIT_IP_PER_HOUR", 6),
    maxQueue: +env("SLOPE_EDIT_MAX_QUEUE", 6),
    maxPrompt: +env("SLOPE_EDIT_MAX_PROMPT", 1200),
    allowOrigins: env("SLOPE_EDIT_ORIGINS", "https://enahuel3.github.io,http://127.0.0.1:8765,http://localhost:8765").split(",").map(s => s.trim()).filter(Boolean),
    editable: env("SLOPE_EDIT_FILES", "index.html,TemplateData/mod.js,TemplateData/mod.css,TemplateData/shaders.js").split(",").map(s => s.trim()).filter(Boolean),
    urlAllow: env("SLOPE_EDIT_URL_ALLOW", "github.io,githubusercontent.com,cdnjs.cloudflare.com,fonts.googleapis.com,fonts.gstatic.com,unpkg.com,cdn.jsdelivr.net,id.net,y8.com,unity3d.com,doubleclick.net,googlesyndication.com,google-analytics.com,googletagmanager.com,tailscale.com,ts.net,w3.org").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    push: env("SLOPE_EDIT_PUSH", "1") !== "0",
    freeze: env("SLOPE_EDIT_FREEZE", "1") !== "0",                          // freeze the outgoing root as a version before each push
    authorName: env("SLOPE_EDIT_AUTHOR", "Slope dev mode"),
    authorEmail: env("SLOPE_EDIT_EMAIL", "slope-dev@users.noreply.github.com"),
};
CFG.dayTokenCap = Math.floor(CFG.dailyTokens * CFG.share);

// ---------------------------------------------------------------- password hash tool
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
function hashPassword(pw, saltB64) {
    const salt = saltB64 ? Buffer.from(saltB64, "base64") : crypto.randomBytes(16);
    const key = crypto.scryptSync(pw.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
    return "scrypt$" + salt.toString("base64") + "$" + key.toString("base64");
}
function checkPassword(pw) {
    const parts = CFG.passwordHash.split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt" || typeof pw !== "string" || pw.length < 1 || pw.length > 200) return false;
    const want = Buffer.from(parts[2], "base64");
    const got = Buffer.from(hashPassword(pw, parts[1]).split("$")[2], "base64");
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}
if (process.argv.includes("--hash")) {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", d => { input += d; });
    process.stdin.on("end", () => {
        const pw = input.replace(/\r?\n$/, "");
        if (pw.length < 8) { console.error("use at least 8 characters"); process.exit(1); }
        console.log(hashPassword(pw));
    });
    return;
}

fs.mkdirSync(CFG.dataDir, { recursive: true });
const LEDGER = path.join(CFG.dataDir, "ledger.json");
const SESSIONS = path.join(CFG.dataDir, "sessions.json");
const JOBLOG = path.join(CFG.dataDir, "jobs.log");

// ---------------------------------------------------------------- ledger (tokens and USD per day, USD per month)
function loadLedger() {
    try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch (e) { return { days: {}, months: {}, recent: [] }; }
}
function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }
// Tokens are counted as billed-equivalent input tokens, not raw context size. Every turn re-reads the whole
// cached context (the page files alone are ~50k tokens), so a raw sum grows by the full context per turn and
// a five-turn edit "costs" 250k while the account is charged for a fraction of that. Weights follow the API
// price list for Sonnet 5.5: cache read 0.1x input, cache write 1.25x, output 5x.
const TOKEN_WEIGHTS = { input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 };
function weighTokens(u) { let t = 0; for (const k in TOKEN_WEIGHTS) t += (u[k] || 0) * TOKEN_WEIGHTS[k]; return Math.round(t); }
const dayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
function dayRec(l, k) { const d = l.days[k]; return typeof d === "object" && d ? d : { tokens: 0, usd: typeof d === "number" ? d : 0 }; }
function budget() {
    const l = loadLedger(), d = dayRec(l, dayKey()), monthUsd = l.months[monthKey()] || 0;
    return { dayTokens: d.tokens, dayTokenCap: CFG.dayTokenCap, dayTokensLeft: Math.max(0, CFG.dayTokenCap - d.tokens), perJobTokens: CFG.perJobTokens,
             dayUsd: +d.usd.toFixed(4), dayUsdCap: CFG.dailyUsd, monthUsd: +monthUsd.toFixed(4), monthUsdCap: CFG.monthlyUsd,
             usdLeft: Math.max(0, Math.min(CFG.dailyUsd - d.usd, CFG.monthlyUsd - monthUsd)) };
}
function budgetProblem() {
    const b = budget();
    if (b.dayTokensLeft < Math.min(CFG.perJobTokens, 20000)) return "The dev-mode token budget for today is used up (" + b.dayTokens.toLocaleString() + " of " + b.dayTokenCap.toLocaleString() + "). It resets at midnight UTC.";
    if (b.usdLeft < CFG.perJobUsd) return "The dev-mode spending cap is reached for now. It resets at midnight UTC.";
    return null;
}
function charge(job) {
    const l = loadLedger(), k = dayKey(), d = dayRec(l, k);
    d.tokens += job.tokens || 0; d.usd += job.cost || 0; l.days[k] = d;
    l.months[monthKey()] = (l.months[monthKey()] || 0) + (job.cost || 0);
    l.recent.unshift({ id: job.id, at: job.finishedAt, prompt: job.prompt.slice(0, 120), state: job.state, tokens: job.tokens || 0, cost: +(job.cost || 0).toFixed(4), commit: job.commit || null, version: job.frozen || null, summary: (job.summary || job.error || "").replace(/\s+/g, " ").slice(0, 200) });
    l.recent = l.recent.slice(0, 40);
    saveLedger(l);
}
function logLine(s) { fs.appendFileSync(JOBLOG, new Date().toISOString() + " " + s + "\n"); }

// ---------------------------------------------------------------- sessions
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS, "utf8")); } catch (e) { sessions = {}; }
function saveSessions() { fs.writeFileSync(SESSIONS, JSON.stringify(sessions)); }
function newSession(ip) {
    const now = Date.now();
    for (const t of Object.keys(sessions)) if (sessions[t].exp < now) delete sessions[t];
    const token = crypto.randomBytes(24).toString("base64url");
    sessions[token] = { ip, at: now, exp: now + CFG.sessionHours * 3600e3 };
    saveSessions();
    return { token, exp: sessions[token].exp };
}
function sessionOf(req) {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer ([A-Za-z0-9_-]{20,})$/);
    if (!m) return null;
    const s = sessions[m[1]];
    if (!s || s.exp < Date.now()) { if (s) { delete sessions[m[1]]; saveSessions(); } return null; }
    return s;
}
const loginHits = new Map();   // ip -> timestamps
let loginAll = [];             // timestamps
function loginAllowed(ip) {
    const now = Date.now();
    const mine = (loginHits.get(ip) || []).filter(t => now - t < 15 * 60e3);
    loginAll = loginAll.filter(t => now - t < 3600e3);
    if (mine.length >= CFG.loginPerIp || loginAll.length >= CFG.loginGlobal) return false;
    mine.push(now); loginHits.set(ip, mine); loginAll.push(now);
    return true;
}

// ---------------------------------------------------------------- git helpers
function git(args, opts) {
    const r = spawnSync("git", args, { cwd: CFG.repoDir, encoding: "utf8", timeout: 180000, ...opts });
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
    const r = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], { cwd: CFG.repoDir, encoding: "utf8", timeout: 60000 });
    if (r.status !== 0) throw new Error("git status failed: " + (r.stderr || r.error));
    const out = [];
    const parts = r.stdout.split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        const xy = e.slice(0, 2), p = e.slice(3);
        out.push(p);
        if (xy[0] === "R" || xy[0] === "C") i++;          // skip the source path of a rename/copy
    }
    return out;
}

// ---------------------------------------------------------------- validation
const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;
function validate(job) {
    const files = changedFiles();
    if (!files.length) return "Claude made no changes to the game files.";
    const bad = files.filter(f => !CFG.editable.includes(f));
    if (bad.length) return "The edit touched files outside the allowed set (" + bad.join(", ") + "), so it was discarded. Existing versions, the scene data and the tools are off limits.";
    for (const f of files) {
        const p = path.join(CFG.repoDir, f);
        if (!fs.existsSync(p)) return f + " was deleted; discarded.";
        const size = fs.statSync(p).size;
        if (size > 768 * 1024) return f + " grew past 768 KB; discarded.";
        if (f.endsWith(".js")) {
            const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
            if (r.status !== 0) return "The new " + f + " does not parse:\n" + (r.stderr || "").split("\n").slice(0, 6).join("\n");
        }
    }
    const diff = git(["diff", "--unified=0"]);
    const lines = diff.split("\n");
    const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++"));
    const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---"));
    for (const line of added) {
        let m;
        while ((m = URL_RE.exec(line)) !== null) {
            const host = m[1].toLowerCase();
            if (!CFG.urlAllow.some(a => host === a || host.endsWith("." + a))) return "The edit added a link to " + host + ", which is not allowed; discarded.";
        }
        if (/<script[\s>]/i.test(line) || /<iframe[\s>]/i.test(line)) return "The edit added a script or iframe tag; discarded.";
        if (/document\.cookie|\.credentials|localStorage\.getItem\(["']slope-dev/i.test(line)) return "The edit added something that reads credentials or cookies; discarded.";
        if (/\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(|\batob\s*\(|\bWebSocket\s*\(|\bEventSource\s*\(|\bnavigator\.sendBeacon|\bimportScripts\s*\(/i.test(line)) return "The edit added dynamic code loading or a side channel (eval / Function / import() / atob / WebSocket / sendBeacon); discarded.";
    }
    if (removed.concat(added).some(l => /SLOPE_EDIT_API/.test(l))) return "The edit changed the dev-mode endpoint line in index.html; discarded.";
    for (const f of files) if (f.endsWith(".html")) {
        const html = fs.readFileSync(path.join(CFG.repoDir, f), "utf8");
        const scripts = (html.match(/<script[^>]*src=["']([^"']+)["']/gi) || []).map(s => s.replace(/.*src=["']([^"']+)["'].*/i, "$1"));
        if (scripts.some(s => /^(https?:)?\/\//i.test(s))) return "index.html must not load scripts from other sites; discarded.";
    }
    return null;
}

// ---------------------------------------------------------------- versions: freeze the root being replaced
function nextVersionTag(jobId) {
    let n = 0;
    try {
        const man = JSON.parse(fs.readFileSync(path.join(CFG.repoDir, "versions", "index.json"), "utf8"));
        for (const v of man.versions || []) { const m = String(v.tag).match(/^v(\d+)/); if (m) n = Math.max(n, +m[1]); }
    } catch (e) { /* no manifest yet */ }
    return "v" + (n + 1) + "-dev-" + jobId.slice(0, 6);
}
function freezeOutgoing(job, say) {
    const tag = nextVersionTag(job.id);
    const headTitle = git(["log", "-1", "--format=%s"]).slice(0, 80);
    const r = spawnSync(CFG.python, ["tools/snapshot_version.py", tag, "--from", "HEAD", "--title", "Before dev edit " + job.id.slice(0, 6), "--notes", "The root as it was before the dev-mode edit '" + job.prompt.replace(/\s+/g, " ").slice(0, 100) + "'. Last commit: " + headTitle],
                        { cwd: CFG.repoDir, encoding: "utf8", timeout: 180000 });
    if (r.status !== 0) throw new Error("Could not freeze the outgoing version: " + (r.stderr || r.stdout || r.error).slice(-400));
    const r2 = spawnSync(CFG.python, ["tools/snapshot_version.py", "--latest", "--title", "Dev edit: " + job.prompt.replace(/\s+/g, " ").slice(0, 60), "--notes", "Made with the in-game dev mode (job " + job.id + ")."],
                         { cwd: CFG.repoDir, encoding: "utf8", timeout: 60000 });
    if (r2.status !== 0) throw new Error("Could not update the version list: " + (r2.stderr || r2.stdout || r2.error).slice(-400));
    say("Froze the version this replaces as " + tag + ".");
    return tag;
}

// ---------------------------------------------------------------- claude runner
const SYSTEM_RULES = `You are editing a small browser game mod (a Unity WebGL page) on behalf of a trusted developer who typed a request into the game's dev-mode panel. Rules:
- You may only change index.html, TemplateData/mod.js, TemplateData/mod.css and TemplateData/shaders.js. Read README.md and other files for context if useful, but never modify anything else: not versions/ (frozen older releases), not Build/ (the game data), not tools/ or edit-server/.
- In index.html never touch the line that sets window.SLOPE_EDIT_API, and never add script tags that load from other sites.
- Keep the game working: the page must still load and play. Do not remove the network shim, the HUD basics, the version picker, or the SlopeMod init/onGameReady entry points. Prefer small, well-contained changes; add new features as new functions and keep existing behaviour unless asked to change it.
- Do not add external scripts, iframes, fetches to other sites, tracking, cookies, or anything that reads or sends visitor data. Do not add offensive, hateful, sexual or deceptive content. If the request asks for any of that, make no changes and say why.
- You cannot run the game or any commands: reason carefully, keep JavaScript syntactically valid, and finish within a few edits.
- When done, reply with one to three plain sentences describing what you changed (shown to the developer and used as the version note).
- Tokens are metered. The files are large (mod.js and shaders.js are over 1000 lines each): never Read a whole file longer than 200 lines. Find the spot with Grep (use -n and a little context) or with the line numbers in the file map below, then Read with offset and limit covering at most ~120 lines around it. Read a region once, then edit it. Do not re-read files to "check"; you cannot run anything anyway.
- If the developer's message is a question, a status check, a greeting or a remark rather than a request to change something, answer it in one or two sentences from what you already know and the recent-jobs list in the message, read nothing, and make no edits. Each message is a fresh session: you remember nothing except what the message tells you.`;

// Line-number map of the editable files (plus the read-only scene scripts they talk to), appended to the system
// prompt so it is cached across jobs while the files are unchanged. It lets Claude jump to a region with
// Read(offset, limit) instead of reading 25k-token files whole.
const MAP_FILES = ["index.html", "TemplateData/mod.js", "TemplateData/mod.css", "TemplateData/shaders.js", "TemplateData/coins.js", "TemplateData/versions.js"];
let mapCache = { head: null, text: "" };
function fileMap() {
    let head = ""; try { head = git(["rev-parse", "HEAD"]); } catch (e) { head = String(Date.now()); }
    if (mapCache.head === head) return mapCache.text;
    const out = ["File map (line numbers; '~' = read-only context file):"];
    for (const f of MAP_FILES) {
        const p = path.join(CFG.repoDir, f);
        if (!fs.existsSync(p)) continue;
        const lines = fs.readFileSync(p, "utf8").split("\n");
        const ro = CFG.editable.includes(f) ? "" : " ~";
        out.push(f + ro + " (" + lines.length + " lines)");
        const picks = [];
        lines.forEach((l, i) => {
            let m;
            if (f.endsWith(".js")) {
                const prevRule = i > 0 && /^\s*\/\/\s*[=-]{6,}\s*$/.test(lines[i - 1]);   // banner: a rule line above the title
                if ((m = l.match(/^\s{0,8}\/\/ (?:([=-]{3,})\s*)?(.*)$/)) && (m[1] || prevRule || /^[0-9]+\.\s/.test(m[2])) && /[A-Za-z]/.test(m[2])) picks.push([i + 1, "// " + m[2].replace(/[=-]{3,}\s*$/, "").trim().slice(0, 70)]);
                else if ((m = l.match(/^\s{0,4}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/))) picks.push([i + 1, m[1] + "()"]);
                else if ((m = l.match(/^\s{0,4}(?:var|const|let) ([A-Z][A-Z0-9_]{2,})\s*=/))) picks.push([i + 1, m[1]]);
                else if ((m = l.match(/^\s{4,8}([a-zA-Z_$][\w$]*)\s*:\s*function\s*\(/))) picks.push([i + 1, "." + m[1] + "()"]);
            } else if (f.endsWith(".css")) {
                if ((m = l.match(/^([.#@][^{]{1,60})\{?/))) picks.push([i + 1, m[1].trim()]);
            } else if (f.endsWith(".html")) {
                if ((m = l.match(/<(script|style|div|span|select|input|button|section|canvas)\b[^>]*\b(id|class)=["']([^"']+)/))) picks.push([i + 1, "<" + m[1] + " " + m[2] + "=" + m[3] + ">"]);
                else if ((m = l.match(/<script src=["']([^"']+)/))) picks.push([i + 1, "<script " + m[1] + ">"]);
            }
        });
        // keep the map around 100 entries per file: drop constants first, then methods, then thin functions evenly
        const max = 110;
        let kept = picks;
        if (kept.length > max) kept = kept.filter(x => !/^[A-Z][A-Z0-9_]+$/.test(x[1]));
        if (kept.length > max) kept = kept.filter(x => !x[1].startsWith("."));
        if (kept.length > max) { const step = Math.ceil(kept.length / max); kept = kept.filter((x, i) => x[1].startsWith("//") || i % step === 0); }
        for (const [n, t] of kept) out.push("  " + n + " " + t);
    }
    mapCache = { head, text: out.join("\n") };
    return mapCache.text;
}
function recentContext() {
    const l = loadLedger();
    const r = (l.recent || []).slice(0, 4);
    if (!r.length) return "Recent dev-mode jobs: none yet.";
    return "Recent dev-mode jobs (newest first):\n" + r.map(j => "- [" + j.state + (j.version ? ", previous version kept as " + j.version : "") + "] \"" + j.prompt + "\"" + (j.summary ? " → " + j.summary : "")).join("\n");
}
function jobMessage(job) {
    return "Developer's message: " + job.prompt + "\n\n" + recentContext();
}

function runClaude(job, onEvent) {
    return new Promise((resolve) => {
        const args = ["-p", jobMessage(job), "--output-format", "stream-json", "--verbose",
                      "--permission-mode", "default",
                      "--allowedTools", "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write",
                      "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit", "KillShell", "BashOutput",
                      "--max-budget-usd", String(CFG.perJobUsd),
                      "--max-turns", String(CFG.maxTurns),
                      "--no-session-persistence",
                      "--append-system-prompt", SYSTEM_RULES + "\n\n" + fileMap()];
        if (CFG.model) args.push("--model", CFG.model);
        if (fs.existsSync(CFG.settingsFile)) args.push("--settings", CFG.settingsFile);
        const childEnv = { ...process.env };
        if (CFG.claudeConfigDir) childEnv.CLAUDE_CONFIG_DIR = CFG.claudeConfigDir;
        childEnv.CI = "1"; childEnv.DISABLE_AUTOUPDATER = "1"; childEnv.DISABLE_TELEMETRY = "1";
        delete childEnv.SLOPE_EDIT_PASSWORD_HASH;
        const child = spawn(CFG.claudeBin, args, { cwd: CFG.repoDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
        let buf = "", result = null, stderr = "", tokens = 0, killed = null;
        const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 };
        const stop = why => { if (killed) return; killed = why; onEvent(why); try { child.kill("SIGKILL"); } catch (e) {} };
        const timer = setTimeout(() => stop("Time limit reached, stopping."), CFG.jobTimeoutMs);
        const addUsage = u => {
            if (!u) return;
            usage.input += u.input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0; usage.output += u.output_tokens || 0; usage.turns++;
            tokens += weighTokens(u);
            if (tokens > CFG.perJobTokens) stop("This edit passed its token limit (" + CFG.perJobTokens.toLocaleString() + "), stopping.");
        };
        child.stdout.on("data", d => {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line) continue;
                let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
                if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
                    addUsage(ev.message.usage);
                    for (const c of ev.message.content) {
                        if (c.type === "text" && c.text.trim()) onEvent(c.text.trim().slice(0, 600));
                        else if (c.type === "tool_use") {
                            const inp = c.input || {}; const f = inp.file_path ? path.relative(CFG.repoDir, inp.file_path) : (inp.pattern || inp.path || "");
                            onEvent("→ " + c.name + (f ? " " + f : ""));
                        }
                    }
                } else if (ev.type === "result") {
                    result = ev;
                    if (ev.usage) { const total = weighTokens(ev.usage); if (total > tokens) tokens = total; }
                }
            }
        });
        child.stderr.on("data", d => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, result, stderr, tokens, killed, usage }); });
        child.on("error", e => { clearTimeout(timer); resolve({ code: -1, result: null, stderr: String(e), tokens, killed, usage }); });
    });
}

// ---------------------------------------------------------------- jobs
const jobs = new Map();          // id -> job
const queue = [];                // ids
let running = null;
const ipHits = new Map();        // ip -> [timestamps]

function newJob(prompt, ip) {
    const id = crypto.randomBytes(6).toString("hex");
    const job = { id, prompt, ip, state: "queued", createdAt: Date.now(), startedAt: null, finishedAt: null, log: [], cost: 0, tokens: 0, commit: null, frozen: null, summary: null, error: null };
    jobs.set(id, job); queue.push(id);
    setImmediate(pump);
    return job;
}
function position(job) { const i = queue.indexOf(job.id); return i < 0 ? 0 : i + 1; }

async function pump() {
    if (running || !queue.length) return;
    const job = jobs.get(queue.shift()); running = job;
    job.state = "running"; job.startedAt = Date.now();
    const say = s => { job.log.push(s); if (job.log.length > 80) job.log.shift(); };
    try {
        const bp = budgetProblem(); if (bp) throw new Error(bp);
        say("Syncing the game files…"); syncRepo();
        say("Asking Claude…");
        const { code, result, stderr, tokens, killed, usage } = await runClaude(job, say);
        job.tokens = tokens; job.usage = usage;
        job.cost = result && typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
        if (killed) throw new Error(killed);
        if (!result) throw new Error("Claude did not finish (exit " + code + ")" + (stderr ? ": " + stderr.split("\n").filter(Boolean).slice(-2).join(" ") : ""));
        job.summary = (result.result || "").toString().slice(0, 800);
        if (result.is_error) throw new Error("Claude reported an error: " + job.summary);
        if (!changedFiles().length) {
            // a question, a status check or a refusal: nothing to validate or publish
            if (!job.summary) throw new Error("Claude made no changes and said nothing.");
            job.state = "answered"; say(job.summary);
            return;
        }
        const problem = validate(job);
        if (problem) throw new Error(problem);
        const files = changedFiles();
        say("Validated: " + files.join(", "));
        if (CFG.freeze) { say("Freezing the version this replaces…"); job.frozen = freezeOutgoing(job, say); }
        git(["add", "-A", "--", ...files, "versions"]);
        const title = job.prompt.replace(/\s+/g, " ").slice(0, 60);
        git(["-c", "user.name=" + CFG.authorName, "-c", "user.email=" + CFG.authorEmail, "commit", "--quiet", "-m",
             "Dev edit: " + title + "\n\nRequest: " + job.prompt + "\n\n" + (job.summary ? job.summary + "\n\n" : "") +
             "Made by Claude Code through the in-game dev mode (job " + job.id + ", " + tokens.toLocaleString() + " tokens" + (job.cost ? ", $" + job.cost.toFixed(3) : "") + ")." +
             (job.frozen ? " The version it replaces is frozen as " + job.frozen + "." : "")]);
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
        charge(job);
        const u = job.usage || {};
        logLine(job.id + " " + job.state + " tokens=" + (job.tokens || 0) + " (in " + (u.input || 0) + " cw " + (u.cacheWrite || 0) + " cr " + (u.cacheRead || 0) + " out " + (u.output || 0) + " turns " + (u.turns || 0) + ") $" + (job.cost || 0).toFixed(4) + " " + (job.commit || "-") + " frozen=" + (job.frozen || "-") + " ip=" + job.ip + " :: " + job.prompt.replace(/\s+/g, " ").slice(0, 200) + (job.error ? " :: " + job.error.replace(/\s+/g, " ").slice(0, 300) : ""));
        running = null;
        setImmediate(pump);
    }
}

function publicJob(job) {
    return { id: job.id, state: job.state, position: position(job), prompt: job.prompt, log: job.log, tokens: job.tokens || 0, usage: job.usage || null, cost: +(job.cost || 0).toFixed(4),
             commit: job.commit, version: job.frozen, summary: job.summary, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt };
}

// ---------------------------------------------------------------- http
function send(res, code, body, origin) {
    const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (origin) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"; h["Access-Control-Allow-Headers"] = "Content-Type, Authorization"; }
    res.writeHead(code, h); res.end(JSON.stringify(body));
}
function clientIp(req) {
    // behind the Funnel/serve proxy (which connects from loopback) the LAST entry is the one the proxy appended;
    // a visitor can put anything in the earlier entries, so never trust those
    const xf = req.headers["x-forwarded-for"], remote = req.socket.remoteAddress || "?";
    const loopback = /^(::1|127\.|::ffff:127\.)/.test(remote);
    if (xf && loopback) { const parts = String(xf).split(",").map(x => x.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
    return remote;
}
function readJson(req, cb) {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 10000) req.destroy(); });
    req.on("end", () => { let o = null; try { o = JSON.parse(body); } catch (e) { o = null; } cb(o); });
}
const server = http.createServer((req, res) => {
    const origin = req.headers.origin && CFG.allowOrigins.includes(req.headers.origin) ? req.headers.origin : (CFG.allowOrigins.includes("*") ? "*" : null);
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") { send(res, 204, {}, origin); return; }
    const ip = clientIp(req), session = sessionOf(req);
    if (url.pathname === "/api/status" && req.method === "GET") {
        if (!session) { send(res, 200, { ok: true, devmode: true, locked: true, configured: !!CFG.passwordHash }, origin); return; }
        const l = loadLedger();
        send(res, 200, { ok: true, devmode: true, locked: false, budget: budget(), queue: queue.length, running: !!running, recent: l.recent.slice(0, 10), editable: CFG.editable, model: CFG.model, sessionExp: session.exp }, origin);
        return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
        readJson(req, o => {
            if (!o || typeof o.password !== "string") { send(res, 400, { error: "bad json" }, origin); return; }
            if (!CFG.passwordHash) { send(res, 503, { error: "Dev mode has no password configured on the server." }, origin); return; }
            if (!loginAllowed(ip)) { send(res, 429, { error: "Too many attempts; try again later." }, origin); return; }
            // scrypt takes ~50 ms: that is the point (no fast guessing), and it runs after the rate limit
            if (!checkPassword(o.password)) { logLine("login failed ip=" + ip); setTimeout(() => send(res, 403, { error: "Wrong password." }, origin), 400); return; }
            const s = newSession(ip); logLine("login ok ip=" + ip);
            send(res, 200, { ok: true, token: s.token, exp: s.exp }, origin);
        });
        return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
        const h = req.headers.authorization || "", m = h.match(/^Bearer (.+)$/);
        if (m && sessions[m[1]]) { delete sessions[m[1]]; saveSessions(); }
        send(res, 200, { ok: true }, origin); return;
    }
    if (!session) { send(res, 401, { error: "Dev mode is locked. Enter the password first." }, origin); return; }
    let m = url.pathname.match(/^\/api\/job\/([a-f0-9]{12})$/);
    if (m && req.method === "GET") {
        const job = jobs.get(m[1]);
        if (!job) { send(res, 404, { error: "unknown job" }, origin); return; }
        send(res, 200, publicJob(job), origin); return;
    }
    if (url.pathname === "/api/edit" && req.method === "POST") {
        readJson(req, o => {
            let prompt = o && typeof o.prompt === "string" ? o.prompt : null;
            if (prompt === null) { send(res, 400, { error: "bad json" }, origin); return; }
            prompt = prompt.replace(/\r/g, "").trim();
            if (prompt.length < 4) { send(res, 400, { error: "Say what you want changed." }, origin); return; }
            if (prompt.length > CFG.maxPrompt) { send(res, 400, { error: "Keep it under " + CFG.maxPrompt + " characters." }, origin); return; }
            const now = Date.now();
            const hits = (ipHits.get(ip) || []).filter(t => now - t < 3600e3);
            if (hits.length >= CFG.perIpPerHour) { send(res, 429, { error: "You have used your " + CFG.perIpPerHour + " edits for this hour." }, origin); return; }
            if (queue.length >= CFG.maxQueue) { send(res, 429, { error: "The queue is full; try again in a few minutes." }, origin); return; }
            const bp = budgetProblem(); if (bp) { send(res, 429, { error: bp }, origin); return; }
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
if (!CFG.passwordHash) console.error("WARNING: SLOPE_EDIT_PASSWORD_HASH is not set; dev mode cannot be unlocked (run `node server.js --hash`).");
server.listen(CFG.port, CFG.host, () => {
    console.log("slope-edit (dev mode) listening on http://" + CFG.host + ":" + CFG.port + " repo=" + CFG.repoDir + " model=" + CFG.model +
                " tokens: " + CFG.perJobTokens + "/job " + CFG.dayTokenCap + "/day (" + Math.round(CFG.share * 100) + "% of " + CFG.dailyTokens + ") push=" + CFG.push + " freeze=" + CFG.freeze);
});
