#!/usr/bin/env bash
# One audit sample through ICM, both directions, printing every transaction hash.
#   ./scripts/fuji-nodes.sh &                       the oracle nodes must answer on Fuji while this runs
#   ./scripts/icm-audit.sh examples/receipts-clb-sach-quy-3.csv 3 "CLB Sach quy 3"
# Needs .env from ./scripts/icm-deploy.sh (ICM_ADAPTER, L1_SAMPLER), FUJI_KEY (auditor on the L1, gas on Fuji) and
# L1_TREASURER_KEY (the requesting wallet on the L1). Each list can be drawn once per auditor.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=${1:?usage: icm-audit.sh <receipts.csv> <how many to check> <name>} SAMPLE=${2:?} LABEL=${3:?}
set -a; source .env; set +a
cd node && exec npx tsx scripts/icm-audit.ts "../$FILE" "$SAMPLE" "$LABEL"
