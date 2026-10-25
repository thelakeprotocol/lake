#!/usr/bin/env bash
# Two local staging Lakes, federated, built from this checkout (deploy/local/). Sandbox-shaped, so the simulation kit
# targets them like the public sandbox: LAKE_SANDBOX=http://lake-a.localhost:8081 demos/explore/go.sh <scenario>
#
#   scripts/local-lakes.sh build            build the four images from the current checkout (lake-local/*:dev)
#   scripts/local-lakes.sh up [a|b]         start both Lakes (or one)
#   scripts/local-lakes.sh status           both Lakes: node, houses joined, specialists, MCP, what each sees of the other
#   scripts/local-lakes.sh check            cross-Lake check: an agent on A finds, messages, buys from one on B (MCP)
#   scripts/local-lakes.sh logs [a|b] [svc] follow logs
#   scripts/local-lakes.sh down [a|b]       stop (data kept)
#   scripts/local-lakes.sh reset [a|b]      stop and wipe the Lakes' volumes (fresh keys, fresh houses)
#
# Env: LAKE_A_PORT (8081), LAKE_B_PORT (8082), LAKE_TENANTS (4 per Lake), LAKE_PROFILES (e.g. "sponsor,lively").
# A second pair beside the first (another checkout's, say): other names, ports and images, e.g.
#   LAKE_A_ID=c LAKE_B_ID=d LAKE_A_PORT=8083 LAKE_B_PORT=8084 LAKE_TAG=mybranch scripts/local-lakes.sh build|up|check|down
# (Lakes then at http://lake-c.localhost:8083 and http://lake-d.localhost:8084; "a" and "b" on the command line still
# mean the first and the second.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/deploy/local/docker-compose.yml"
A_PORT="${LAKE_A_PORT:-8081}"
B_PORT="${LAKE_B_PORT:-8082}"
A_ID="${LAKE_A_ID:-a}"
B_ID="${LAKE_B_ID:-b}"
export LAKE_TAG="${LAKE_TAG:-dev}"
NET=lake-local

url() { [ "$1" = a ] && echo "http://lake-$A_ID.localhost:$A_PORT" || echo "http://lake-$B_ID.localhost:$B_PORT"; }
compose() {
  local id=$1; shift
  local me port peer peer_port
  if [ "$id" = a ]; then me=$A_ID port=$A_PORT peer=$B_ID peer_port=$B_PORT; else me=$B_ID port=$B_PORT peer=$A_ID peer_port=$A_PORT; fi
  local profiles=()
  for p in ${LAKE_PROFILES:+${LAKE_PROFILES//,/ }}; do profiles+=(--profile "$p"); done
  LAKE_ID=$me LAKE_PORT=$port PEER_ID=$peer PEER_PORT=$peer_port \
    docker compose -p "lake-local-$me" -f "$FILE" ${profiles[@]+"${profiles[@]}"} "$@"
}
which_lakes() { case "${1:-}" in a|b) echo "$1" ;; "") echo "a b" ;; *) echo "unknown Lake '$1' (a or b)" >&2; exit 2 ;; esac; }

cmd="${1:-status}"; shift || true
case "$cmd" in
  build)
    # The same targets CI publishes (.github/workflows/ci.yml), tagged locally; the shared build stage is cached once.
    for t in node:lake-node specialists:lake-specialists house:lake-house cli:lake; do
      echo "== building ${t%%:*} -> lake-local/${t#*:}:$LAKE_TAG"
      docker build --target "${t%%:*}" -t "lake-local/${t#*:}:$LAKE_TAG" "$ROOT"
    done
    ;;
  up)
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    for id in $(which_lakes "${1:-}"); do compose "$id" up -d; done
    echo "Lake A: $(url a)   Lake B: $(url b)   (houses take a minute or two; then: $0 status)"
    ;;
  down)
    for id in $(which_lakes "${1:-}"); do compose "$id" down; done
    ;;
  reset)
    for id in $(which_lakes "${1:-}"); do compose "$id" down -v; done
    ;;
  check)
    node "$ROOT/scripts/local-lakes-check.mjs" "$(url a)" "$(url b)"
    ;;
  logs)
    id="${1:-a}"; shift || true
    compose "$(which_lakes "$id")" logs -f --tail 100 "$@"
    ;;
  status)
    ok=0
    for id in a b; do
      U=$(url "$id"); P=$( [ "$id" = a ] && url b || url a )
      echo "== Lake $( [ "$id" = a ] && echo "${A_ID^^}" || echo "${B_ID^^}" )  $U"
      mcp=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -X POST "$U/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"status","version":"0"}}}' || true)
      node --input-type=module - "$U" "$P" "$mcp" "${LAKE_TENANTS:-4}" <<'EOF' || ok=1
const [U, P, mcp, tenants] = process.argv.slice(2);
const get = async (p) => { try { const r = await fetch(U + p, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); return r.ok ? await r.json() : null; } catch { return null; } };
const health = await get('/health');
const houses = (await get('/t/')) ?? [];
const cards = (await get('/cards?idle=1')) ?? [];
const at = (c) => c.card.supportedInterfaces?.[0]?.url ?? '';
const role = (c) => c.card.capabilities?.extensions?.[0]?.params?.role;
const mine = cards.filter((c) => at(c).startsWith(U)), peers = cards.filter((c) => at(c).startsWith(P));
const count = (xs, r) => xs.filter((c) => role(c) === r).length;
const specialists = mine.filter((c) => at(c).startsWith(`${U}/s/`)).length;
const grocers = mine.filter((c) => at(c).startsWith(`${U}/g/`)).length;
const checks = [
  ['node', !!health?.ok, health ? 'up' : 'not answering'],
  ['houses', houses.length >= Number(tenants) && count(mine, 'house') >= Number(tenants), `${houses.length} hosted, ${count(mine, 'house')} registered with this node`],
  ['specialists', specialists > 0, `${specialists} on the node`],
  ['grocers', grocers > 0, `${grocers} on the node`],
  ['mcp', mcp === '200', `initialize -> ${mcp || 'no answer'}`],
  ['federation', count(peers, 'house') > 0, `sees ${peers.length} of the other Lake's agents (${count(peers, 'house')} houses) via --follow`],
];
for (const [k, good, text] of checks) console.log(`  ${good ? 'ok  ' : 'FAIL'} ${k.padEnd(12)} ${text}`);
const others = cards.length - mine.length - peers.length;
if (others) console.log(`       (${others} more cards at other addresses: ${[...new Set(cards.map(at).filter((u) => !u.startsWith(U) && !u.startsWith(P)).map((u) => new URL(u).host))].join(', ')})`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
EOF
    done
    exit $ok
    ;;
  *)
    sed -n '2,14p' "$0"; exit 2 ;;
esac
