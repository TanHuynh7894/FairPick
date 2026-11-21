#!/usr/bin/env bash
# Run once, before fuji-deploy.sh. Makes the oracle's BLS key already split 2 of 3, and one wallet per node.
#   .env          FUJI_KEY (yours, a wallet with test AVAX) plus the public values every node needs
#   .env.node1-3  one key share and one wallet key each. Nothing else ever holds them.
# The full key exists only in the memory of this run. It is never printed or written.
set -euo pipefail
cd "$(dirname "$0")/.."
THRESHOLD="${THRESHOLD:-2}" NODES="${NODES:-3}"
[ -e .env.node1 ] && { echo ".env.node1 exists: this would replace the key of a deployed oracle. Move the old files away first."; exit 1; }
touch .env && chmod 600 .env
(cd node && [ -d node_modules ] || npm ci --silent)

KEYS=$(cd node && npx tsx src/keygen.ts --threshold "$THRESHOLD" --nodes "$NODES")
# Public values replace those of an earlier key. A full key from an earlier single-signer setup goes too.
sed -i.bak -E '/^ORACLE_(PK_[0-9]+|THRESHOLD|SHARE_PK_[0-9]+|BLS_KEY)=/d; /^FUJI_NODE_[0-9]+=/d' .env && rm -f .env.bak
echo "$KEYS" | grep -E '^ORACLE_(PK_[0-9]+|THRESHOLD|SHARE_PK_[0-9]+)=' >> .env

for i in $(seq 1 "$NODES"); do
  WALLET=$(cast wallet new --json)
  ADDRESS=$(echo "$WALLET" | sed -n 's/.*"address": *"\([^"]*\)".*/\1/p')
  KEY=$(echo "$WALLET" | sed -n 's/.*"private_key": *"\([^"]*\)".*/\1/p')
  ( umask 077; { echo "ORACLE_SHARE_INDEX=$i"; echo "$KEYS" | grep "^ORACLE_SHARE_$i="; echo "ORACLE_TX_KEY=$KEY"; } > ".env.node$i" )
  echo "FUJI_NODE_$i=$ADDRESS" >> .env
  echo "node $i pays gas from $ADDRESS"
done
echo "next: send each node wallet a little test AVAX, then ./scripts/fuji-deploy.sh"
