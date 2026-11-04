#!/bin/bash
# One-time setup of the sandboxed dev-mode editor on a macOS host (Apple silicon, Homebrew node + python@3.13).
# Run as an admin from a checkout of the repo:  bash edit-server/setup-mac.sh [repo url]
# Re-running is safe: it updates the app files and the launchd job and leaves the clone, data, env and home alone.
# macOS has no systemd sandbox; containment here is a dedicated hidden non-admin user (no shell, no access
# to other users' homes) plus the Claude Code permission rules, the validator and the version freeze.
set -euo pipefail
REPO_URL="${1:-https://github.com/ENahuel3/Slope-Game.git}"
BASE=/opt/slope-edit
ID=480
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE=/opt/homebrew/bin/node NPM=/opt/homebrew/bin/npm PY=/opt/homebrew/bin/python3.13
for b in $NODE $NPM $PY /usr/bin/git; do [ -x $b ] || { echo "missing $b (brew install node python@3.13; xcode-select --install)"; exit 1; }; done
asu() { (cd / && sudo -u slopeedit env HOME=$BASE/home PATH=$BASE/home/venv/bin:$BASE/home/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/bin "$@"); }

if ! dscl . -read /Groups/slopeedit >/dev/null 2>&1; then
  sudo dscl . -create /Groups/slopeedit PrimaryGroupID $ID
  sudo dscl . -create /Groups/slopeedit Password '*'
fi
if ! id slopeedit >/dev/null 2>&1; then
  sudo dscl . -create /Users/slopeedit
  sudo dscl . -create /Users/slopeedit UniqueID $ID
  sudo dscl . -create /Users/slopeedit PrimaryGroupID $ID
  sudo dscl . -create /Users/slopeedit UserShell /usr/bin/false
  sudo dscl . -create /Users/slopeedit NFSHomeDirectory $BASE/home
  sudo dscl . -create /Users/slopeedit RealName "Slope dev mode"
  sudo dscl . -create /Users/slopeedit Password '*'
  sudo dscl . -create /Users/slopeedit IsHidden 1
fi

sudo mkdir -p $BASE/app $BASE/data $BASE/log $BASE/home/.claude $BASE/home/.npm-global $BASE/home/.ssh
sudo install -o root -g wheel -m 0644 "$SRC_DIR/server.js" "$SRC_DIR/run-mac.sh" $BASE/app/
# the Pi's settings, with its paths moved to this base (and macOS homes denied like /home)
$NODE -e '
const fs = require("fs"), [src, base] = process.argv.slice(1);
const s = JSON.parse(fs.readFileSync(src, "utf8").split("/srv/slope-edit").join(base));
if (!s.permissions.deny.includes("Read(//Users/**)")) s.permissions.deny.push("Read(//Users/**)");
process.stdout.write(JSON.stringify(s, null, 2) + "\n");' "$SRC_DIR/claude-settings.json" $BASE | sudo tee $BASE/app/claude-settings.json >/dev/null
sudo chown root:wheel $BASE $BASE/app $BASE/app/claude-settings.json && sudo chmod 0755 $BASE $BASE/app && sudo chmod 0644 $BASE/app/claude-settings.json
sudo chown -R slopeedit:slopeedit $BASE/data $BASE/home $BASE/log
sudo chmod 0750 $BASE/data $BASE/home && sudo chmod 0700 $BASE/home/.ssh

# Claude Code CLI for the sandbox user only (its own npm prefix inside its home)
if ! sudo test -x $BASE/home/.npm-global/bin/claude; then
  asu $NPM config set prefix $BASE/home/.npm-global
  asu $NPM install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
fi
# Python for the harnesses (tools/*.py) and the pre-publish smoke check
if ! sudo test -x $BASE/home/venv/bin/python; then
  asu $PY -m venv $BASE/home/venv
  asu $BASE/home/venv/bin/pip install -q playwright==1.64.1 UnityPy==1.25.4 pillow
  asu env PLAYWRIGHT_BROWSERS_PATH=$BASE/home/.cache/ms-playwright $BASE/home/venv/bin/python -m playwright install chromium-headless-shell
fi

# Deploy key (write access to this one repo only); DEPLOY_KEY=/path/to/id_ed25519 reuses an existing one (e.g. the Pi's)
if ! sudo test -f $BASE/home/.ssh/id_ed25519 && [ -n "${DEPLOY_KEY:-}" ]; then
  sudo install -o slopeedit -g slopeedit -m 0600 "$DEPLOY_KEY" $BASE/home/.ssh/id_ed25519
  sudo install -o slopeedit -g slopeedit -m 0644 "$DEPLOY_KEY.pub" $BASE/home/.ssh/id_ed25519.pub
fi
if ! sudo test -f $BASE/home/.ssh/id_ed25519; then
  asu ssh-keygen -q -t ed25519 -N "" -C "slope-edit@$(hostname -s)" -f $BASE/home/.ssh/id_ed25519
  echo "New deploy key, add it with write access under the repo's Settings > Deploy keys:"; sudo cat $BASE/home/.ssh/id_ed25519.pub
fi
sudo grep -q github.com $BASE/home/.ssh/known_hosts 2>/dev/null || ssh-keyscan -t ed25519 github.com 2>/dev/null | sudo -u slopeedit tee -a $BASE/home/.ssh/known_hosts >/dev/null
if ! sudo test -d $BASE/repo/.git; then
  sudo mkdir -p $BASE/repo && sudo chown slopeedit:slopeedit $BASE/repo
  asu git clone --branch mod "git@github.com:${REPO_URL#https://github.com/}" $BASE/repo
fi
asu git -C $BASE/repo config user.name "Slope dev mode"
asu git -C $BASE/repo config user.email "slope-dev@users.noreply.github.com"
asu git -C $BASE/repo config core.hooksPath .githooks

if [ ! -f $BASE/env ]; then
  sudo tee $BASE/env >/dev/null <<'ENV'
# Dev-mode password: only this scrypt hash is stored anywhere. Make it with
#   printf '%s\n' 'the password' | node /opt/slope-edit/app/server.js --hash
SLOPE_EDIT_PASSWORD_HASH=
# Claude login for the sandbox: a long-lived token from `claude setup-token` (the macOS keychain is not
# available to a daemon user), or ANTHROPIC_API_KEY= for API billing.
CLAUDE_CODE_OAUTH_TOKEN=
SLOPE_EDIT_DAILY_TOKENS=0
SLOPE_EDIT_SHARE=0.10
SLOPE_EDIT_JOB_TOKENS=600000
SLOPE_EDIT_JOB_USD=5
SLOPE_EDIT_DAILY_USD=0
SLOPE_EDIT_MONTHLY_USD=0
SLOPE_EDIT_MODEL=claude-opus-5-5
SLOPE_EDIT_IP_PER_HOUR=30
ENV
fi
sudo chown root:slopeedit $BASE/env && sudo chmod 0640 $BASE/env

sudo install -o root -g wheel -m 0644 "$SRC_DIR/com.slope-edit.plist" /Library/LaunchDaemons/com.slope-edit.plist
sudo launchctl bootout system/com.slope-edit 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/com.slope-edit.plist
sleep 2; curl -s http://127.0.0.1:8787/api/status; echo
cat <<EOF

Next steps:
1. Password hash + CLAUDE_CODE_OAUTH_TOKEN into $BASE/env, then: sudo launchctl kickstart -k system/com.slope-edit
2. Public HTTPS endpoint: /Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8787
   and set window.SLOPE_EDIT_API in index.html to https://<this machine>.<tailnet>.ts.net
Logs: $BASE/log/server.log and $BASE/data/jobs.log
EOF
