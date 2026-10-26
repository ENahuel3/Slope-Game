# slope-edit: dev mode (Claude Code on the game page)

Type `devmode` on the game page and a password box appears. With the dev-mode
password, you can ask Claude Code to change the page. The request goes to this
small Node service on the owner's Raspberry Pi, which runs Claude Code headlessly
on a sandboxed clone of this repository, validates the result, freezes the version
being replaced in the Version list, and pushes the new root to the `mod` branch.
GitHub Pages serves it to everyone about a minute later.

## Why the password cannot be mined from the repository

The page is open source, so nothing on the page or in git can hold the secret.
The password itself is never stored anywhere: the Pi's root-owned env file holds
an scrypt hash (`SLOPE_EDIT_PASSWORD_HASH`, N=2^15, 16-byte salt, made with
`node server.js --hash`), the browser sends the password over HTTPS once, the
server verifies it in constant time and answers with a random 12-hour session
token that the page keeps in `sessionStorage`. Login attempts are limited to 5 per
visitor per 15 minutes and 40 per hour in total, and each check takes ~50 ms by
design. Every other endpoint requires the token.

## Containment

1. **systemd**: runs as the unprivileged `slopeedit` user with `ProtectSystem=strict`,
   `ProtectHome=yes`, private /tmp and devices, no capabilities, a system-call
   filter, memory/CPU limits. Only `/srv/slope-edit/{repo,data,home}` are writable;
   the rest of the Pi (other users' homes, the game server, system files) is not
   reachable from the service or from Claude Code.
2. **Claude Code permissions** (`claude-settings.json` + CLI flags): headless
   `--permission-mode default` denies every tool that is not pre-approved;
   approved are Read/Glob/Grep inside the clone and Edit/Write on `index.html`,
   `TemplateData/mod.js`, `TemplateData/mod.css` and `TemplateData/shaders.js`
   only. Bash, web access, subagents, and reads of `~`, `/etc`, `.git`, `Build/`,
   `tools/`, `edit-server/` and the frozen versions are denied.
3. **Validation** before anything is published: only those four files may change
   (so `versions/`, `Build/`, `tools/` are untouchable), the JavaScript must parse,
   no new URLs to hosts outside an allow-list, no script or iframe tags, no
   credential or cookie access in added lines, `index.html` may not load scripts
   from other sites and its `SLOPE_EDIT_API` line may not change, size caps.
   Anything else resets the clone and reports the reason.
4. **Versions**: before each push the root being replaced is frozen with
   `tools/snapshot_version.py` as `vN-dev-<job>`, so every dev edit appears in the
   Version picker and nothing older is ever modified; the hook in `.githooks/`
   enforces the same rule on the clone.
5. **Budget**: tokens are counted from Claude Code's own usage reports, weighted
   like the price list (cache reads 0.1x, cache writes 1.25x, output 5x input), so
   a turn that re-reads the ~50k-token cached context costs ~5k, not 50k. The ledger
   allows `SLOPE_EDIT_SHARE` (10%) of `SLOPE_EDIT_DAILY_TOKENS` per day, stops a
   job past `SLOPE_EDIT_JOB_TOKENS`, limits turns, and keeps USD caps for the case
   of API-key billing. 6 jobs per visitor per hour, a queue of 6, one job at a
   time, an 8-minute wall-clock limit.
6. **Thrift**: every job is a fresh headless session, so the server keeps the
   per-job overhead small. The system prompt is byte-stable and carries a
   line-number map of the editable files (regenerated when HEAD moves, cached by
   the API for an hour), and the rules tell Claude to Grep and Read line ranges
   instead of whole files. The message adds the last four jobs (request, outcome,
   note) so follow-ups and questions make sense; a message that asks for nothing
   is answered without reading or editing and shows up as `answered`. Each job
   logs its usage split (input / cache write / cache read / output / turns) in
   `data/jobs.log`, so the caps can be tuned from real numbers.

## Install on the Pi

```
git clone --branch mod https://github.com/ENahuel3/Slope-Game.git && cd Slope-Game
bash edit-server/setup-pi.sh
printf '%s\n' 'the password' | node /srv/slope-edit/app/server.js --hash     # -> SLOPE_EDIT_PASSWORD_HASH in /srv/slope-edit/env
sudo -u slopeedit -H env HOME=/srv/slope-edit/home CLAUDE_CONFIG_DIR=/srv/slope-edit/home/.claude /srv/slope-edit/home/.npm-global/bin/claude login
sudo systemctl restart slope-edit
sudo tailscale funnel --bg 8787          # public https endpoint (Funnel must be enabled for the tailnet)
```

The deploy key printed by the setup script must be added to the repo with write
access (`gh repo deploy-key add -w`). `window.SLOPE_EDIT_API` in `index.html`
points at the Funnel URL. Token allowance: set `SLOPE_EDIT_DAILY_TOKENS` in the
env file to the account's real daily figure; the service uses 10% of it.

## API

- `POST /api/login` `{"password": "..."}` – returns `{token, exp}`; `POST /api/logout`
- `GET /api/status` – without a token: `{locked: true}`; with one: budget (tokens today / cap), queue, recent jobs
- `POST /api/edit` `{"prompt": "..."}` – enqueue, returns the job (token required)
- `GET /api/job/<id>` – state (`queued`, `running`, `done`, `failed`), log lines, tokens, commit, frozen version

Environment variables are listed at the top of `server.js`.
