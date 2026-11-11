#!/usr/bin/env bash
# Starts Johnny Music and restarts it automatically if it ever crashes.
cd "$(dirname "$0")" || exit 1
while true; do
  node index.js
  echo "[run-forever] Johnny Music stopped (exit code $?). Restarting in 5 seconds... press Ctrl+C to stop for good."
  sleep 5
done
