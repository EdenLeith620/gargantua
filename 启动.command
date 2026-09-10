#!/bin/zsh
# GARGANTUA one-click launcher (macOS)
# Double-click this file in Finder to start the local server and open the page.

cd "$(dirname "$0")" || exit 1

PORT=8137
NODE="/Users/fenglinshen/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "Node.js not found. Install it from https://nodejs.org/ and try again."
  read -r "?Press Enter to close..."
  exit 1
fi

OLD=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "Port $PORT is busy (pid $OLD) - stopping the old instance."
  kill $OLD 2>/dev/null
  sleep 1
fi

echo "GARGANTUA"
echo "  folder : $(pwd)"
echo "  url    : http://127.0.0.1:$PORT/index.html"
echo "  close  : press Ctrl+C in this window, or just close it"
echo

"$NODE" scripts/serve.mjs $PORT . &
SERVER_PID=$!

sleep 1
open "http://127.0.0.1:$PORT/index.html"

wait $SERVER_PID
