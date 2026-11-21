#!/usr/bin/env bash
# The fairpick L1's transaction allow-list, end to end, printing every hash and refusal:
#   1. an outsider's audit request is refused by the node; the audit office admin (FUJI_KEY) enables a new treasurer
#   2. that treasurer files an audit, which goes to the oracle on Fuji over ICM and comes back (scripts/icm-audit.sh)
#   3. the admin offboards the treasurer; its next transaction is refused
#   ./scripts/fuji-nodes.sh &       the oracle nodes must answer on Fuji while step 2 runs
#   OUTSIDER_KEY=0x… ./scripts/l1-permissions.sh [receipts.csv] [how many] [name]
# Needs .env with FUJI_KEY, L1_SAMPLER, ICM_ADAPTER, FUJI_ORACLE. The new treasurer's key is appended to .env.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=${1:-examples/receipts-clb-bong-ro-mua-giai-2026.csv} SAMPLE=${2:-3} LABEL=${3:-CLB Bong ro mua giai 2026}
: "${OUTSIDER_KEY:?set OUTSIDER_KEY to a wallet that is not on the allow-list}"
set -a; source .env; set +a
(cd node && npx tsx scripts/l1-permissions.ts onboard)
set -a; source .env; set +a   # picks up L1_MEMBER_KEY
(cd node && L1_TREASURER_KEY=$L1_MEMBER_KEY npx tsx scripts/icm-audit.ts "../$FILE" "$SAMPLE" "$LABEL")
(cd node && npx tsx scripts/l1-permissions.ts offboard)
