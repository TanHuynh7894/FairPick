#!/usr/bin/env bash
# Reads the fairpick L1 (local RPC) and writes dashboard/src/l1-audits.json for the page's "From L1" view.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
cd node && exec npx tsx scripts/l1-export.ts
