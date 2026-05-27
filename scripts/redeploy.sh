#!/bin/bash
# Rebuilds the app and restarts the launchd service. Run after code changes.
set -e
cd "$(dirname "$0")/.." || exit 1
LABEL="com.akravchuk.github-pr-manager"

echo "Building…"
npm run build

echo "Restarting service…"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Done → http://localhost:3737"
