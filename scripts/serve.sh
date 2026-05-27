#!/bin/bash
# Runs the PR Dashboard in production mode.
# Used by the launchd service (com.akravchuk.github-pr-manager) and can also
# be run manually. Requires a production build first: `npm run build`.
cd "$(dirname "$0")/.." || exit 1
export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-3737}"
# `exec` so the launchd-managed process IS node (clean SIGTERM handling).
exec node node_modules/next/dist/bin/next start -p "$PORT"
