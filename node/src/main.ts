import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPublicClient, http, parseGwei, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicKey, type G2Words } from './bls';
import { createOracleNode, ORACLE_ABI } from './oracle-node';
import { keySigner, thresholdSigner, type Signer } from './signer';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
// Several nodes may write to one terminal, so each line says which one it is.
const tag = process.env.ORACLE_SHARE_INDEX ? `[node ${process.env.ORACLE_SHARE_INDEX}] ` : '';
const log = (message: string) => console.log(`${tag}${new Date().toISOString()}`, message);

const client = createPublicClient({ transport: http(env('RPC_URL'), { timeout: 8_000 }) });
const oracle = env('ORACLE_ADDRESS') as Address;
const account = privateKeyToAccount(env('ORACLE_TX_KEY') as Hex);
const read = { address: oracle, abi: ORACLE_ABI } as const;

// One share of a key split across nodes (ORACLE_SHARE_INDEX and ORACLE_SHARE_<index>), or else one full key
// (ORACLE_BLS_KEY). Which of the two the oracle expects, and every share's public key, is read from the contract.
const deployedThreshold = await client.readContract({ ...read, functionName: 'threshold' });
let signer: Signer;
if (!process.env.ORACLE_SHARE_INDEX) {
  if (deployedThreshold !== 1) throw new Error(`This oracle was deployed with a key split ${deployedThreshold} ways. Start the node with a key share, not a full key.`);
  signer = keySigner(BigInt(env('ORACLE_BLS_KEY')));
  log('holding the full key: one signer, no threshold');
} else {
  const index = Number(env('ORACLE_SHARE_INDEX'));
  const share = { index, key: BigInt(env(`ORACLE_SHARE_${index}`)) };
  const count = Number(await client.readContract({ ...read, functionName: 'shareCount' }));
  if (deployedThreshold < 2 || index < 1 || index > count) throw new Error('This oracle was not deployed with a key share of this index.');
  const shareKeys: Record<number, G2Words> = {};
  for (let i = 1; i <= count; i++) shareKeys[i] = (await client.readContract({ ...read, functionName: 'shareKey', args: [BigInt(i)] })) as unknown as G2Words;
  if (publicKey(share.key).some((word, i) => word !== shareKeys[index][i])) throw new Error(`This is not share ${index} of the key this oracle was deployed with.`);
  const ts = thresholdSigner({
    share,
    threshold: deployedThreshold,
    groupKey: (await client.readContract({ ...read, functionName: 'publicKey' })) as unknown as G2Words,
    shareKeys,
    peers: (process.env.ORACLE_PEERS ?? '').split(',').filter(Boolean),
    // One JSON line per answer this node put together: which shares signed, and their partial signatures.
    onCombined: process.env.ORACLE_EVIDENCE_FILE
      ? (e) => appendFileSync(process.env.ORACLE_EVIDENCE_FILE!, `${JSON.stringify({
          requestId: e.requestId.toString(),
          partials: e.partials.map((p) => ({ index: p.index, signature: p.signature.map((v) => toHex(v, { size: 32 })) })),
        })}\n`)
      : undefined,
    log,
  });
  signer = ts;
  // Peers ask for this node's partial signature of a request it has itself seen pending on chain.
  const port = Number(env('ORACLE_PORT'));
  const json = (p: { index: number; signature: readonly bigint[] }) => ({ index: p.index, signature: p.signature.map((v) => toHex(v, { size: 32 })) });
  createServer((req, res) => {
    // What the page shows as "signed by shares 1 + 2": partial signatures of an answer, public once it is on chain.
    const evidence = /^\/evidence\/(\d+)$/.exec(req.url ?? '');
    if (evidence) {
      const partials = ts.evidenceFor(BigInt(evidence[1]));
      res.writeHead(partials ? 200 : 404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        .end(partials ? JSON.stringify({ requestId: evidence[1], partials: partials.map(json) }) : '{}');
      return;
    }
    const m = /^\/partial\/(\d+)$/.exec(req.url ?? '');
    const partial = m ? ts.partialFor(BigInt(m[1])) : undefined;
    if (!partial) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json(partial)));
  }).listen(port, process.env.ORACLE_HOST ?? '127.0.0.1', () => log(`holding share ${index} of the oracle's ${deployedThreshold}-of-${count} key, serving partial signatures on :${port}`));
}

// The spending limit of this node: it never offers more for one answer than the oracle earns for it.
// No model or rule engine decides anything here: a request that verifies is answered, at a price under the caps.
const fee = await client.readContract({ ...read, functionName: 'fee' });
const maxCostPerAnswer = process.env.MAX_ANSWER_COST_WEI ? BigInt(process.env.MAX_ANSWER_COST_WEI) : fee > 0n ? fee : undefined;
log(`tx wallet ${account.address}, at most ${maxCostPerAnswer ?? 'no limit'} wei per answer and ${env('MAX_FEE_GWEI', '500')} gwei per gas`);
const node = createOracleNode({
  client,
  account,
  chainId: await client.getChainId(),
  oracle,
  signer,
  maxCostPerAnswer,
  answerDelayMs: Number(env('ANSWER_DELAY_MS', '0')),
  stuckAfterMs: Number(env('STUCK_MS', '30000')),
  maxFeePerGasCap: parseGwei(env('MAX_FEE_GWEI', '500')),
  log,
});
const pollMs = Number(env('POLL_MS', '2000'));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await node.assertKeyMatches();
for (;;) {
  try {
    await node.reconcile();
    break;
  } catch (e) {
    console.error(`${tag}${new Date().toISOString()}`, 'reconcile failed:', (e as Error).message.split('\n')[0]);
    await sleep(pollMs);
  }
}
log('oracle node running');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => (stopping = true));

while (!stopping) {
  try {
    await node.tick();
  } catch (e) {
    // Usually an RPC hiccup. Everything is read back from the chain on the next tick.
    console.error(`${tag}${new Date().toISOString()}`, 'tick failed:', (e as Error).message.split('\n')[0]);
  }
  await sleep(pollMs);
}
process.exit(0);
