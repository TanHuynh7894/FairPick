// Reads the real contracts on a real anvil, so a change to a contract's ABI fails here. Nothing is mocked.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  verifyMessage,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { messageFor, publicKey, sign } from '../../node/src/bls';
import { combine, shareKey, signPartial, splitKey } from '../../node/src/threshold';
import { BEACON_ABI, createBeaconReader, createOracleReader, makeClient, ORACLE_ABI, parseTestKeys, readEntries, SAMPLER_ABI, walletFor } from '../src/chain';
import { createAdminReader } from '../src/admin';
import { DATA_API, dataApiAnswers, rpcAnswers, withFallback } from '../src/answers';
import { commitmentFor, newSecret } from '../src/secrets';
import { commitmentFor as listCommitment } from '../src/receipts';
import { listKey, missingMask, missingReceipts } from '../src/derive';
import { errorText } from '../src/format';
import { verifyAnswer, verifyShares } from '../src/verify';

const PORT = 8602;
const URL_ = `http://127.0.0.1:${PORT}`;
const BLS_KEY = 0x2a2a2a2a2a2a2a2an;
const FEE = 10n ** 16n;
const ALICE: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CAROL: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url), 'utf8')) as {
    abi: any;
    bytecode: { object: Hex };
  };
const ORACLE = artifact('RandomnessOracle.sol', 'RandomnessOracle');
const SAMPLER = artifact('AuditSampler.sol', 'AuditSampler');
const BATCH = `0x${'cd'.repeat(32)}` as const;
const AUDIT_ARGS = [BATCH, 40, 3, 'Quỹ lớp K66'] as const;
// A list is drawn once, so a second request in a test needs another list.
const OTHER_AUDIT = [`0x${'ee'.repeat(32)}`, 12, 2, 'CLB Guitar'] as const;
const BEACON = artifact('RandomnessBeacon.sol', 'RandomnessBeacon');

const client = makeClient(URL_);
const wallet = createWalletClient({ chain: foundry, transport: http(URL_), pollingInterval: 20 });
const test = createTestClient({ chain: foundry, transport: http(URL_), mode: 'anvil' });

let anvil: ChildProcess;

async function send(account: Address, address: Address, abi: any, functionName: string, args: unknown[] = [], value = 0n) {
  const hash = await wallet.writeContract({ account, address, abi, functionName, args, value, gas: 2_000_000n } as any);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return receipt;
}

/** CAROL, as auditor, announces the list for `who` if she has not yet. Then `who` asks for the draw. */
async function requestAs(who: Address, sampler: Address, [fileHash, count, sample, label]: readonly [string, number, number, string]) {
  const [named] = await client.readContract({ address: sampler, abi: SAMPLER_ABI, functionName: 'announcements', args: [CAROL, fileHash as Hex] });
  if (named === zeroAddress) await send(CAROL, sampler, SAMPLER.abi, 'announce', [fileHash, count, sample, who]);
  return send(who, sampler, SAMPLER.abi, 'requestAudit', [fileHash, CAROL, label], FEE);
}

async function deploy(art: { abi: any; bytecode: { object: Hex } }, args: unknown[] = []) {
  const hash = await wallet.deployContract({ account: ALICE, abi: art.abi, bytecode: art.bytecode.object, args } as any);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  return receipt.contractAddress!;
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('anvil did not start');
});

afterAll(() => {
  anvil?.kill();
});

describe('oracle reader', () => {
  it('follows requests from pending to answered and expired', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const read = createOracleReader(client, oracle, sampler);

    const empty = await read();
    expect(empty).toMatchObject({ total: 0, fee: FEE, earned: 0n, requests: [], threshold: 1, shares: 0 });
    expect(empty.operator.toLowerCase()).toBe(BOB.toLowerCase());

    const first = await requestAs(ALICE, sampler, AUDIT_ARGS);
    await test.mine({ blocks: 1 });
    const pending = await read();
    expect(pending.total).toBe(1);
    expect(pending.balance).toBe(FEE);
    expect(pending.requests[0]).toMatchObject({ id: 1n, status: 1, requestBlock: first.blockNumber });
    expect(pending.requests[0].consumer.toLowerCase()).toBe(sampler.toLowerCase());
    expect(pending.requests[0].answer).toBeUndefined();

    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: sampler, blockHash: first.blockHash });
    const signature = sign(BLS_KEY, message);
    const answer = await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);

    const done = await read();
    const row = done.requests[0];
    expect(row.status).toBe(2);
    expect(row.answer).toMatchObject({
      callbackOk: true,
      txHash: answer.transactionHash,
      block: answer.blockNumber,
      latencyBlocks: 2,
    });
    expect(row.answer!.randomness).toBe(BigInt(keccak256(encodeAbiParameters([{ type: 'uint256[2]' }], [[signature[0], signature[1]]]))));
    expect(row.answer!.latencySec).toBeGreaterThanOrEqual(0);
    expect(done.earned).toBe(FEE);
    expect(row.audit).toMatchObject({ itemCount: 40, sampleSize: 3, draw: 1, settled: true, fileHash: BATCH, label: 'Quỹ lớp K66', reported: false, missing: 0, seed: row.answer!.randomness });
    expect(row.audit!.requester.toLowerCase()).toBe(ALICE.toLowerCase());
    // The page's pick must be the contract's pick.
    const onChain = await client.readContract({ address: sampler, abi: SAMPLER_ABI, functionName: 'sampleOf', args: [1n] });
    expect(row.audit!.picks).toEqual(onChain.map(Number));

    await requestAs(ALICE, sampler, OTHER_AUDIT);
    await test.mine({ blocks: 257 });
    await send(ALICE, oracle, ORACLE.abi, 'expire', [2n]);
    const closed = await read();
    expect(closed.requests.map((r) => [r.id, r.status])).toEqual([[2n, 3], [1n, 2]]);
  });

  it('reads how the oracle key was split from the contract', async () => {
    const shares = splitKey(BLS_KEY, 2, 3).map(shareKey);
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 2, shares]);
    expect(await createOracleReader(client, oracle)()).toMatchObject({ threshold: 2, shares: 3 });
  });

  it('keeps only the newest requests but still reports the true total', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    for (let i = 0; i < 3; i++) await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    const snapshot = await createOracleReader(client, oracle, undefined, 2)();
    expect(snapshot.total).toBe(3);
    expect(snapshot.requests.map((r) => r.id)).toEqual([3n, 2n]);
  });

  it('forgets what it cached when the chain goes backwards', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const snapshotId = await test.snapshot();
    await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    const read = createOracleReader(client, oracle);
    expect((await read()).total).toBe(2);
    await test.revert({ id: snapshotId });
    await test.mine({ blocks: 1 });
    expect((await read()).total).toBe(0);
    const again = await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    expect((await read()).requests[0].requestBlock).toBe(again.blockNumber);
  });
});

describe('verifyAnswer', () => {
  async function answeredRequest() {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const requested = await requestAs(ALICE, sampler, AUDIT_ARGS);
    await test.mine({ blocks: 1 });
    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: sampler, blockHash: requested.blockHash });
    const signature = sign(BLS_KEY, message);
    await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    const request = (await createOracleReader(client, oracle, sampler)()).requests[0];
    return { oracle, sampler, request, requested, message, signature };
  }

  it('confirms a real answer from chain data alone', async () => {
    const { oracle, request, message, signature } = await answeredRequest();
    const result = await verifyAnswer(client, foundry.id, oracle, request);
    expect(result).toMatchObject({ kind: 'checked', message, signature: [signature[0], signature[1]], signatureOk: true, randomnessOk: true });
  });

  it('rejects a result that is not the hash of the signature', async () => {
    const { oracle, request } = await answeredRequest();
    const forged = { ...request, answer: { ...request.answer!, randomness: request.answer!.randomness ^ 1n } };
    expect(await verifyAnswer(client, foundry.id, oracle, forged)).toMatchObject({ signatureOk: true, randomnessOk: false });
  });

  it('rejects a signature made for another request', async () => {
    const { oracle, request } = await answeredRequest();
    const other = { ...request, consumer: ALICE };
    expect(await verifyAnswer(client, foundry.id, oracle, other)).toMatchObject({ signatureOk: false, randomnessOk: true });
  });

  it('does not vouch for a transaction that went to another oracle', async () => {
    const { request } = await answeredRequest();
    const otherOracle = await deploy(ORACLE, [publicKey(BLS_KEY + 1n), BOB, FEE, 1, []]);
    expect(await verifyAnswer(client, foundry.id, otherOracle, request)).toMatchObject({ kind: 'unreadable' });
  });

  it('says so when the answer came through another contract and its calldata cannot be read', async () => {
    const { oracle, request, requested } = await answeredRequest();
    const viaOther = { ...request, answer: { ...request.answer!, txHash: requested.transactionHash } };
    expect(await verifyAnswer(client, foundry.id, oracle, viaOther)).toMatchObject({ kind: 'unreadable' });
  });
});

describe('which key shares signed', () => {
  const shares = splitKey(BLS_KEY, 2, 3);
  const hex = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;

  async function answeredBy(indices: number[]) {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 2, shares.map(shareKey)]);
    const requested = await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    await test.mine({ blocks: 1 });
    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: ALICE, blockHash: requested.blockHash });
    const partials = indices.map((i) => signPartial(shares[i - 1], message));
    const signature = combine(partials, 2);
    await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    const served = { requestId: '1', partials: partials.map((p) => ({ index: p.index, signature: p.signature.map(hex) })) };
    return { oracle, message, signature, served };
  }
  /** A node's /evidence endpoint. The first node did not put the answer together, the second did. */
  const nodes = (body: unknown) => (async (url: string) => (url.startsWith('http://first') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body)))) as typeof fetch;
  const URLS = ['http://first', 'http://second'];

  it('names the shares when their partial signatures verify under the share keys stored in the oracle', async () => {
    const { oracle, message, signature, served } = await answeredBy([2, 3]);
    expect(await verifyShares(client, oracle, 1n, message, signature, nodes(served), URLS)).toEqual({ shares: [2, 3], threshold: 2, count: 3, ok: true });
  });

  it('says mismatch for partials that are not what was signed, or that name another share', async () => {
    const { oracle, message, signature, served } = await answeredBy([1, 2]);
    const renamed = { ...served, partials: [served.partials[0], { ...served.partials[1], index: 3 }] };
    expect(await verifyShares(client, oracle, 1n, message, signature, nodes(renamed), URLS)).toMatchObject({ ok: false });
    const one = { ...served, partials: [served.partials[0]] };
    expect(await verifyShares(client, oracle, 1n, message, signature, nodes(one), URLS)).toMatchObject({ ok: false });
  });

  it('says nothing when no node has the partials, or the oracle has a single signer', async () => {
    const { oracle, message, signature, served } = await answeredBy([1, 3]);
    expect(await verifyShares(client, oracle, 1n, message, signature, nodes(served), [])).toBeNull();
    const single = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    expect(await verifyShares(client, single, 1n, message, signature, nodes(served), URLS)).toBeNull();
  });
});

describe('beacon reader', () => {
  it('reads rounds newest first, with their progress and result', async () => {
    const beacon = await deploy(BEACON);
    const read = createBeaconReader(client, beacon);
    expect(await read()).toMatchObject({ total: 0, rounds: [] });

    await send(ALICE, beacon, BEACON.abi, 'createRound', [60n, 60n, FEE, 2]);
    const secret = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
    const commitment = (who: Address, n: number) =>
      keccak256(
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
          [BigInt(foundry.id), beacon, 0n, who, secret(n)],
        ),
      );
    await send(ALICE, beacon, BEACON.abi, 'commit', [0n, commitment(ALICE, 1)], FEE);
    await send(BOB, beacon, BEACON.abi, 'commit', [0n, commitment(BOB, 2)], FEE);

    const open = await read();
    expect(open.rounds[0]).toMatchObject({ id: 0n, status: 0, commits: 2, reveals: 0, minParticipants: 2, bond: FEE });
    expect(open.rounds[0].revealEnd - open.rounds[0].commitEnd).toBe(60);
    expect(open.rounds[0].commitEnd).toBeGreaterThanOrEqual(open.headTime);

    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    await send(ALICE, beacon, BEACON.abi, 'reveal', [0n, secret(1)]);
    await send(BOB, beacon, BEACON.abi, 'reveal', [0n, secret(2)]);
    await send(ALICE, beacon, BEACON.abi, 'finalize', [0n]);

    await send(ALICE, beacon, BEACON.abi, 'createRound', [60n, 60n, FEE, 2]);
    const closed = await read();
    expect(closed.total).toBe(2);
    expect(closed.rounds.map((r) => r.id)).toEqual([1n, 0n]);
    expect(closed.rounds[1].status).toBe(1);
    expect(closed.rounds[1].randomness).not.toBe(0n);
    expect(closed.rounds[1].randomness).toBe(
      await client.readContract({ address: beacon, abi: BEACON.abi, functionName: 'randomOf', args: [0n] }),
    );
  });
});

describe('walletFor', () => {
  const noDevAccounts = () => ({ ...client, request: async () => [] }) as unknown as typeof client;
  function fakeWallet(chainId: number, calls: string[]) {
    return {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ALICE];
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'wallet_switchEthereumChain') {
          chainId = Number((params as [{ chainId: string }])[0].chainId);
          return null;
        }
        return client.request({ method, params } as never);
      },
    } as unknown as EIP1193Provider;
  }

  it('offers the unlocked accounts of a dev node and signs and sends through them', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const wallet = (await walletFor(client, URL_, undefined))!;
    expect(wallet.kind).toBe('dev');
    const accounts = await wallet.accounts();
    expect(accounts.map((a) => a.toLowerCase())).toContain(ALICE.toLowerCase());
    const signer = wallet.signerFor(ALICE);
    const signature = await signer.signMessage('hello');
    expect(await verifyMessage({ address: ALICE, message: 'hello', signature })).toBe(true);
    await send(CAROL, sampler, SAMPLER.abi, 'announce', [BATCH, 40, 3, ALICE]);
    await wallet.signerFor(ALICE).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [BATCH, CAROL, 'Quỹ lớp K66'], value: FEE });
    expect((await createOracleReader(client, oracle, sampler)()).total).toBe(1);
  });

  it('goes through the browser wallet on a node without accounts', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const calls: string[] = [];
    const wallet = (await walletFor(noDevAccounts(), URL_, fakeWallet(foundry.id, calls), client))!;
    expect(wallet.kind).toBe('wallet');
    await send(CAROL, sampler, SAMPLER.abi, 'announce', [BATCH, 40, 3, ALICE]);
    await wallet.signerFor(ALICE).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [BATCH, CAROL, 'Quỹ lớp K66'], value: FEE });
    expect((await createOracleReader(client, oracle, sampler)()).total).toBe(1);
    expect(calls).not.toContain('wallet_switchEthereumChain');
  });

  it('asks the browser wallet to switch when it is on another chain', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const calls: string[] = [];
    const wallet = (await walletFor(noDevAccounts(), URL_, fakeWallet(1, calls), client))!;
    await send(CAROL, sampler, SAMPLER.abi, 'announce', [BATCH, 40, 3, ALICE]);
    await wallet.signerFor(ALICE).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [BATCH, CAROL, 'Quỹ lớp K66'], value: FEE });
    expect(calls).toContain('wallet_switchEthereumChain');
  });

  it('signs in the page with test keys from its configuration, named for their part', async () => {
    // Anvil's first two keys, public test keys.
    const keys = parseTestKeys('treasurer:0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80, auditor:0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d,broken:0x12');
    expect(keys.map((k) => k.label)).toEqual(['treasurer', 'auditor']);
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    // No accounts on the node and no browser wallet: the keys are all there is.
    const wallet = (await walletFor(noDevAccounts(), URL_, undefined, client, keys))!;
    expect((await wallet.accounts()).map((a) => a.toLowerCase())).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()]);
    expect(wallet.labels).toEqual({ [ALICE.toLowerCase()]: 'treasurer', [BOB.toLowerCase()]: 'auditor' });
    const signature = await wallet.signerFor(ALICE).signMessage('hello');
    expect(await verifyMessage({ address: ALICE, message: 'hello', signature })).toBe(true);

    await wallet.signerFor(BOB).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'announce', args: [BATCH, 40, 3, ALICE] });
    await wallet.signerFor(ALICE).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [BATCH, BOB, 'Quỹ lớp K66'], value: FEE });
    const [request] = (await createOracleReader(client, oracle, sampler)()).requests;
    expect(request.audit).toMatchObject({ requester: ALICE, auditor: BOB });
    const refused = await wallet.signerFor(BOB).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [BATCH, BOB, 'x'], value: FEE }).catch((e) => e);
    expect(errorText(refused)).toBe('The auditor has not announced this list for this wallet.');
  });

  it('finds no way to send when the node has no accounts and there is no wallet', async () => {
    expect(await walletFor(noDevAccounts(), URL_, undefined)).toBeNull();
  });

  it('explains a revert in the words of the contract error, without sending anything', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const signer = (await walletFor(client, URL_, undefined))!.signerFor(ALICE);
    const before = await client.getTransactionCount({ address: ALICE });
    const failure = await signer.write({ address: oracle, abi: ORACLE_ABI, functionName: 'withdraw' }).catch((e) => e);
    expect(errorText(failure)).toBe('Nothing to withdraw yet.');
    expect(await client.getTransactionCount({ address: ALICE })).toBe(before);
  });
});

describe('finding the answer transaction', () => {
  async function answered() {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const requested = await requestAs(ALICE, sampler, AUDIT_ARGS);
    await test.mine({ blocks: 1 });
    const signature = sign(BLS_KEY, messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: sampler, blockHash: requested.blockHash }));
    const answer = await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    return { oracle, sampler, requested, answer };
  }
  /** What the Avalanche Data API returns for an address: its transactions, newest first, without event data. */
  const listing = (txs: { hash: Hex; block: bigint; from: Address; method: string; status?: string }[]) => ({
    transactions: txs.map((t) => ({ nativeTransaction: { txHash: t.hash, blockNumber: t.block.toString(), txStatus: t.status ?? '1', from: { address: t.from }, gasUsed: '1', method: { methodHash: t.method } } })),
  });

  it('reads the oracle transactions from a Data API listing and learns the request of each from its receipt', async () => {
    const { oracle, sampler, requested, answer } = await answered();
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(listing([
        { hash: answer.transactionHash, block: answer.blockNumber, from: BOB, method: '0xcceed189' },
        { hash: requested.transactionHash, block: requested.blockNumber, from: ALICE, method: '0xf7408014' },
      ])));
    }) as typeof fetch;
    const source = dataApiAnswers(client, oracle, 43113, fetcher);

    const found = await source.find(1n, requested.blockNumber, answer.blockNumber);
    expect(found).toMatchObject({ txHash: answer.transactionHash, block: answer.blockNumber, callbackOk: true, gasUsed: answer.gasUsed });
    expect(found!.from!.toLowerCase()).toBe(BOB.toLowerCase());
    expect(source.requestTx!(1n)).toBe(requested.transactionHash);
    expect(calls).toEqual([`${DATA_API}/v1/chains/43113/addresses/${oracle}/transactions?pageSize=100&sortOrder=desc`]);
    // A known answer costs no further request.
    await source.find(1n, requested.blockNumber, answer.blockNumber);
    expect(calls).toHaveLength(1);

    // The reader shows the same answer as with RPC logs, plus who sent it and the request's transaction.
    const viaApi = (await createOracleReader(client, oracle, sampler, 200, source)()).requests[0];
    const viaRpc = (await createOracleReader(client, oracle, sampler)()).requests[0];
    expect(viaApi.answer).toMatchObject({ ...viaRpc.answer, gasUsed: answer.gasUsed });
    expect(viaApi.requestTx).toBe(requested.transactionHash);
    expect(viaRpc.requestTx).toBeUndefined();
  });

  it('gives nothing yet for an answer the listing does not have, and skips failed transactions', async () => {
    const { oracle, requested, answer } = await answered();
    const source = dataApiAnswers(client, oracle, 43113, (async () => new Response(JSON.stringify(listing([
      { hash: answer.transactionHash, block: answer.blockNumber, from: BOB, method: '0xcceed189', status: '0' },
    ])))) as typeof fetch);
    expect(await source.find(1n, requested.blockNumber, answer.blockNumber)).toBeUndefined();
  });

  it('falls back to RPC logs when the Data API cannot be reached', async () => {
    const { oracle, requested, answer } = await answered();
    const down = dataApiAnswers(client, oracle, 43113, (async () => new Response('busy', { status: 429 })) as typeof fetch);
    await expect(down.find(1n, requested.blockNumber, answer.blockNumber)).rejects.toThrow('429');
    const source = withFallback(down, rpcAnswers(client, oracle));
    expect(await source.find(1n, requested.blockNumber, answer.blockNumber)).toMatchObject({ txHash: answer.transactionHash });
  });

  it('scans the whole answer window in pieces of at most 100 blocks', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const requested = await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    await test.mine({ blocks: 250 });
    const signature = sign(BLS_KEY, messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: ALICE, blockHash: requested.blockHash }));
    const answer = await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    const spans: bigint[] = [];
    const watched = { ...client, getContractEvents: (args: { fromBlock: bigint; toBlock: bigint }) => { spans.push(args.toBlock - args.fromBlock + 1n); return client.getContractEvents(args as never); } } as unknown as typeof client;
    expect(await rpcAnswers(watched, oracle).find(1n, requested.blockNumber, answer.blockNumber)).toMatchObject({ txHash: answer.transactionHash });
    expect(spans.length).toBe(3);
    expect(spans.every((n) => n <= 100n)).toBe(true);
  });
});

describe('operator and requester actions', () => {
  async function setup() {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
    const sampler = await deploy(SAMPLER, [oracle]);
    const wallet = (await walletFor(client, URL_, undefined))!;
    const request = await requestAs(ALICE, sampler, AUDIT_ARGS);
    return { oracle, sampler, wallet, request };
  }

  it('reads who asked for an audit and whether it was refunded, and pays a refund once', async () => {
    const { oracle, sampler, wallet } = await setup();
    const read = createOracleReader(client, oracle, sampler);
    expect((await read()).requests[0].audit?.requester.toLowerCase()).toBe(ALICE.toLowerCase());
    await test.mine({ blocks: 257 });
    const signer = wallet.signerFor(ALICE);
    await signer.write({ address: sampler, abi: SAMPLER_ABI, functionName: 'refund', args: [1n] });
    expect((await read()).requests[0]).toMatchObject({ status: 3, refunded: true });
    const again = await signer.write({ address: sampler, abi: SAMPLER_ABI, functionName: 'refund', args: [1n] }).catch((e) => e);
    expect(errorText(again)).toBe('This audit cannot be refunded, or it already was.');
  });

  it('refuses a second draw, a stranger and an unannounced list in plain words', async () => {
    const { oracle, sampler, wallet } = await setup();
    const ask = (who: Address, fileHash: Hex) => wallet.signerFor(who).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [fileHash, CAROL, 'again'], value: FEE }).catch((e) => e);
    expect(errorText(await ask(ALICE, BATCH))).toBe('This list was already drawn. A list is drawn once.');
    // Bob knows the hash, but the auditor named Alice.
    expect(errorText(await ask(BOB, BATCH))).toBe('The auditor has not announced this list for this wallet.');
    // A re-ordered copy is another hash, which the auditor never announced.
    expect(errorText(await ask(ALICE, `0x${'ab'.repeat(32)}`))).toBe('The auditor has not announced this list for this wallet.');
    expect((await createOracleReader(client, oracle, sampler)()).total).toBe(1);

    const read = { address: sampler, abi: SAMPLER_ABI } as const;
    expect(await client.readContract({ ...read, functionName: 'auditOfList', args: [listKey(CAROL, BATCH)] })).toBe(1n);
    expect(await client.readContract({ ...read, functionName: 'drawsOfList', args: [listKey(CAROL, BATCH)] })).toBe(1);
    expect(await client.readContract({ ...read, functionName: 'drawsOfFile', args: [BATCH] })).toBe(1);
    expect(await client.readContract({ ...read, functionName: 'auditsBy', args: [ALICE] })).toBe(1);
    expect(await client.readContract({ ...read, functionName: 'announcedBy', args: [CAROL] })).toBe(1);
    // The page's commitment is the contract's.
    expect(await client.readContract({ ...read, functionName: 'commitmentOf', args: [1n] })).toBe(listCommitment(BATCH, 40));
  });

  it('reads who announced an audit, and the result the auditor records', async () => {
    const { oracle, sampler, wallet, request } = await setup();
    const read = createOracleReader(client, oracle, sampler);
    expect((await read()).requests[0].audit).toMatchObject({ auditor: CAROL, reported: false });
    await test.mine({ blocks: 1 });
    const signature = sign(BLS_KEY, messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: sampler, blockHash: request.blockHash }));
    await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    const audit = (await read()).requests[0].audit!;

    const notMine = await wallet.signerFor(ALICE).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'report', args: [1n, 0] }).catch((e) => e);
    expect(errorText(notMine)).toBe('Only the auditor who announced this list can record its result.');
    // The auditor could not find the lowest of the picked receipts.
    const lowest = Math.min(...audit.picks);
    await wallet.signerFor(CAROL).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'report', args: [1n, missingMask(audit.picks, new Set([lowest]))] });
    const reported = (await read()).requests[0].audit!;
    expect(reported.reported).toBe(true);
    expect(missingReceipts(reported)).toEqual([lowest]);
    const twice = await wallet.signerFor(CAROL).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'report', args: [1n, 0] }).catch((e) => e);
    expect(errorText(twice)).toBe('The result of this audit is already recorded.');
  });

  it('numbers a second draw that follows an unanswered, refunded one', async () => {
    const { oracle, sampler, wallet } = await setup();
    await test.mine({ blocks: 257 });
    await wallet.signerFor(ALICE).write({ address: sampler, abi: SAMPLER_ABI, functionName: 'refund', args: [1n] });
    await requestAs(ALICE, sampler, AUDIT_ARGS);
    const { requests } = await createOracleReader(client, oracle, sampler)();
    expect(requests.map((r) => [r.id, r.audit?.draw, r.audit?.refunded])).toEqual([[2n, 2, false], [1n, 1, true]]);
  });

  it('gives the admin the node wallet, the real cost of an answer and a balanced account', async () => {
    const { oracle, sampler, request } = await setup();
    await test.mine({ blocks: 1 });
    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: sampler, blockHash: request.blockHash });
    const signature = sign(BLS_KEY, message);
    const answer = await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    // One more request stays open, so the account has a pending fee in it too.
    await requestAs(ALICE, sampler, OTHER_AUDIT);

    const snapshot = await createOracleReader(client, oracle, sampler)();
    const admin = await createAdminReader(client, oracle)(snapshot);
    expect(admin.wallets.map((w) => w.address.toLowerCase())).toEqual([BOB.toLowerCase()]);
    expect(admin.wallets[0].balance).toBe(await client.getBalance({ address: BOB }));
    expect(admin.avgCost).toBe(answer.gasUsed * answer.effectiveGasPrice);
    expect(admin.samples).toBe(1);
    expect(admin.publicKey).toEqual([...publicKey(BLS_KEY)]);
    expect(admin.reconciliation).toMatchObject({ ok: true, surplus: 0n, owed: 2n * FEE });
  });

  it('counts refunds waiting in the contract when reconciling', async () => {
    const { oracle, sampler } = await setup();
    await test.mine({ blocks: 257 });
    await send(ALICE, oracle, ORACLE.abi, 'expire', [1n]);
    const snapshot = await createOracleReader(client, oracle, sampler)();
    const admin = await createAdminReader(client, oracle)(snapshot);
    expect(admin.reconciliation).toMatchObject({ ok: true, surplus: 0n, owed: FEE });
    expect(admin.refunds).toBe(FEE);
  });

  it('will not claim to reconcile when older requests are outside the window', async () => {
    const { oracle, sampler, wallet } = await setup();
    await requestAs(ALICE, sampler, OTHER_AUDIT);
    const snapshot = await createOracleReader(client, oracle, sampler, 1)();
    expect((await createAdminReader(client, oracle)(snapshot)).reconciliation).toBeNull();
  });
});

describe('beacon through the wallet', () => {
  it('runs a whole round with secrets made here, which the contract accepts', async () => {
    const beacon = await deploy(BEACON);
    const wallet = (await walletFor(client, URL_, undefined))!;
    const [alice, bob] = [wallet.signerFor(ALICE), wallet.signerFor(BOB)];
    const write = (signer: typeof alice, functionName: string, args: unknown[], value?: bigint) =>
      signer.write({ address: beacon, abi: BEACON_ABI, functionName, args, value } as never);

    await write(alice, 'createRound', [60n, 60n, FEE, 2]);
    const secrets = [newSecret(), newSecret()];
    expect(secrets[0]).not.toBe(secrets[1]);
    await write(alice, 'commit', [0n, commitmentFor(foundry.id, beacon, 0n, ALICE, secrets[0])], FEE);
    await write(bob, 'commit', [0n, commitmentFor(foundry.id, beacon, 0n, BOB, secrets[1])], FEE);

    const rounds = (await createBeaconReader(client, beacon)()).rounds;
    const [mine] = await readEntries(client, beacon, rounds, ALICE);
    expect(mine).toMatchObject({ committed: true, revealed: false, claimed: false });

    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    await write(alice, 'reveal', [0n, secrets[0]]);
    await write(bob, 'reveal', [0n, secrets[1]]);
    await write(alice, 'finalize', [0n]);
    await write(alice, 'claim', [0n]);

    const [closed] = (await createBeaconReader(client, beacon)()).rounds;
    expect(closed.status).toBe(1);
    expect((await readEntries(client, beacon, [closed], ALICE))[0]).toMatchObject({ revealed: true, claimed: true });
    const twice = await write(alice, 'claim', [0n]).catch((e) => e);
    expect(errorText(twice)).toBe('Nothing to claim from this round.');
  });

  it('refuses a wrong secret with a readable reason', async () => {
    const beacon = await deploy(BEACON);
    const alice = (await walletFor(client, URL_, undefined))!.signerFor(ALICE);
    await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'createRound', args: [60n, 60n, FEE, 2] });
    await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'commit', args: [0n, commitmentFor(foundry.id, beacon, 0n, ALICE, newSecret())], value: FEE });
    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    const failure = await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'reveal', args: [0n, newSecret()] }).catch((e) => e);
    expect(errorText(failure)).toBe('The secret does not match what this wallet committed.');
  });
  it('keeps a round with a member list to those members', async () => {
    const beacon = await deploy(BEACON);
    const wallet = (await walletFor(client, URL_, undefined))!;
    const [alice, bob, carol] = [ALICE, BOB, CAROL].map((a) => wallet.signerFor(a));
    await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'createRound', args: [60n, 60n, FEE, 2, [ALICE, BOB]] });
    const [round] = (await createBeaconReader(client, beacon)()).rounds;
    expect(round.members).toBe(2);

    const outsider = await carol.write({ address: beacon, abi: BEACON_ABI, functionName: 'commit', args: [0n, commitmentFor(foundry.id, beacon, 0n, CAROL, newSecret())], value: FEE }).catch((e) => e);
    expect(errorText(outsider)).toBe('This wallet is not on the member list of this round.');
    await bob.write({ address: beacon, abi: BEACON_ABI, functionName: 'commit', args: [0n, commitmentFor(foundry.id, beacon, 0n, BOB, newSecret())], value: FEE });

    // The four-argument form still makes a round anyone can join.
    await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'createRound', args: [60n, 60n, FEE, 2] });
    expect((await createBeaconReader(client, beacon)()).rounds.map((r) => r.members)).toEqual([0, 2]);
  });
});
