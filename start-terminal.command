#!/bin/bash
set -u

cd "$(dirname "$0")"

LOG_FILE="./slv-terminal.log"
ENV_PORT="$(awk -F= '$1=="PORT" {print $2}' .env 2>/dev/null | tail -1)"
APP_PORT="${PORT:-${ENV_PORT:-8788}}"
export PORT="$APP_PORT"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
  NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
else
  echo "Node.js was not found."
  echo "Install Node.js from https://nodejs.org or run: brew install node"
  exit 1
fi

echo "Starting Silver / SLV Play Finder..."
echo "Using Node: $NODE_BIN"
echo "Open this URL after the server starts:"
echo "http://127.0.0.1:$APP_PORT"
echo "Log file: $PWD/$LOG_FILE"
echo

"$NODE_BIN" local_app/setup.mjs
SETUP_STATUS=$?
if [ "$SETUP_STATUS" -ne 0 ]; then
  echo "Setup did not complete. Server not started."
  echo
  read -r -p "Press Enter to close this window..."
  exit "$SETUP_STATUS"
fi

if command -v lsof >/dev/null 2>&1; then
  EXISTING_PIDS="$(lsof -tiTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  for PID in $EXISTING_PIDS; do
    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    if echo "$CMD" | grep -q "local_app/server.mjs"; then
      echo "Stopping old Silver / SLV Play Finder server on port $APP_PORT (PID $PID)..."
      kill "$PID" 2>/dev/null || true
      sleep 1
    fi
  done
fi

(
  sleep 2
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1 || true
  else
    open "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1 || true
  fi
) &

"$NODE_BIN" local_app/server.mjs 2>&1 | tee "$LOG_FILE"
STATUS=${PIPESTATUS[0]}

echo
if [ "$STATUS" -ne 0 ]; then
  echo "Server stopped with exit code $STATUS."
  echo "If you see EADDRINUSE, another copy is already running on port $APP_PORT."
  echo "If you see an OAuth error, copy the last 10 lines from $LOG_FILE."
else
  echo "Server stopped."
fi
echo
read -r -p "Press Enter to close this window..."
