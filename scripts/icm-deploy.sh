#!/usr/bin/env bash
# Deploys the ICM pair: IcmRandomnessAdapter on Fuji (next to the existing RandomnessOracle) and L1AuditSampler on
# the fairpick L1, points each at the other, and funds the adapter with one oracle fee.
# Needs .env with FUJI_KEY (gas on Fuji and on the L1), FUJI_ORACLE and the oracle's public key ORACLE_PK_0..3.
# Appends ICM_ADAPTER and L1_SAMPLER to .env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
FUJI_RPC="${FUJI_RPC:-https://api.avax-test.network/ext/bc/C/rpc}"
L1_RPC="${L1_RPC:-http://127.0.0.1:9650/ext/bc/24ttXXTxYDu7QNNMbdMkmjiZkBB5zYN5qQikNWTr3REqcibFYg/rpc}"
MESSENGER=0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf
FUJI_ID=0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5
L1_ID=0x8c8a1113dc680048a3734fbf97bac7e193d728d299d57884f5dca1888c88199a
: "${FUJI_KEY:?}" "${FUJI_ORACLE:?}" "${ORACLE_PK_0:?}"
[ "$(cast chain-id --rpc-url "$FUJI_RPC")" = 43113 ] || { echo "FUJI_RPC is not Fuji"; exit 1; }
[ "$(cast chain-id --rpc-url "$L1_RPC")" = 510103 ] || { echo "L1_RPC is not the fairpick L1"; exit 1; }

forge build >/dev/null 2>&1
addr() { sed -n 's/^Deployed to: //p'; }
ADAPTER=$(forge create --broadcast --rpc-url "$FUJI_RPC" --private-key "$FUJI_KEY" \
  src/icm/IcmRandomnessAdapter.sol:IcmRandomnessAdapter --constructor-args "$FUJI_ORACLE" "$MESSENGER" "$L1_ID" | addr)
echo "adapter on Fuji: $ADAPTER"
SAMPLER=$(forge create --broadcast --rpc-url "$L1_RPC" --private-key "$FUJI_KEY" \
  src/icm/L1AuditSampler.sol:L1AuditSampler --constructor-args "$MESSENGER" "$FUJI_ID" 43113 "$FUJI_ORACLE" \
  "[$ORACLE_PK_0,$ORACLE_PK_1,$ORACLE_PK_2,$ORACLE_PK_3]" | addr)
echo "sampler on L1: $SAMPLER"
[ -n "$ADAPTER" ] && [ -n "$SAMPLER" ] || exit 1

tx() { cast send --json "$@" | grep -o '"transactionHash":"0x[0-9a-f]*"' | cut -d'"' -f4 | head -1; }
echo "setRemoteSampler (Fuji): $(tx --rpc-url "$FUJI_RPC" --private-key "$FUJI_KEY" "$ADAPTER" 'setRemoteSampler(address)' "$SAMPLER")"
echo "setAdapter (L1): $(tx --rpc-url "$L1_RPC" --private-key "$FUJI_KEY" "$SAMPLER" 'setAdapter(address)' "$ADAPTER")"
FEE=$(cast call --rpc-url "$FUJI_RPC" "$FUJI_ORACLE" 'fee()(uint256)' | awk '{print $1}')
echo "fund adapter with one fee (Fuji): $(tx --rpc-url "$FUJI_RPC" --private-key "$FUJI_KEY" --value "$FEE" "$ADAPTER")"

sed -i.bak '/^ICM_ADAPTER=/d; /^L1_SAMPLER=/d' .env && rm -f .env.bak
printf 'ICM_ADAPTER=%s\nL1_SAMPLER=%s\n' "$ADAPTER" "$SAMPLER" >> .env
echo "https://testnet.snowtrace.io/address/$ADAPTER"
