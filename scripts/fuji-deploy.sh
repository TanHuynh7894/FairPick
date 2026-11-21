#!/usr/bin/env bash
# Deploys the oracle, the audit sampler and the group-pick beacon to Fuji, then points the dashboard at them.
# Needs .env with FUJI_KEY (a wallet holding test AVAX) and the oracle's public key (./scripts/fuji-keygen.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
set -a; source .env; set +a
: "${FUJI_KEY:?add FUJI_KEY to .env}" "${ORACLE_PK_0:?run ./scripts/fuji-keygen.sh first}"

FROM=$(cast wallet address "$FUJI_KEY")
[ "$(cast chain-id --rpc-url "$RPC_URL")" = 43113 ] || { echo "RPC is not Fuji"; exit 1; }
echo "deployer $FROM, balance $(cast balance --ether "$FROM" --rpc-url "$RPC_URL") AVAX"

# The operator only receives fees. It defaults to the deployer and cannot be changed later.
# The oracle also stores ORACLE_THRESHOLD and the share public keys from .env, and refuses a set that is not a split
# of its public key.
export ORACLE_OPERATOR="${ORACLE_OPERATOR:-$FROM}" ORACLE_FEE="${ORACLE_FEE:-10000000000000000}"
OUT=$(forge script script/DeployOracle.s.sol --rpc-url "$RPC_URL" --private-key "$FUJI_KEY" --broadcast 2>&1)
ORACLE=$(echo "$OUT" | sed -n 's/.*ORACLE_ADDRESS=//p' | head -1)
SAMPLER=$(echo "$OUT" | sed -n 's/.*SAMPLER_ADDRESS=//p' | head -1)
# KEEP_BEACON=1 leaves the group-pick contract of an earlier deployment in place: it does not depend on the oracle.
if [ "${KEEP_BEACON:-}" = 1 ] && [ -n "${FUJI_BEACON:-}" ]; then
  BEACON=$FUJI_BEACON
else
  BEACON=$(forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$FUJI_KEY" --broadcast 2>&1 \
    | sed -n 's/.*RandomnessBeacon: *//p' | head -1)
fi
[ -n "$ORACLE" ] && [ -n "$SAMPLER" ] && [ -n "$BEACON" ] || { echo "$OUT"; exit 1; }

# Keep the addresses next to the keys, replacing an earlier deployment.
sed -i.bak '/^FUJI_ORACLE=/d; /^FUJI_SAMPLER=/d; /^FUJI_BEACON=/d' .env && rm -f .env.bak
printf 'FUJI_ORACLE=%s\nFUJI_SAMPLER=%s\nFUJI_BEACON=%s\n' "$ORACLE" "$SAMPLER" "$BEACON" >> .env
cat > dashboard/.env.local <<ENV
VITE_RPC_URL=$RPC_URL
VITE_ORACLE_ADDRESS=$ORACLE
VITE_SAMPLER_ADDRESS=$SAMPLER
VITE_BEACON_ADDRESS=$BEACON
# The nodes on this machine. The page asks them which key shares signed an answer.
VITE_NODE_URLS=http://127.0.0.1:8701,http://127.0.0.1:8702,http://127.0.0.1:8703
ENV

echo "oracle $ORACLE"
echo "sampler $SAMPLER"
echo "beacon $BEACON"
echo "https://testnet.snowtrace.io/address/$ORACLE"
echo "next: ./scripts/fuji-nodes.sh, then (cd dashboard && npm run dev)"
