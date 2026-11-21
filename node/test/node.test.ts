// Runs the node against a real anvil and the real contracts. Nothing here is mocked.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { bn254 } from '@noble/curves/bn254.js';
import { hashToG1, publicKey, type G2Words } from '../src/bls';
import { createOracleNode, type OracleNode } from '../src/oracle-node';
import { keySigner, thresholdSigner, type ThresholdSigner } from '../src/signer';
import { checkEvidence, type DeployedKey } from '../src/evidence';
import { g2, shareKey, signPartial, splitKey, type Partial } from '../src/threshold';

const { Point: G1 } = bn254.G1;
const { Point: G2 } = bn254.G2;

const PORT = 8600;
const URL_ = `http://127.0.0.1:${PORT}`;
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const OPERATOR_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OPERATOR = privateKeyToAccount(OPERATOR_KEY);
const BLS_KEY = 0x2a2a2a2a2a2a2a2an;
const FEE = 10n ** 16n;
const STUCK_MS = 1_000;

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url), 'utf8')) as {
    abi: any;
    bytecode: { object: Hex };
  };
const ORACLE = artifact('RandomnessOracle.sol', 'RandomnessOracle');
const SAMPLER = artifact('AuditSampler.sol', 'AuditSampler');
let lists = 0;
/** A new list hash each time: the sampler refuses a second draw of the same list. */
const nextList = () => keccak256(encodeAbiParameters([{ type: 'uint256' }], [BigInt(++lists)]));

const pub = createPublicClient({ chain: foundry, transport: http(URL_), pollingInterval: 20 });
const wallet = createWalletClient({ chain: foundry, transport: http(URL_), account: DEPLOYER, pollingInterval: 20 });
const test = createTestClient({ chain: foundry, transport: http(URL_), mode: 'anvil' });

let anvil: ChildProcess;
let oracle: Address;
let sampler: Address;
let clock = 0;
let logs: string[] = [];

const makeNode = (blsKey = BLS_KEY, client: typeof pub = pub, maxFeePerGasCap?: bigint, maxCostPerAnswer?: bigint): OracleNode =>
  createOracleNode({
    client,
    maxFeePerGasCap,
    maxCostPerAnswer,
    account: OPERATOR,
    chainId: foundry.id,
    oracle,
    signer: keySigner(blsKey),
    stuckAfterMs: STUCK_MS,
    now: () => clock,
    log: (m) => {
      logs.push(m);
      if (process.env.NODE_LOG) console.log(m);
    },
  });

async function deploy(abi: any, bytecode: Hex, args: unknown[]) {
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

/** The deployer, as its own auditor, announces a new list. Needs a block, so call it while blocks are being mined. */
async function announceList() {
  const list = nextList();
  const hash = await wallet.writeContract({ address: sampler, abi: SAMPLER.abi, functionName: 'announce', args: [list, 40, 3, DEPLOYER.address] });
  await pub.waitForTransactionReceipt({ hash });
  return list;
}
const requestAnnounced = (list: Hex) =>
  wallet.writeContract({ address: sampler, abi: SAMPLER.abi, functionName: 'requestAudit', args: [list, DEPLOYER.address, 'test list'], value: FEE });
const requestAudit = async () => requestAnnounced(await announceList());

async function audit(): Promise<bigint> {
  const hash = await requestAudit();
  await pub.waitForTransactionReceipt({ hash });
  return pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'requestCount' }) as Promise<bigint>;
}

const statusOf = (id: bigint) =>
  pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'statusOf', args: [id] }) as Promise<number>;
const auditOf = (id: bigint) =>
  pub.readContract({ address: sampler, abi: SAMPLER.abi, functionName: 'audits', args: [id] }) as Promise<{ requester: Address; settled: boolean; seed: bigint }>;
const sent = (blockTag: 'latest' | 'pending' = 'latest') =>
  pub.getTransactionCount({ address: OPERATOR.address, blockTag });

/** Anvil mines just after accepting a transaction, so wait for the answers and require that they succeeded. */
async function answerAll(node: OracleNode = makeNode()) {
  await node.tick();
  for (const { hashes } of node.inFlight()) {
    const receipt = await pub.waitForTransactionReceipt({ hash: hashes[hashes.length - 1] });
    expect(receipt.status).toBe('success');
  }
  return node;
}

const PENDING = 1;
const FULFILLED = 2;

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('anvil did not start');
});

afterAll(() => {
  anvil?.kill();
});

beforeEach(async () => {
  await test.setAutomine(true);
  logs = [];
  clock = 0;
  oracle = await deploy(ORACLE.abi, ORACLE.bytecode.object, [publicKey(BLS_KEY), OPERATOR.address, FEE, 1, []]);
  sampler = await deploy(SAMPLER.abi, SAMPLER.bytecode.object, [oracle]);
});

describe('answering', () => {
  it('answers a request with a signature the contract accepts', async () => {
    const id = await audit();
    await answerAll();

    expect(await statusOf(id)).toBe(FULFILLED);
    const { requester, settled, seed } = await auditOf(id);
    expect(requester).toBe(DEPLOYER.address);
    expect(settled).toBe(true);
    const value = (await pub.readContract({
      address: oracle,
      abi: ORACLE.abi,
      functionName: 'randomnessOf',
      args: [id],
    })) as bigint;
    expect(value).toBe(seed);
  });

  it('answers several requests from one tick', async () => {
    const ids = [await audit(), await audit(), await audit()];
    await answerAll();
    for (const id of ids) expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('sends nothing for a request already answered', async () => {
    await audit();
    const node = await answerAll();
    const before = await sent();
    await node.tick();
    await makeNode().tick();
    expect(await sent('pending')).toBe(before);
    expect(logs.join('\n')).not.toContain('skipped');
  });

  it('picks up requests from before a restart with no saved state', async () => {
    const id = await audit();
    await test.mine({ blocks: 50 });
    await answerAll();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('after a start, leaves requests that are out of the window and answers the ones still in it', async () => {
    const old = await audit();
    await audit();
    await test.mine({ blocks: 257 });
    const fresh = await audit();
    const node = await answerAll();
    expect(node.inFlight().map((e) => e.requestId)).toEqual([fresh]);
    expect(await statusOf(old)).toBe(PENDING);
    expect(await statusOf(fresh)).toBe(FULFILLED);
  });

  it('answers when the next block is the last one in the window', async () => {
    const id = await audit();
    await test.mine({ blocks: 255 });
    await answerAll();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('sends nothing once the next block would be outside the window', async () => {
    const id = await audit();
    await test.mine({ blocks: 256 });
    const before = await sent();
    await makeNode().tick();
    expect(await sent('pending')).toBe(before);
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).not.toContain('skipped');
  });

  it('never sends when its key does not match the contract', async () => {
    const id = await audit();
    const before = await sent();
    await makeNode(BLS_KEY + 1n).tick();
    expect(await sent('pending')).toBe(before);
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).toContain('skipped');
  });

  it('checks the key against the chain before starting', async () => {
    await expect(makeNode().assertKeyMatches()).resolves.toBeUndefined();
    await expect(makeNode(BLS_KEY + 1n).assertKeyMatches()).rejects.toThrow(/does not match/);
  });
});

describe('stuck transactions', () => {
  const mineAll = () => test.mine({ blocks: 1 });

  it('does not wait for one transaction before answering the next request', async () => {
    const a = await audit();
    const nextList = await announceList();
    const node = makeNode();
    await test.setAutomine(false);
    await node.tick();
    expect(await sent('pending')).toBe((await sent()) + 1);

    // A second request arrives while the first answer is unmined.
    const hash = await requestAnnounced(nextList);
    await mineAll();
    await pub.waitForTransactionReceipt({ hash });
    const b = (await pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'requestCount' })) as bigint;
    expect(b).toBe(a + 1n);

    await node.tick();
    await mineAll();
    await node.tick();
    expect(await statusOf(a)).toBe(FULFILLED);
    expect(await statusOf(b)).toBe(FULFILLED);
  });

  it('replaces a stuck transaction at the same nonce with higher fees', async () => {
    const id = await audit();
    const nonce = await sent();
    const node = makeNode();
    await test.setAutomine(false);
    await node.tick();
    const [first] = node.inFlight();
    expect(first.nonce).toBe(nonce);

    await node.tick();
    expect(node.inFlight()[0].hashes).toHaveLength(1);

    clock += STUCK_MS + 1;
    await node.tick();
    const [second] = node.inFlight();
    expect(second.nonce).toBe(nonce);
    expect(second.hashes).toHaveLength(2);
    expect(second.acknowledged).toBe(true); // accepted the first time, not after a rejection
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);
    expect(second.maxPriorityFeePerGas).toBeGreaterThan(first.maxPriorityFeePerGas);
    expect(await sent('pending')).toBe(nonce + 1);

    await mineAll();
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
    expect(await sent()).toBe(nonce + 1);
    expect(node.inFlight()).toHaveLength(0);
  });

  it('does not prepare a second answer while one is in flight', async () => {
    await audit();
    let estimates = 0;
    const counting = {
      ...pub,
      estimateContractGas: (args: any) => {
        estimates++;
        return pub.estimateContractGas(args);
      },
    } as typeof pub;
    const node = makeNode(BLS_KEY, counting);
    await test.setAutomine(false);
    await node.tick();
    await node.tick();
    expect(estimates).toBe(1);
  });

  it('stops tracking when an older version is the one that got mined', async () => {
    await audit();
    let minedHash: Hex | undefined;
    const client = {
      ...pub,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (hash === minedHash) return { status: 'success' };
        const e = new Error('not found');
        e.name = 'TransactionReceiptNotFoundError';
        throw e;
      },
    } as unknown as typeof pub;
    const node = makeNode(BLS_KEY, client);
    await test.setAutomine(false);
    await node.tick();
    clock += STUCK_MS + 1;
    await node.tick();
    const [{ hashes }] = node.inFlight();
    expect(hashes).toHaveLength(2);

    minedHash = hashes[0];
    await node.tick();
    expect(node.inFlight().filter((e) => e.hashes.includes(hashes[0]))).toHaveLength(0);
  });

  it('clears a transaction left pending by an earlier run before answering', async () => {
    const id = await audit();
    await test.setAutomine(false);
    const earlier = makeNode();
    await earlier.tick();
    const nonce = earlier.inFlight()[0].nonce;

    const restarted = makeNode();
    await restarted.reconcile();
    await mineAll();
    expect(await sent()).toBe(nonce + 1);
    expect(await sent('pending')).toBe(nonce + 1);
    expect(await statusOf(id)).toBe(PENDING); // the old answer was replaced, not mined

    await restarted.tick();
    await mineAll();
    await restarted.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('keeps going after the node is told its nonce is already used', async () => {
    const id = await audit();
    const node = makeNode();
    await test.setAutomine(false);
    await node.tick();
    const [entry] = node.inFlight();

    // Something else with this key took the nonce, so the tracked transaction can never be mined.
    await test.dropTransaction({ hash: entry.hashes[0] });
    const operator = createWalletClient({ chain: foundry, transport: http(URL_), account: OPERATOR });
    await operator.sendTransaction({ to: OPERATOR.address, value: 0n, nonce: entry.nonce });
    await mineAll();

    clock += STUCK_MS + 1;
    await node.tick();
    expect(node.inFlight().every((e) => e.nonce !== entry.nonce)).toBe(true);
    await mineAll();
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });
});

describe('unreliable broadcasts', () => {
  /** A client whose next sendRawTransaction fails, either after the node accepted it or before. */
  function flaky(mode: 'accepted' | 'rejected') {
    let armed = true;
    return {
      ...pub,
      sendRawTransaction: async (args: any) => {
        if (!armed) return pub.sendRawTransaction(args);
        armed = false;
        if (mode === 'accepted') await pub.sendRawTransaction(args);
        throw new Error('HTTP request timed out');
      },
    } as typeof pub;
  }
  const mineAll = () => test.mine({ blocks: 1 });

  it.each(['accepted', 'rejected'] as const)('stays at one nonce when the response is lost (%s)', async (mode) => {
    const id = await audit();
    const nonce = await sent();
    const node = makeNode(BLS_KEY, flaky(mode));
    await test.setAutomine(false);

    await node.tick();
    const [entry] = node.inFlight();
    expect(entry.nonce).toBe(nonce);
    expect(await sent('pending')).toBe(mode === 'accepted' ? nonce + 1 : nonce);

    await node.tick();
    expect(node.inFlight()).toHaveLength(1);
    expect(node.inFlight()[0].hashes).toEqual(entry.hashes);
    expect(await sent('pending')).toBe(nonce + 1);

    await mineAll();
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
    expect(await sent()).toBe(nonce + 1);
    expect(node.inFlight()).toHaveLength(0);
  });

  /** A client that refuses every broadcast with this message until told otherwise. */
  function refusing(message: string) {
    const state = { refuse: true };
    const client = {
      ...pub,
      sendRawTransaction: async (args: any) => {
        if (state.refuse) throw new Error(message);
        return pub.sendRawTransaction(args);
      },
    } as typeof pub;
    return { client, state };
  }

  it('raises fees at once when refused for being below the base fee', async () => {
    await audit();
    const { client } = refusing('max fee per gas less than block base fee');
    const node = makeNode(BLS_KEY, client);
    await test.setAutomine(false);
    await node.tick();
    const [first] = node.inFlight();
    await node.tick();
    const [second] = node.inFlight();
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);
  });

  it('keeps the same bytes for an unexplained refusal, then raises fees once it has waited too long', async () => {
    const id = await audit();
    const { client, state } = refusing('internal error');
    const node = makeNode(BLS_KEY, client);
    await test.setAutomine(false);
    await node.tick();
    const [first] = node.inFlight();

    // A retry partway through must not restart the wait.
    clock += STUCK_MS - 100;
    await node.tick();
    expect(node.inFlight()[0].hashes).toEqual(first.hashes);

    clock += 101;
    await node.tick();
    const [second] = node.inFlight();
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);

    state.refuse = false;
    await node.tick();
    expect(node.inFlight()[0].acknowledged).toBe(true);
    await test.mine({ blocks: 1 });
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('does not throw out of a tick when a broadcast fails', async () => {
    await audit();
    await expect(makeNode(BLS_KEY, flaky('rejected')).tick()).resolves.toBeUndefined();
  });
});

describe('restart with transactions left pending', () => {
  const mineAll = () => test.mine({ blocks: 1 });

  /** Leaves a pending answer whose fees have been bumped well above what a new estimate would give. */
  async function expensiveLeftover() {
    const id = await audit();
    await test.setAutomine(false);
    const earlier = makeNode();
    await earlier.tick();
    for (let i = 0; i < 10; i++) {
      clock += STUCK_MS + 1;
      await earlier.tick();
    }
    return { id, nonce: earlier.inFlight()[0].nonce };
  }

  it('keeps raising fees until a rejected replacement is accepted', async () => {
    const { id, nonce } = await expensiveLeftover();
    const restarted = makeNode();
    await expect(restarted.reconcile()).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('underpriced');

    for (let i = 0; i < 20 && !restarted.inFlight()[0]?.acknowledged; i++) await restarted.tick();
    const [entry] = restarted.inFlight();
    expect(entry.acknowledged).toBe(true);
    expect(entry.nonce).toBe(nonce);
    expect(entry.requestId).toBeUndefined();

    // The clearing transaction took the old nonce, and the same ticks answered again at the next one.
    await mineAll();
    const clearing = await pub.getTransactionReceipt({ hash: entry.hashes[entry.hashes.length - 1] });
    expect(clearing.to?.toLowerCase()).toBe(OPERATOR.address.toLowerCase());
    expect(await sent()).toBe(nonce + 2);
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('tracks and replaces a clearing transaction like any other', async () => {
    const id = await audit();
    await test.setAutomine(false);
    const earlier = makeNode();
    await earlier.tick();

    const restarted = makeNode();
    await restarted.reconcile();
    const [clearing] = restarted.inFlight();
    expect(clearing.nonce).toBe(earlier.inFlight()[0].nonce);
    expect(clearing.requestId).toBeUndefined();

    clock += STUCK_MS + 1;
    await restarted.tick();
    const entry = restarted.inFlight().find((e) => e.nonce === clearing.nonce)!;
    expect(entry.hashes).toHaveLength(2);
    expect(entry.maxFeePerGas).toBeGreaterThan(clearing.maxFeePerGas);

    await mineAll();
    await restarted.tick();
    expect(restarted.inFlight().some((e) => e.nonce === clearing.nonce)).toBe(false);
    await mineAll();
    await restarted.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('never raises fees above the cap', async () => {
    await audit();
    const { maxFeePerGas } = await pub.estimateFeesPerGas();
    const cap = maxFeePerGas * 3n;
    const node = makeNode(BLS_KEY, pub, cap);
    await test.setAutomine(false);
    await node.tick();
    for (let i = 0; i < 12; i++) {
      clock += STUCK_MS + 1;
      await node.tick();
      const [entry] = node.inFlight();
      expect(entry.maxFeePerGas).toBeLessThanOrEqual(cap);
      expect(entry.maxPriorityFeePerGas).toBeLessThanOrEqual(cap);
    }
  });
});

describe('spending limit', () => {
  it('never offers more for one answer than the cost cap, however long it is stuck', async () => {
    await audit();
    const node = makeNode(BLS_KEY, pub, undefined, FEE);
    await test.setAutomine(false);
    await node.tick();
    for (let i = 0; i < 40; i++) {
      clock += STUCK_MS + 1;
      await node.tick();
      const [entry] = node.inFlight();
      expect(entry.gas * entry.maxFeePerGas).toBeLessThanOrEqual(FEE);
    }
    // Forty rounds of +25% would be far past the fee without the cap.
    const [entry] = node.inFlight();
    expect(entry.maxFeePerGas).toBe(FEE / entry.gas);
  });

  it('says so and still sends at the cap when the market price is above it', async () => {
    const id = await audit();
    const node = makeNode(BLS_KEY, pub, undefined, 1_000_000n);
    await test.setAutomine(false);
    await node.tick();
    expect(logs.join('\n')).toContain(`request ${id}: gas price is above the cap`);
    const [entry] = node.inFlight();
    expect(entry.gas * entry.maxFeePerGas).toBeLessThanOrEqual(1_000_000n);
  });
});

describe('message', () => {
  it('uses the same encoding as the contract', async () => {
    const id = await audit();
    const receipt = await pub.getBlock({ blockTag: 'latest' });
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
        [BigInt(foundry.id), oracle, id, sampler, receipt.hash],
      ),
    );
    await test.mine({ blocks: 1 });
    expect(await pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'messageOf', args: [id] })).toBe(
      expected,
    );
  });
});

describe('threshold signing, 2 of 3 nodes', () => {
  const shares = splitKey(BLS_KEY, 2, 3);
  const shareKeys = Object.fromEntries(shares.map((s) => [s.index, shareKey(s)]));
  // This oracle is deployed as what it is: threshold 2, with the three share keys on chain.
  beforeEach(async () => {
    oracle = await deploy(ORACLE.abi, ORACLE.bytecode.object, [publicKey(BLS_KEY), OPERATOR.address, FEE, 2, shares.map(shareKey)]);
    sampler = await deploy(SAMPLER.abi, SAMPLER.bytecode.object, [oracle]);
  });
  const SECOND = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

  /** In-memory peers: a node in `online` serves its partial, any other node is down. */
  function cluster(online: number[], lie?: (index: number, id: bigint) => Partial | null) {
    const signers = new Map<number, ThresholdSigner>();
    for (const share of shares) {
      signers.set(share.index, thresholdSigner({
        share,
        threshold: 2,
        groupKey: publicKey(BLS_KEY),
        shareKeys,
        peers: shares.filter((s) => s.index !== share.index).map((s) => String(s.index)),
        fetchPartial: async (peer, id) => {
          const index = Number(peer);
          if (lie) return lie(index, id);
          return online.includes(index) ? signers.get(index)!.partialFor(id) ?? null : null;
        },
        onCombined: (e) => combined.push(e),
        log: (m) => logs.push(m),
      }));
    }
    return signers;
  }
  let combined: Parameters<NonNullable<Parameters<typeof thresholdSigner>[0]['onCombined']>>[0][] = [];
  beforeEach(() => { combined = []; });
  const node = (signer: ThresholdSigner, account = OPERATOR, answerDelayMs = 0) =>
    createOracleNode({ client: pub, account, chainId: foundry.id, oracle, signer, answerDelayMs, stuckAfterMs: STUCK_MS, now: () => clock, log: (m) => logs.push(m) });

  it('still answers when one of the three nodes is down', async () => {
    const signers = cluster([2, 3]);
    const late = node(signers.get(3)!, SECOND, 5_000);
    const first = node(signers.get(2)!);
    const id = await audit();
    await late.tick(); // sees the request and holds its partial, but waits its turn
    await answerAll(first);
    expect(await statusOf(id)).toBe(FULFILLED);
    const { settled } = await auditOf(id);
    expect(settled).toBe(true);
  });

  /** What the oracle contract says about its key. The only thing evidence is checked against. */
  async function deployedKey(): Promise<DeployedKey> {
    const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: oracle, abi: ORACLE.abi, functionName, args });
    const count = Number(await read('shareCount'));
    return {
      groupKey: (await read('publicKey')) as G2Words,
      threshold: Number(await read('threshold')),
      shareKeys: (await Promise.all(Array.from({ length: count }, (_, k) => read('shareKey', [BigInt(k + 1)])))) as G2Words[],
    };
  }
  /** Answers one audit with shares 2 and 1 and returns what the answering node kept. */
  async function answeredWithEvidence() {
    const signers = cluster([1, 2]);
    const other = node(signers.get(1)!, SECOND, 5_000);
    const id = await audit();
    await other.tick();
    await answerAll(node(signers.get(2)!));
    const [kept] = combined;
    // The node that put the answer together also serves these partials to the page; the other node has none.
    expect(signers.get(2)!.evidenceFor(id)).toEqual(kept.partials);
    expect(signers.get(1)!.evidenceFor(id)).toBeUndefined();
    return { id, evidence: { message: kept.message, partials: kept.partials, signature: kept.signature } };
  }

  it('keeps the partial signatures of an answer, and they check out against the keys the oracle was deployed with', async () => {
    const { id, evidence } = await answeredWithEvidence();
    expect(logs.join('\n')).toContain(`request ${id}: combined the partial signatures of shares 2 and 1`);
    expect(evidence.partials.map((p) => p.index).sort()).toEqual([1, 2]);
    const key = await deployedKey();
    expect(key).toMatchObject({ threshold: 2, shareKeys: shares.map(shareKey) });
    expect(checkEvidence(key, evidence)).toEqual({ deployedAsSplit: true, sharesNamed: true, partialsOk: true, combinesToSignature: true, signatureOk: true, ok: true });
  });

  it('refuses forged evidence: share keys and partial signatures made up from the public signature', async () => {
    const { evidence } = await answeredWithEvidence();
    const key = await deployedKey();
    // Anyone can do this with what is on chain: pick d, call key + i*d*G2 "share i" and signature + i*d*H "its partial".
    const d = 0x5eedn;
    const h = hashToG1(evidence.message);
    const H = G1.fromAffine({ x: h.x, y: h.y });
    const sigma = G1.fromAffine({ x: evidence.signature[0], y: evidence.signature[1] });
    const forgedKey = (i: bigint): G2Words => { const { x, y } = g2(key.groupKey).add(G2.BASE.multiply(d * i)).toAffine(); return [x.c1, x.c0, y.c1, y.c0]; };
    const forgedPartial = (i: number): Partial => { const { x, y } = sigma.add(H.multiply(d * BigInt(i))).toAffine(); return { index: i, signature: [x, y] }; };
    const forgedKeys = [1n, 2n, 3n].map(forgedKey);
    const forged = { ...evidence, partials: [forgedPartial(1), forgedPartial(3)] };

    // The forgery is perfect on its own terms, which is why the keys must never come with the evidence.
    expect(checkEvidence({ ...key, shareKeys: forgedKeys }, forged).ok).toBe(true);
    // Against the keys the oracle was deployed with, it fails.
    expect(checkEvidence(key, forged)).toMatchObject({ deployedAsSplit: true, sharesNamed: true, partialsOk: false, ok: false });
  });

  it('refuses evidence that names a share twice, a share that does not exist, or the wrong number of shares', async () => {
    const { evidence } = await answeredWithEvidence();
    const key = await deployedKey();
    const [a, b] = evidence.partials;
    const third = signPartial(shares[2], evidence.message);
    for (const partials of [[a, a], [a], [a, b, third], [a, { ...b, index: 4 }], [a, { ...b, index: 0 }], [a, { ...b, index: 1.5 }], []]) {
      expect(checkEvidence(key, { ...evidence, partials })).toMatchObject({ sharesNamed: false, ok: false });
    }
    // A real partial under the wrong share's name, and one share's partial passed off as the answer.
    expect(checkEvidence(key, { ...evidence, partials: [a, { ...b, index: 3 }] })).toMatchObject({ partialsOk: false, ok: false });
    expect(checkEvidence(key, { ...evidence, signature: a.signature })).toMatchObject({ combinesToSignature: false, signatureOk: false, ok: false });
  });

  it('refuses any evidence for a key that is not a split of at least two: threshold 1, the key itself as a share, a foreign split', async () => {
    const { evidence } = await answeredWithEvidence();
    const key = await deployedKey();
    // "One share signs alone" is a single signer, whatever the file calls it.
    const whole: Partial = { index: 1, signature: evidence.signature };
    expect(checkEvidence({ groupKey: key.groupKey, threshold: 1, shareKeys: [key.groupKey] }, { ...evidence, partials: [whole] })).toMatchObject({ deployedAsSplit: false, ok: false });
    expect(checkEvidence({ groupKey: key.groupKey, threshold: 1, shareKeys: [] }, { ...evidence, partials: [] })).toMatchObject({ deployedAsSplit: false, ok: false });
    expect(checkEvidence({ ...key, threshold: 1 }, evidence).ok).toBe(false);
    expect(checkEvidence({ ...key, threshold: 3 }, evidence).ok).toBe(false);
    expect(checkEvidence({ ...key, shareKeys: [key.groupKey, key.shareKeys[1], key.shareKeys[2]] }, evidence)).toMatchObject({ deployedAsSplit: false, ok: false });
    expect(checkEvidence({ ...key, shareKeys: [key.shareKeys[0], key.shareKeys[0], key.shareKeys[2]] }, evidence)).toMatchObject({ deployedAsSplit: false, ok: false });
    expect(checkEvidence({ ...key, shareKeys: splitKey(BLS_KEY + 1n, 2, 3).map(shareKey) }, evidence)).toMatchObject({ deployedAsSplit: false, ok: false });
  });

  it('cannot be deployed with share keys that do not make up its public key', async () => {
    const foreign = splitKey(BLS_KEY + 1n, 2, 3).map(shareKey);
    await expect(wallet.deployContract({ abi: ORACLE.abi, bytecode: ORACLE.bytecode.object, args: [publicKey(BLS_KEY), OPERATOR.address, FEE, 2, foreign], gas: 3_000_000n })
      .then((hash) => pub.waitForTransactionReceipt({ hash })).then((r) => r.status)).resolves.toBe('reverted');
  });

  it('cannot answer with only one node, so one node alone cannot know the result', async () => {
    const signers = cluster([2]);
    const id = await audit();
    const before = await sent();
    await node(signers.get(2)!).tick();
    expect(await sent('pending')).toBe(before);
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).toContain('1 of 2 partial signatures');
  });

  it('ignores a peer that sends a point off the curve or an unknown index', async () => {
    const junk = (index: number): Partial => (index === 2 ? { index, signature: [5n, 7n] } : { index: 99, signature: [1n, 2n] });
    const signers = cluster([], (index) => junk(index));
    const id = await audit();
    await expect(node(signers.get(1)!).tick()).resolves.toBeUndefined();
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).toContain('rejected a bad partial');
  });

  it('ignores a partial that does not verify against its share key', async () => {
    const forged = (index: number): Partial => ({ index, signature: [1n, 2n] });
    const signers = cluster([], (index) => forged(index));
    const id = await audit();
    await node(signers.get(1)!).tick();
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).toContain('rejected a bad partial');
  });
});
