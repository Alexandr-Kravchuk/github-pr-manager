#!/bin/bash
# Stops and removes the PR Dashboard launchd service.
LABEL="com.akravchuk.github-pr-manager"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL"
