#!/bin/zsh
# Double-click to start the Gym Ads panel and keep it running (Ctrl+C in this window stops it).
cd "$(dirname "$0")" || exit 1
exec node ui/keep-panel.mjs --open
