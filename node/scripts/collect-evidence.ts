// Turns what the nodes wrote while running (scripts/fuji-nodes.sh) into one evidence file per answer.
//   npm run collect-evidence -- ../logs ../docs/evidence 0x<oracle>
// Each file names the oracle, the request, the answer's transaction and the partial signatures that made it up.
// It holds no key: check-partials reads the keys from the oracle contract.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [logs, out, oracle] = process.argv.slice(2);
if (!logs || !out || !oracle) throw new Error('usage: collect-evidence <logs dir> <output dir> <oracle address>');

// "sent nonce 4 for request 1: 0x..." is the line a node writes when it submits an answer.
const sent = new Map<string, string>();
for (const file of readdirSync(logs).filter((f) => /^node\d+\.log$/.test(f))) {
  for (const m of readFileSync(join(logs, file), 'utf8').matchAll(/sent nonce \d+ for request (\d+): (0x[0-9a-f]{64})/g)) sent.set(m[1], m[2]);
}

mkdirSync(out, { recursive: true });
const written = new Set<string>();
for (const file of readdirSync(logs).filter((f) => /^partials-node\d+\.jsonl$/.test(f))) {
  for (const line of readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)) {
    const { requestId, partials } = JSON.parse(line) as { requestId: string; partials: unknown };
    const answerTx = sent.get(requestId);
    // Two nodes can put the same answer together. One file per request is enough.
    if (!answerTx || written.has(requestId)) continue;
    written.add(requestId);
    writeFileSync(join(out, `audit-${requestId}.json`), `${JSON.stringify({ oracle, requestId, answerTx, partials }, null, 2)}\n`);
    console.log(`audit-${requestId}.json  ${answerTx}`);
  }
}
