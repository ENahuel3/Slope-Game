#!/usr/bin/env bash
# One-time setup of the sandboxed editor service on a Debian/Raspberry Pi OS host.
# Run as a sudoer: bash edit-server/setup-pi.sh https://github.com/ENahuel3/Slope-Game.git
set -euo pipefail
REPO_URL="${1:-https://github.com/ENahuel3/Slope-Game.git}"
BASE=/srv/slope-edit
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "node is required (>= 18). On the Pi: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"; exit 1; }
command -v git >/dev/null || sudo apt-get install -y git

id slopeedit &>/dev/null || sudo useradd --system --create-home --home-dir $BASE/home --shell /usr/sbin/nologin slopeedit
sudo mkdir -p $BASE/app $BASE/data $BASE/home/.claude $BASE/home/.npm-global
sudo cp "$SRC_DIR/server.js" "$SRC_DIR/claude-settings.json" $BASE/app/
[ -d $BASE/repo/.git ] || sudo git clone --branch mod "$REPO_URL" $BASE/repo
sudo chown -R slopeedit:slopeedit $BASE/repo $BASE/data $BASE/home
sudo chown -R root:root $BASE/app && sudo chmod -R a+rX $BASE/app

# Claude Code CLI for the sandbox user only (its own npm prefix inside its home)
sudo -u slopeedit -H env HOME=$BASE/home npm config set prefix $BASE/home/.npm-global
sudo -u slopeedit -H env HOME=$BASE/home npm install -g @anthropic-ai/claude-code
sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo config user.name "Slope community editor"
sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo config user.email "slope-edit@users.noreply.github.com"

# Deploy key so the sandbox user can push to the fork (write access to this one repo only)
if [ ! -f $BASE/home/.ssh/id_ed25519 ]; then
  sudo -u slopeedit -H mkdir -p $BASE/home/.ssh
  sudo -u slopeedit -H ssh-keygen -q -t ed25519 -N "" -C "slope-edit@$(hostname)" -f $BASE/home/.ssh/id_ed25519
  sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo remote set-url origin "git@github.com:${REPO_URL#https://github.com/}"
  sudo -u slopeedit -H bash -c "ssh-keyscan -t ed25519 github.com >> $BASE/home/.ssh/known_hosts 2>/dev/null"
  echo; echo "Add this as a DEPLOY KEY with write access on the GitHub repo (Settings > Deploy keys):"; sudo cat $BASE/home/.ssh/id_ed25519.pub; echo
fi

if [ ! -f $BASE/env ]; then
  sudo tee $BASE/env >/dev/null <<'ENV'
# Billing: a dedicated API key from console.anthropic.com in a workspace with its own spend limit.
ANTHROPIC_API_KEY=sk-ant-REPLACE_ME
# Caps (USD). Per job is also passed to Claude Code as --max-budget-usd.
SLOPE_EDIT_JOB_USD=0.75
SLOPE_EDIT_DAILY_USD=3
SLOPE_EDIT_MONTHLY_USD=20
SLOPE_EDIT_MODEL=claude-sonnet-5-5
SLOPE_EDIT_IP_PER_HOUR=6
ENV
  sudo chown root:slopeedit $BASE/env && sudo chmod 0640 $BASE/env
  echo "Edit $BASE/env and put the API key in."
fi

sudo cp "$SRC_DIR/slope-edit.service" /etc/systemd/system/slope-edit.service
sudo systemctl daemon-reload
sudo systemctl enable --now slope-edit
sleep 1; sudo systemctl --no-pager --lines=5 status slope-edit || true
echo
echo "Expose it publicly over HTTPS with Tailscale Funnel (the page is served from https://enahuel3.github.io):"
echo "  sudo tailscale funnel --bg 8787        # then put the https://<host>.<tailnet>.ts.net URL into index.html as SLOPE_EDIT_API"
echo "Test:  curl -s http://127.0.0.1:8787/api/status"
