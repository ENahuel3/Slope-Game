#!/usr/bin/env bash
# One-time setup of the sandboxed dev-mode editor on a Debian/Raspberry Pi OS host.
# Run as a sudoer from a checkout of the repo:  bash edit-server/setup-pi.sh [repo url]
# Re-running is safe: it updates the service files and leaves the clone, data and env alone.
set -euo pipefail
REPO_URL="${1:-https://github.com/ENahuel3/Slope-Game.git}"
BASE=/srv/slope-edit
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "node is required (>= 18). On the Pi: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"; exit 1; }
command -v python3 >/dev/null || sudo apt-get install -y python3
command -v git >/dev/null || sudo apt-get install -y git

id slopeedit &>/dev/null || sudo useradd --system --create-home --home-dir $BASE/home --shell /usr/sbin/nologin slopeedit
sudo mkdir -p $BASE/app $BASE/data $BASE/home/.claude $BASE/home/.npm-global
sudo cp "$SRC_DIR/server.js" "$SRC_DIR/claude-settings.json" $BASE/app/
[ -d $BASE/repo/.git ] || sudo git clone --branch mod "$REPO_URL" $BASE/repo
sudo chown -R slopeedit:slopeedit $BASE/repo $BASE/data $BASE/home
sudo chown -R root:root $BASE/app && sudo chmod -R a+rX $BASE/app
sudo chmod 0750 $BASE/data $BASE/home

# Claude Code CLI for the sandbox user only (its own npm prefix inside its home)
if [ ! -x $BASE/home/.npm-global/bin/claude ]; then
  sudo -u slopeedit -H env HOME=$BASE/home npm config set prefix $BASE/home/.npm-global
  sudo -u slopeedit -H env HOME=$BASE/home npm install -g @anthropic-ai/claude-code
fi
sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo config user.name "Slope dev mode"
sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo config user.email "slope-dev@users.noreply.github.com"
sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo config core.hooksPath .githooks

# Deploy key so the sandbox user can push to the fork (write access to this one repo only)
if [ ! -f $BASE/home/.ssh/id_ed25519 ]; then
  sudo -u slopeedit -H mkdir -p $BASE/home/.ssh
  sudo -u slopeedit -H ssh-keygen -q -t ed25519 -N "" -C "slope-edit@$(hostname)" -f $BASE/home/.ssh/id_ed25519
  sudo -u slopeedit -H bash -c "ssh-keyscan -t ed25519 github.com >> $BASE/home/.ssh/known_hosts 2>/dev/null"
fi
sudo -u slopeedit -H env HOME=$BASE/home git -C $BASE/repo remote set-url origin "git@github.com:${REPO_URL#https://github.com/}"
echo; echo "Deploy key (add with write access under the repo's Settings > Deploy keys, unless already added):"; sudo cat $BASE/home/.ssh/id_ed25519.pub; echo

if [ ! -f $BASE/env ]; then
  sudo tee $BASE/env >/dev/null <<'ENV'
# Dev-mode password: only this scrypt hash is stored anywhere. Make it with
#   printf '%s\n' 'the password' | node /srv/slope-edit/app/server.js --hash
SLOPE_EDIT_PASSWORD_HASH=
# Tokens: the account's daily allowance and the share dev mode may use of it (10%).
SLOPE_EDIT_DAILY_TOKENS=1000000
SLOPE_EDIT_SHARE=0.10
SLOPE_EDIT_JOB_TOKENS=150000
# USD caps apply only when billed by an API key (a subscription login reports no cost).
# ANTHROPIC_API_KEY=
SLOPE_EDIT_JOB_USD=1.5
SLOPE_EDIT_DAILY_USD=5
SLOPE_EDIT_MONTHLY_USD=40
SLOPE_EDIT_MODEL=claude-sonnet-5-5
SLOPE_EDIT_IP_PER_HOUR=6
ENV
  sudo chown root:slopeedit $BASE/env && sudo chmod 0640 $BASE/env
fi

sudo cp "$SRC_DIR/slope-edit.service" /etc/systemd/system/slope-edit.service
sudo systemctl daemon-reload
sudo systemctl enable --now slope-edit
sleep 1; sudo systemctl --no-pager --lines=3 status slope-edit || true
cat <<EOF

Next steps:
1. Password:  printf '%s\n' 'YOUR PASSWORD' | node $BASE/app/server.js --hash
   and put the result into $BASE/env as SLOPE_EDIT_PASSWORD_HASH, then: sudo systemctl restart slope-edit
2. Claude login for the sandbox user (uses the account's subscription; approve the link in any browser):
   sudo -u slopeedit -H env HOME=$BASE/home CLAUDE_CONFIG_DIR=$BASE/home/.claude $BASE/home/.npm-global/bin/claude login
   (or put ANTHROPIC_API_KEY in $BASE/env instead)
3. Public HTTPS endpoint: sudo tailscale funnel --bg 8787   (Funnel must be enabled for the tailnet)
   and set window.SLOPE_EDIT_API in index.html to https://$(hostname).<tailnet>.ts.net
Test:  curl -s http://127.0.0.1:8787/api/status
EOF
