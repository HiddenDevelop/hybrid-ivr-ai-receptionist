#!/usr/bin/env bash
# Start the speech sidecar, wait until it's healthy, then start the Node
# orchestrator. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SPEECH_PORT="${SPEECH_PORT:-8081}"

echo "starting speech sidecar on 127.0.0.1:${SPEECH_PORT}..."
(cd speech && ../.venv/bin/python app.py) &
SIDECAR_PID=$!
trap 'kill "$SIDECAR_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${SPEECH_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    echo "sidecar exited during startup" >&2
    exit 1
  fi
  sleep 1
done

node src/server/index.js
