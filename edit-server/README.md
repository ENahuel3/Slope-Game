# slope-edit: the in-game Claude Code editor

Type `awesome` on the game page and a box appears where anyone can ask Claude
Code to change the mod. The request goes to this small Node service, which runs
Claude Code headlessly on a sandboxed clone of this repository, validates the
result and pushes it to the `mod` branch. GitHub Pages serves the change to
everyone about a minute later. Git history is the undo button: `git revert`.

## Containment

1. **systemd**: runs as the unprivileged `slopeedit` user with `ProtectSystem=strict`,
   `ProtectHome=yes`, private /tmp and devices, no capabilities, memory/CPU limits.
   Only `/srv/slope-edit/{repo,data,home}` are writable. Nothing else on the
   host can be touched, read access to the rest of the system follows normal
   unix permissions for a user that owns nothing.
2. **Claude Code permissions** (`claude-settings.json` + CLI flags): headless
   `--permission-mode default` denies every tool that is not pre-approved;
   approved are Read/Glob/Grep inside the clone and Edit/Write on
   `TemplateData/mod.js` and `TemplateData/mod.css` only. Bash, web access,
   subagents and reads of `~`, `/etc`, `/srv`, `.git`, `Build/` are denied.
3. **Validation** before anything is published: only the two allowed files may
   change, the JavaScript must parse, no new URLs to hosts outside an allow-list,
   no `<script>` tags or credential/cookie access in added lines, size caps.
   Anything else resets the clone and reports the reason to the visitor.
4. **Budget**: `--max-budget-usd` per job (default $0.75), a ledger with daily
   (default $3) and monthly (default $20) caps enforced before each job from
   Claude Code's own `total_cost_usd` reports, 6 jobs per visitor per hour,
   a queue of at most 6, one job at a time, a 6-minute wall-clock limit.
   For a hard stop independent of this code, create the API key in its own
   Console workspace with a spend limit.

## Install on the Pi

```
git clone --branch mod https://github.com/ENahuel3/Slope-Game.git && cd Slope-Game
bash edit-server/setup-pi.sh
sudo nano /srv/slope-edit/env            # paste the API key
sudo systemctl restart slope-edit
sudo tailscale funnel --bg 8787          # public https endpoint (needs Funnel enabled on the tailnet)
```

Then set `window.SLOPE_EDIT_API` in `index.html` to the Funnel URL and push.
The GitHub deploy key printed by the setup script must be added to the repo
with write access, otherwise jobs fail at the publish step (the edit is still
kept in the clone's history on the Pi).

## API

- `GET /api/status` – budget left today/this month, queue length, recent jobs
- `POST /api/edit` `{"prompt": "..."}` – enqueue, returns the job
- `GET /api/job/<id>` – state (`queued`, `running`, `done`, `failed`), log lines, cost, commit

Environment variables are listed at the top of `server.js`.
