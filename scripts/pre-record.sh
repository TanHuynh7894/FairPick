#!/usr/bin/env bash
# Run before recording on Fuji. Checks what each one-shot beat needs, restages it, and says what is wrong.
#   ./scripts/pre-record.sh                                                        stage "CLB Sách · quý 3"
#   LIST=examples/receipts-quy-tu-thien-am-ap-dot-3.csv ./scripts/pre-record.sh    after a take used the first list up
#   ./scripts/pre-record.sh --clean                                                after recording: take the test keys out again
# Needs .env (the deployment and FUJI_KEY) and .env.demo (TREASURER_KEY, AUDITOR_KEY: Fuji test wallets).
# The two test keys are copied into dashboard/.env.local (mode 600, git-ignored) as VITE_TEST_KEYS, for the local dev
# server only: the page reads them only in dev, and `npm run build` refuses to run while they are set.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = --clean ]; then
  sed -i.bak '/^VITE_TEST_KEYS=/d' dashboard/.env.local && rm -f dashboard/.env.local.bak
  echo "removed VITE_TEST_KEYS from dashboard/.env.local. Restart the dev server."
  exit 0
fi
set -a; source .env; source .env.demo; set +a
RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
LIST="${LIST:-examples/receipts-clb-sach-quy-3.csv}" SAMPLE="${SAMPLE:-3}"
TREASURER=$(cast wallet address "$TREASURER_KEY") AUDITOR=$(cast wallet address "$AUDITOR_KEY") OPERATOR=$(cast wallet address "$FUJI_KEY")
call() { cast call --rpc-url "$RPC_URL" "$@"; }
wei() { cast balance --rpc-url "$RPC_URL" "$1"; }
ok() { echo "ok    $*"; }
bad() { echo "FIX   $*"; FAILED=1; }
FAILED=0
FEE=$(call "$FUJI_ORACLE" 'fee()(uint256)' | awk '{print $1}')

# 1. The three nodes answer on their ports. A node that is up says 404 for an answer it does not have.
for i in 1 2 3; do
  CODE=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$((8700 + i))/evidence/0" || true)
  [ "$CODE" = 404 ] && ok "node $i is up" || bad "node $i is not answering on :$((8700 + i)). Start ./scripts/fuji-nodes.sh"
done

# 2. Gas money. One answer costs about 0.000000000037 AVAX on Fuji, so any balance above a few thousand gwei is plenty.
for i in 1 2 3; do
  NODE=$(eval echo "\$FUJI_NODE_$i")
  [ "$(wei "$NODE")" -gt 100000000000000 ] && ok "node $i wallet $(cast balance --ether --rpc-url "$RPC_URL" "$NODE") AVAX" || bad "node $i wallet $NODE is low"
done
[ "$(wei "$AUDITOR")" -gt 100000000000000 ] && ok "auditor wallet $(cast balance --ether --rpc-url "$RPC_URL" "$AUDITOR") AVAX" || bad "auditor wallet $AUDITOR is low"

# 3. The treasurer needs the fee for one audit. Fees of earlier takes sit in the oracle until withdraw() pays the operator.
NEED=$((FEE + 1000000000000000))
if [ "$(wei "$TREASURER")" -lt "$NEED" ]; then
  [ "$(call "$FUJI_ORACLE" 'earned()(uint256)' | awk '{print $1}')" -gt 0 ] && cast send --rpc-url "$RPC_URL" --private-key "$FUJI_KEY" "$FUJI_ORACLE" 'withdraw()' >/dev/null
  TOPUP=$((NEED - $(wei "$TREASURER")))
  if [ "$(wei "$OPERATOR")" -gt $((TOPUP + 1000000000000000)) ]; then
    cast send --rpc-url "$RPC_URL" --private-key "$FUJI_KEY" --value "$TOPUP" "$TREASURER" >/dev/null && ok "topped the treasurer up from the operator wallet"
  else
    bad "treasurer $TREASURER has less than one fee, and the operator wallet cannot cover it"
  fi
fi
ok "treasurer wallet $(cast balance --ether --rpc-url "$RPC_URL" "$TREASURER") AVAX, fee $(cast from-wei "$FEE") AVAX"

# 4. The list for the request beat: announced by the auditor for the treasurer, and not drawn yet.
DESCRIBED=$(cd node && npx tsx scripts/list-hash.ts "../$LIST")
HASH=$(echo "$DESCRIBED" | awk '/^file hash/ {print $3}') COUNT=$(echo "$DESCRIBED" | awk '/^receipts/ {print $2}')
KEY=$(call "$FUJI_SAMPLER" 'listKey(address,bytes32)(bytes32)' "$AUDITOR" "$HASH")
DRAWN=$(call "$FUJI_SAMPLER" 'auditOfList(bytes32)(uint256)' "$KEY" | awk '{print $1}')
NAMED=$(call "$FUJI_SAMPLER" 'announcements(address,bytes32)(address,uint32,uint16)' "$AUDITOR" "$HASH" | head -1)
if [ "$DRAWN" != 0 ]; then
  bad "$LIST was already drawn (audit #$DRAWN). Stage another list: LIST=examples/receipts-quy-tu-thien-am-ap-dot-3.csv $0"
elif [ "$NAMED" = 0x0000000000000000000000000000000000000000 ]; then
  cast send --rpc-url "$RPC_URL" --private-key "$AUDITOR_KEY" "$FUJI_SAMPLER" 'announce(bytes32,uint32,uint16,address)' "$HASH" "$COUNT" "$SAMPLE" "$TREASURER" >/dev/null
  ok "auditor announced $LIST ($SAMPLE of $COUNT) for the treasurer"
else
  ok "$LIST is announced and not drawn yet"
fi

# 5. The page signs with the two test keys, so no wallet popup appears, and knows the auditor and the nodes.
ENV=dashboard/.env.local
touch "$ENV" && chmod 600 "$ENV"
sed -i.bak '/^VITE_TEST_KEYS=/d; /^VITE_AUDITOR=/d; /^VITE_NODE_URLS=/d' "$ENV" && rm -f "$ENV.bak"
{
  echo "VITE_NODE_URLS=http://127.0.0.1:8701,http://127.0.0.1:8702,http://127.0.0.1:8703"
  echo "VITE_AUDITOR=$AUDITOR"
  echo "VITE_TEST_KEYS=treasurer:$TREASURER_KEY,auditor:$AUDITOR_KEY"
} >> "$ENV"
ok "dashboard/.env.local has the test keys, the auditor and the node addresses. Restart the dev server if it was running."

echo "after recording: $0 --clean removes the test keys from dashboard/.env.local"
[ "$FAILED" = 0 ] && echo "ready to record" || { echo "not ready"; exit 1; }
