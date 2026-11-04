#!/bin/bash
# launchd entry point for slope-edit on macOS (launchd has no EnvironmentFile).
# Loads KEY=VALUE lines from the root-owned env file literally (no shell expansion: the
# scrypt hash contains '$'), then runs the server. Installed by edit-server/setup-mac.sh.
BASE="${SLOPE_EDIT_BASE:-/opt/slope-edit}"
while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"; fi
done < "$BASE/env"
export HOME="$BASE/home"
export SLOPE_EDIT_REPO="$BASE/repo" SLOPE_EDIT_DATA="$BASE/data"
export SLOPE_EDIT_CLAUDE="$BASE/home/.npm-global/bin/claude" SLOPE_EDIT_CLAUDE_CONFIG="$BASE/home/.claude"
export SLOPE_EDIT_SETTINGS="$BASE/app/claude-settings.json" SLOPE_EDIT_SMOKE_PYTHON="$BASE/home/venv/bin/python"
export PLAYWRIGHT_BROWSERS_PATH="$BASE/home/.cache/ms-playwright"
export PATH="$BASE/home/venv/bin:$BASE/home/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
umask 077
cd "$BASE" && exec /opt/homebrew/bin/node "$BASE/app/server.js"
