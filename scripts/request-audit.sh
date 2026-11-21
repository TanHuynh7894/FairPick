#!/usr/bin/env bash
# Announces a receipt list as auditor, then requests its draw as treasurer, and waits for the pick.
#   AUDITOR_KEY=0x... REQUESTER_KEY=0x... ./scripts/request-audit.sh examples/receipts-quy-lop-k66-thang-10.csv 3 "Quỹ lớp K66 · tháng 10"
# Without AUDITOR_KEY the requester announces the list itself, and the audit is marked as having no separate auditor.
# Uses the Fuji deployment in .env unless SAMPLER and RPC_URL say otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=${1:?usage: request-audit.sh <receipts.csv> <how many to audit> <name>} SAMPLE=${2:?} LABEL=${3:?}
[ -f .env ] && { set -a; source .env; set +a; }
RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
SAMPLER="${SAMPLER:-${FUJI_SAMPLER:?set SAMPLER or deploy first}}"
: "${REQUESTER_KEY:?set REQUESTER_KEY to the key of the wallet that requests}"

# The same hash and count the page computes: byte-order mark, CRLF and trailing newlines do not count.
DESCRIBED=$(cd node && npx tsx scripts/list-hash.ts "../$FILE")
HASH=$(echo "$DESCRIBED" | awk '/^file hash/ {print $3}')
COUNT=$(echo "$DESCRIBED" | awk '/^receipts/ {print $2}')
ORACLE=$(cast call --rpc-url "$RPC_URL" "$SAMPLER" 'oracle()(address)')
FEE=$(cast call --rpc-url "$RPC_URL" "$ORACLE" 'fee()(uint256)' | awk '{print $1}')
REQUESTER=$(cast wallet address "$REQUESTER_KEY")
AUDITOR_KEY="${AUDITOR_KEY:-$REQUESTER_KEY}"
AUDITOR=$(cast wallet address "$AUDITOR_KEY")
echo "list $HASH, $COUNT receipts, audit $SAMPLE; auditor $AUDITOR, requester $REQUESTER"

ANNOUNCED=$(cast call --rpc-url "$RPC_URL" "$SAMPLER" 'announcements(address,bytes32)(address,uint32,uint16)' "$AUDITOR" "$HASH" | head -1)
if [ "$ANNOUNCED" = 0x0000000000000000000000000000000000000000 ]; then
  cast send --rpc-url "$RPC_URL" --private-key "$AUDITOR_KEY" "$SAMPLER" 'announce(bytes32,uint32,uint16,address)' "$HASH" "$COUNT" "$SAMPLE" "$REQUESTER" >/dev/null
  echo "announced by the auditor"
fi
RECEIPT=$(cast send --rpc-url "$RPC_URL" --private-key "$REQUESTER_KEY" --value "$FEE" --json "$SAMPLER" 'requestAudit(bytes32,address,string)' "$HASH" "$AUDITOR" "$LABEL")
TX=$(echo "$RECEIPT" | grep -o '"transactionHash":"0x[0-9a-f]*"' | head -1 | cut -d'"' -f4)
ID=$(cast call --rpc-url "$RPC_URL" "$SAMPLER" 'auditOfList(bytes32)(uint256)' "$(cast call --rpc-url "$RPC_URL" "$SAMPLER" 'listKey(address,bytes32)(bytes32)' "$AUDITOR" "$HASH")" | awk '{print $1}')
echo "audit $ID requested in $TX"
for _ in $(seq 1 120); do
  PICKS=$(cast call --rpc-url "$RPC_URL" "$SAMPLER" 'sampleOf(uint256)(uint32[])' "$ID" 2>/dev/null || true)
  [ -n "$PICKS" ] && { echo "audit $ID: check receipts $PICKS (in draw order)"; exit 0; }
  sleep 1
done
echo "no answer yet for audit $ID. Are the nodes running?"; exit 1
