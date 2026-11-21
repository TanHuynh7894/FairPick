#!/usr/bin/env bash
# Local demo: starts a chain, deploys the oracle and the audit sampler, runs one node and asks for three audits.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8601}"
RPC_URL="http://127.0.0.1:$PORT"
# Public anvil test accounts. Never use these anywhere else.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export ORACLE_TX_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export ORACLE_OPERATOR=$(cast wallet address "$ORACLE_TX_KEY")
export ORACLE_FEE=10000000000000000
export RPC_URL POLL_MS=300

cleanup() { kill ${NODE_PID:-} ${ANVIL_PID:-} 2>/dev/null || true; }
trap cleanup EXIT

anvil --port "$PORT" --block-time 1 --silent &
ANVIL_PID=$!
until cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 0.1; done

(cd node && [ -d node_modules ] || npm ci --silent)
eval "$(cd node && npx tsx src/keygen.ts | sed 's/^/export /')"

# One node with the whole key. Said explicitly, because forge also reads a .env left by a Fuji deployment.
export ORACLE_THRESHOLD=1
OUTPUT=$(forge script script/DeployOracle.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast 2>&1) || { echo "$OUTPUT"; exit 1; }
export ORACLE_ADDRESS=$(echo "$OUTPUT" | sed -n 's/.*ORACLE_ADDRESS=//p' | head -1)
SAMPLER=$(echo "$OUTPUT" | sed -n 's/.*SAMPLER_ADDRESS=//p' | head -1)
echo "oracle $ORACLE_ADDRESS"
echo "sampler $SAMPLER"

(cd node && exec npx tsx src/main.ts) &
NODE_PID=$!

# The hash is taken over the canonical bytes, as the page does: no byte-order mark, LF line ends, no trailing newline.
list_hash() { cast keccak "0x$(perl -0777 -pe 's/^\xEF\xBB\xBF//; s/\r\n?/\n/g; s/\n+\z//' "$1" | xxd -p | tr -d '\n')"; }
LISTS=(examples/receipts-clb-tinh-nguyen-q3-2026.csv examples/receipts-quy-lop-k66-thang-10.csv examples/receipts-doan-khoa-cntt-hoi-trai.csv)
COUNTS=(40 24 30)
# Anvil's third and fourth accounts play auditor and stranger. The deployer is the treasurer.
AUDITOR_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
STRANGER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
AUDITOR=$(cast wallet address "$AUDITOR_KEY") TREASURER=$(cast wallet address "$DEPLOYER_KEY")
send() { local key=$1; shift; cast send --rpc-url "$RPC_URL" --private-key "$key" "$SAMPLER" "$@"; }
for i in 0 1 2; do
  HASH=$(list_hash "${LISTS[$i]}")
  send "$AUDITOR_KEY" 'announce(bytes32,uint32,uint16,address)' "$HASH" "${COUNTS[$i]}" 3 "$TREASURER" >/dev/null
  send "$DEPLOYER_KEY" --value "$ORACLE_FEE" 'requestAudit(bytes32,address,string)' "$HASH" "$AUDITOR" "demo list $((i + 1))" >/dev/null
  ID=$(cast call --rpc-url "$RPC_URL" "$ORACLE_ADDRESS" 'requestCount()(uint256)')
  echo "audit $((i + 1)): announced by the auditor, request $ID sent for ${LISTS[$i]}"
  PICKS=""
  for _ in $(seq 1 60); do
    PICKS=$(cast call --rpc-url "$RPC_URL" "$SAMPLER" 'sampleOf(uint256)(uint32[])' "$ID" 2>/dev/null || true)
    [ -n "$PICKS" ] && break
    sleep 0.5
  done
  [ -n "$PICKS" ] || { echo "no answer for request $ID"; exit 1; }
  echo "audit $((i + 1)): check receipts $PICKS"
done
FIRST=$(list_hash "${LISTS[0]}")
# One draw per announcement: the treasurer asking again is refused.
if send "$DEPLOYER_KEY" --value "$ORACLE_FEE" 'requestAudit(bytes32,address,string)' "$FIRST" "$AUDITOR" "again" >/dev/null 2>&1; then echo "a second draw went through"; exit 1; fi
echo "second request by the treasurer: refused (AlreadyAudited)"
# A stranger who knows the hash cannot take the draw of a list announced for somebody else.
LAST=$(list_hash examples/receipts-clb-guitar-hoc-ky-1.csv)
send "$AUDITOR_KEY" 'announce(bytes32,uint32,uint16,address)' "$LAST" 18 3 "$TREASURER" >/dev/null
if send "$STRANGER_KEY" --value "$ORACLE_FEE" 'requestAudit(bytes32,address,string)' "$LAST" "$AUDITOR" "squat" >/dev/null 2>&1; then echo "a stranger drew the list"; exit 1; fi
echo "request by a stranger for an announced list: refused (NotAnnounced)"
