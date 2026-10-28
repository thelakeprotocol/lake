#!/bin/bash
# Runs one exploration scenario (a folder with demo.json and prompts) without video; prints the run folder at the end.
# Usage: explore/go.sh <scenario-folder, relative to demos/>
cd "$(dirname "$0")/.." || exit 1
# The connector must answer before anyone is launched (run 27: five agents met a sandbox still starting up, and all of
# them asked for this check). An MCP initialize, up to five tries a minute apart.
LAKE="${LAKE_SANDBOX:-https://sandbox.lake.doneinfifty.com}"
for i in 1 2 3 4 5; do
  # Signed in as a script would be, when the connector asks for sign-in (no token there: the connector answers 401).
  tok=$(curl -s -m 20 -X POST "$LAKE/mcp/oauth/anonymous" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$LAKE/mcp" ${tok:+-H "authorization: Bearer $tok"} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"preflight","version":"0"}}}')
  [ "$code" = 200 ] && break
  echo "preflight: $LAKE/mcp answered $code; trying again in a minute" >&2
  [ $i = 5 ] && { echo "preflight: the connector isn't answering; not starting the run" >&2; exit 2; }
  sleep 60
done
EXPLORE_DEMO="$PWD/$1" node recorder/run.mjs "$1"
