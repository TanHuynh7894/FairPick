#!/usr/bin/env bash
# Runs the three oracle nodes against the Fuji deployment in .env. Any two of them can answer a request.
# Each is its own process with its own key share and its own gas wallet (.env.node1-3, from fuji-keygen.sh).
# They all run on this machine and talk over 127.0.0.1.
#   ONLY="2 3" ./scripts/fuji-nodes.sh     start just nodes 2 and 3
#   kill $(cat logs/node1.pid)             stop node 1 while the others carry on
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${FUJI_ORACLE:?run ./scripts/fuji-deploy.sh first}" "${ORACLE_THRESHOLD:?run ./scripts/fuji-keygen.sh first}"
export RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
export ORACLE_ADDRESS="$FUJI_ORACLE" POLL_MS="${POLL_MS:-1500}"
# The deployer's key and any old full BLS key are no business of a node.
unset FUJI_KEY ORACLE_BLS_KEY
NODES=$(ls .env.node* | wc -l | tr -d ' ')
BASE_PORT="${BASE_PORT:-8700}"
mkdir -p logs
(cd node && [ -d node_modules ] || npm ci --silent)

PIDS=() LOGS=()
trap 'kill ${PIDS[@]:-} ${TAIL:-} 2>/dev/null || true' EXIT
for i in ${ONLY:-$(seq 1 "$NODES")}; do
  PEERS=$(for j in $(seq 1 "$NODES"); do [ "$j" = "$i" ] || printf 'http://127.0.0.1:%s,' $((BASE_PORT + j)); done)
  (
    set -a; source ".env.node$i"; set +a
    # Node 1 answers at once, node 2 after 4 s, node 3 after 8 s: one answer per request, and a spare if a node is down.
    export ORACLE_PORT=$((BASE_PORT + i)) ORACLE_PEERS="$PEERS" ANSWER_DELAY_MS=$(( (i - 1) * 4000 ))
    export ORACLE_EVIDENCE_FILE="$PWD/logs/partials-node$i.jsonl"
    cd node && exec node --import tsx src/main.ts >> "../logs/node$i.log" 2>&1
  ) &
  PIDS+=($!) LOGS+=("logs/node$i.log")
  echo $! > "logs/node$i.pid"
done
tail -n 0 -q -F "${LOGS[@]}" &
TAIL=$!
# Ends when every node started here has stopped.
wait "${PIDS[@]}"
