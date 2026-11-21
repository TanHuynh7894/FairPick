// One audit sample over ICM, end to end, printing every transaction hash:
//   L1: auditor announces the list, treasurer requests  -> ICM -> Fuji: adapter files the request with the oracle
//   Fuji: oracle nodes answer (they must be running)     -> anyone forwards the signature -> ICM -> L1: checked, sample stored
// Run through ../scripts/icm-audit.sh, which loads .env. Arguments: <receipts.csv> <how many to check> <name>.
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import { describeList } from '../src/list';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};
const [file, sizeArg, label] = process.argv.slice(2);
if (!file || !sizeArg || !label) throw new Error('usage: icm-audit <receipts.csv> <how many to check> <name>');

const MESSENGER = '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf' as Address;
const fairpick = defineChain({
  id: 510103,
  name: 'fairpick',
  nativeCurrency: { name: 'FPK', symbol: 'FPK', decimals: 18 },
  rpcUrls: { default: { http: [env('L1_RPC', 'http://127.0.0.1:9650/ext/bc/24ttXXTxYDu7QNNMbdMkmjiZkBB5zYN5qQikNWTr3REqcibFYg/rpc')] } },
});
const fuji = createPublicClient({ chain: avalancheFuji, transport: http(env('FUJI_RPC', 'https://api.avax-test.network/ext/bc/C/rpc')) });
const l1 = createPublicClient({ chain: fairpick, transport: http() });
const auditor = privateKeyToAccount(env('FUJI_KEY') as Hex); // auditor on the L1, funder and forwarder on Fuji
const treasurer = privateKeyToAccount(env('L1_TREASURER_KEY') as Hex);
const fujiWallet = createWalletClient({ chain: avalancheFuji, transport: http(fuji.transport.url), account: auditor });
const l1Auditor = createWalletClient({ chain: fairpick, transport: http(), account: auditor });
const l1Treasurer = createWalletClient({ chain: fairpick, transport: http(), account: treasurer });
const adapter = env('ICM_ADAPTER') as Address;
const sampler = env('L1_SAMPLER') as Address;
const oracle = env('FUJI_ORACLE') as Address;

const samplerAbi = parseAbi([
  'function announce(bytes32 fileHash, uint32 itemCount, uint16 sampleSize, address requester)',
  'function requestAudit(bytes32 fileHash, address auditor, string label) returns (uint256)',
  'function announcements(address, bytes32) view returns (address requester, uint32 itemCount, uint16 sampleSize)',
  'function auditCount() view returns (uint256)',
  'function sampleOf(uint256) view returns (uint32[])',
  'event AuditRequested(uint256 indexed auditId, address indexed requester, bytes32 indexed fileHash, address auditor, bytes32 messageID)',
  'event AuditPicked(uint256 indexed auditId, uint256 indexed oracleRequestId, uint256 seed, bytes32 requestBlockHash, uint32[] picks)',
]);
const adapterAbi = parseAbi([
  'function requestOfRemoteAudit(uint256) view returns (uint256)',
  'function forward(uint256 requestId, uint256[2] signature) returns (bytes32)',
  'event AnswerForwarded(uint256 indexed remoteAuditId, uint256 indexed oracleRequestId, bytes32 messageID)',
]);
const oracleAbi = parseAbi([
  'function fee() view returns (uint256)',
  'function earned() view returns (uint256)',
  'function withdraw()',
  'function statusOf(uint256) view returns (uint8)',
  'function fulfill(uint256 requestId, uint256[2] signature)',
  'event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackOk)',
]);
const fulfilledEvent = oracleAbi.find((x) => x.type === 'event' && x.name === 'RandomnessFulfilled')!;
const messengerAbi = parseAbi(['event MessageExecuted(bytes32 indexed messageID, bytes32 indexed sourceBlockchainID)']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${s}`);
/** How long to wait for each ICM delivery. ICM_WAIT_S raises it when the relayer is known to be catching up. */
const ICM_WAIT_S = Number(process.env.ICM_WAIT_S ?? 300);
async function until<T>(what: string, f: () => Promise<T | undefined>, timeoutS = ICM_WAIT_S): Promise<T> {
  for (const end = Date.now() + timeoutS * 1000; Date.now() < end; await sleep(2000)) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function mined(client: PublicClient, hash: Hash) {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`);
  return r;
}
/** The tx in which `messenger` executed `messageID`, searched from `from` in steps public RPCs accept. */
async function executedIn(client: PublicClient, messageID: Hex, from: bigint): Promise<Hash | undefined> {
  const head = await client.getBlockNumber();
  for (let start = from; start <= head; start += 100n) {
    const logs = await client.getLogs({
      address: MESSENGER, event: messengerAbi[0], args: { messageID }, fromBlock: start, toBlock: start + 99n > head ? head : start + 99n,
    });
    if (logs.length) return logs[0].transactionHash;
  }
  return undefined;
}

const list = describeList(readFileSync(file, 'utf8'));
const fileHash = list.fileHash as Hex;
const size = Number(sizeArg);
log(`list ${fileHash}, ${list.itemCount} receipts, check ${size}; auditor ${auditor.address}, treasurer ${treasurer.address}`);

const fujiStart = await fuji.getBlockNumber();
const l1Start = await l1.getBlockNumber();
const hashes: Record<string, string> = {};

// 0. The adapter pays the oracle fee. Fees earned by answered requests go back to the operator first.
const fee = await fuji.readContract({ address: oracle, abi: oracleAbi, functionName: 'fee' });
if ((await fuji.readContract({ address: oracle, abi: oracleAbi, functionName: 'earned' })) > 0n) {
  hashes['Fuji oracle.withdraw (fees back to operator)'] = await fujiWallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'withdraw' });
  await mined(fuji, hashes['Fuji oracle.withdraw (fees back to operator)'] as Hash);
}
if ((await fuji.getBalance({ address: adapter })) < fee) {
  const h = await fujiWallet.sendTransaction({ to: adapter, value: fee });
  await mined(fuji, h);
  hashes['Fuji fund adapter with one oracle fee'] = h;
}

// 1. L1: announce (once per list) and request.
const [announced] = await l1.readContract({ address: sampler, abi: samplerAbi, functionName: 'announcements', args: [auditor.address, fileHash] });
if (announced === '0x0000000000000000000000000000000000000000') {
  const h = await l1Auditor.writeContract({ address: sampler, abi: samplerAbi, functionName: 'announce', args: [fileHash, list.itemCount, size, treasurer.address] });
  await mined(l1, h);
  hashes['L1 announce'] = h;
}
const requestTx = await l1Treasurer.writeContract({ address: sampler, abi: samplerAbi, functionName: 'requestAudit', args: [fileHash, auditor.address, label] });
const requestReceipt = await mined(l1, requestTx);
const [{ args: requested }] = parseEventLogs({ abi: samplerAbi, eventName: 'AuditRequested', logs: requestReceipt.logs });
const auditId = requested.auditId;
hashes['L1 requestAudit -> ICM send (L1 to Fuji)'] = requestTx;
log(`L1 audit ${auditId} requested, ICM message ${requested.messageID}`);

// 2. Fuji: the relayer delivers, the adapter files the oracle request.
const requestId = await until('the request to reach Fuji', async () => {
  const id = await fuji.readContract({ address: adapter, abi: adapterAbi, functionName: 'requestOfRemoteAudit', args: [auditId] });
  return id > 0n ? id : undefined;
});
hashes['Fuji ICM receive -> oracle request filed'] = await until('the Fuji delivery tx', () => executedIn(fuji, requested.messageID, fujiStart));
log(`Fuji: oracle request ${requestId} filed by the adapter`);

// 3. Fuji: the oracle nodes answer. The signature is read from their fulfill transaction.
const fulfillTx = await until('the oracle nodes to answer (are they running?)', async () => {
  if ((await fuji.readContract({ address: oracle, abi: oracleAbi, functionName: 'statusOf', args: [requestId] })) !== 2) return undefined;
  const head = await fuji.getBlockNumber();
  for (let start = fujiStart; start <= head; start += 100n) {
    const logs = await fuji.getLogs({ address: oracle, event: fulfilledEvent, args: { requestId }, fromBlock: start, toBlock: start + 99n > head ? head : start + 99n });
    if (logs.length) return logs[0].transactionHash;
  }
  return undefined;
}, 600);
const fulfill = await fuji.getTransaction({ hash: fulfillTx });
const { args: fulfillArgs } = decodeFunctionData({ abi: oracleAbi, data: fulfill.input });
const signature = fulfillArgs![1] as readonly [bigint, bigint];
hashes['Fuji oracle.fulfill by the nodes (BLS checked)'] = fulfillTx;
log(`Fuji: answered by the nodes in ${fulfillTx}`);

// 4. Fuji: forward the signature back over ICM.
const forwardTx = await fujiWallet.writeContract({ address: adapter, abi: adapterAbi, functionName: 'forward', args: [requestId, [signature[0], signature[1]]] });
const forwardReceipt = await mined(fuji, forwardTx);
hashes['Fuji adapter.forward -> ICM send (Fuji to L1)'] = forwardTx;
const [{ args: forwarded }] = parseEventLogs({ abi: adapterAbi, eventName: 'AnswerForwarded', logs: forwardReceipt.logs });
const backMessageID = forwarded.messageID;

// 5. L1: the relayer delivers, the sampler checks the BLS signature and stores the sample.
hashes['L1 ICM receive -> BLS checked, sample stored'] = await until('the answer to reach the L1', () => executedIn(l1, backMessageID, l1Start));
const picks = await l1.readContract({ address: sampler, abi: samplerAbi, functionName: 'sampleOf', args: [auditId] });
log(`L1 audit ${auditId}: check receipts ${picks.join(', ')} (in draw order)`);

for (const [k, v] of Object.entries(hashes)) console.log(`${k.padEnd(48)} ${v}`);
console.log(`audit ${auditId}, oracle request ${requestId}, picks [${picks.join(', ')}]`);

