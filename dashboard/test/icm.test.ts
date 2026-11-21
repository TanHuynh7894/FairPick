// The "From L1" page: audits that reached the oracle from the fairpick L1, read from the Fuji-side adapter on a real
// anvil with the real contracts. Only the ICM messenger is a stand-in (the same MockMessenger the Solidity tests use).
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { messageFor, publicKey, sign } from '../../node/src/bls';
import { makeClient } from '../src/chain';
import { pickSample } from '../src/derive';
import { checkRecord, createIcmReader, type L1Record, type RemoteAudit } from '../src/icm';
import l1 from '../src/l1-audits.json';
import { commitmentFor } from '../src/receipts';

const PORT = 8603;
const URL_ = `http://127.0.0.1:${PORT}`;
const BLS_KEY = 0x2a2a2a2a2a2a2a2an;
const FEE = 10n ** 16n;
const ALICE: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const L1_ID = keccak256(new TextEncoder().encode('fairpick l1'));
const L1_SAMPLER: Address = '0x3A54a96d74891C3d8E707760A60A1Ef96e07f7dF';
const FILE = `0x${'ab'.repeat(32)}` as Hex;

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url), 'utf8')) as { abi: any; bytecode: { object: Hex } };
const ORACLE = artifact('RandomnessOracle.sol', 'RandomnessOracle');
const ADAPTER = artifact('IcmRandomnessAdapter.sol', 'IcmRandomnessAdapter');
const MESSENGER = artifact('IcmRandomness.t.sol', 'MockMessenger');

const client = makeClient(URL_);
const wallet = createWalletClient({ chain: foundry, transport: http(URL_), pollingInterval: 20 });
const test = createTestClient({ chain: foundry, transport: http(URL_), mode: 'anvil' });
let anvil: ChildProcess;

async function send(address: Address, abi: any, functionName: string, args: unknown[] = [], value = 0n, account = ALICE) {
  const hash = await wallet.writeContract({ account, address, abi, functionName, args, value, gas: 3_000_000n } as any);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return receipt;
}
async function deploy(art: { abi: any; bytecode: { object: Hex } }, args: unknown[] = []) {
  const hash = await wallet.deployContract({ account: ALICE, abi: art.abi, bytecode: art.bytecode.object, args } as any);
  return (await client.waitForTransactionReceipt({ hash, pollingInterval: 20 })).contractAddress!;
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
afterAll(() => anvil?.kill());

/** The adapter with one L1 audit delivered over the stand-in messenger, and the oracle that answers it. */
async function filed(auditId: bigint, itemCount: number) {
  const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE, 1, []]);
  const messenger = await deploy(MESSENGER, [keccak256(new TextEncoder().encode('fuji'))]);
  const adapter = await deploy(ADAPTER, [oracle, messenger, L1_ID]);
  await send(adapter, ADAPTER.abi, 'setRemoteSampler', [L1_SAMPLER]);
  await wallet.sendTransaction({ account: ALICE, to: adapter, value: FEE });
  const message = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [auditId, commitmentFor(FILE, itemCount)]);
  const delivery = await send(messenger, MESSENGER.abi, 'deliverRaw', [adapter, L1_ID, L1_SAMPLER, message]);
  return { oracle, adapter, delivery };
}

describe('ICM adapter reader', () => {
  it('follows an L1 audit from filed to answered to sent back, with the Fuji transactions from a Data API listing', async () => {
    const { oracle, adapter, delivery } = await filed(1n, 20);
    let listed: Hex[] = [delivery.transactionHash];
    const fetcher = (async () => new Response(JSON.stringify({
      transactions: listed.map((txHash) => ({ nativeTransaction: { txHash, txStatus: '1' } })),
    }))) as typeof fetch;
    const read = createIcmReader(client, adapter, 43113, fetcher);

    const waiting = await read();
    expect(waiting.remoteBlockchainID).toBe(L1_ID);
    expect(waiting.remoteSampler.toLowerCase()).toBe(L1_SAMPLER.toLowerCase());
    expect(waiting.audits).toHaveLength(1);
    expect(waiting.audits[0]).toMatchObject({ auditId: 1n, oracleRequestId: 1n, commitment: commitmentFor(FILE, 20), answered: false, forwarded: false, filedTx: delivery.transactionHash });
    expect(waiting.audits[0].randomness).toBeUndefined();

    await test.mine({ blocks: 1 });
    const signature = sign(BLS_KEY, messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: adapter, blockHash: delivery.blockHash }));
    await send(oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]], 0n, BOB);
    const forward = await send(adapter, ADAPTER.abi, 'forward', [1n, [signature[0], signature[1]]]);
    listed = [forward.transactionHash, ...listed];

    const [done] = (await read()).audits;
    const randomness = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256[2]' }], [[signature[0], signature[1]]])));
    expect(done).toMatchObject({ answered: true, forwarded: true, randomness, filedTx: delivery.transactionHash, forwardTx: forward.transactionHash });
  });

  it('finds every audit by id with plain calls when there is no Data API, newest first', async () => {
    const { adapter } = await filed(1n, 12);
    const local = await read2(adapter);
    expect(local.audits.map((a) => a.auditId)).toEqual([1n]);
    expect(local.audits[0].filedTx).toBeUndefined();
  });

  async function read2(adapter: Address) {
    return createIcmReader(client, adapter, foundry.id, (async () => { throw new Error('no network in this test'); }) as typeof fetch)();
  }
});

describe('checking the L1 record against Fuji', () => {
  const record: L1Record = { auditId: 1, label: 'CLB', itemCount: 20, sampleSize: 3, fileHash: FILE, requester: ALICE, settled: true, oracleRequestId: 1, picks: [], requestTx: null, answerTx: null };
  const remote: RemoteAudit = { auditId: 1n, oracleRequestId: 1n, commitment: commitmentFor(FILE, 20), answered: true, randomness: 123456789n, forwarded: true };

  it('accepts receipts that follow from the oracle answer, for the list the L1 committed to', () => {
    const picks = pickSample(123456789n, 20, 3);
    expect(checkRecord(remote, { ...record, picks })).toEqual({ commitment: 'match', picks: 'match', expected: picks });
  });

  it('flags other receipts, another receipt count, and waits while there is no answer', () => {
    const picks = pickSample(123456789n, 20, 3);
    expect(checkRecord(remote, { ...record, picks: [...picks].reverse() }).picks).toBe('mismatch');
    expect(checkRecord(remote, { ...record, itemCount: 21, picks }).commitment).toBe('mismatch');
    expect(checkRecord({ ...remote, answered: false, randomness: undefined }, record)).toEqual({ commitment: 'match', picks: 'waiting' });
    expect(checkRecord(remote, undefined)).toEqual({ commitment: 'unknown', picks: 'unknown' });
  });

  it('agrees with the live runs: the L1 export, and the oracle answers and commitments read from Fuji on 21 Nov', () => {
    // RandomnessOracle.randomnessOf(6|7) and IcmRandomnessAdapter.pending(6|7).commitment on Fuji.
    const fuji: Record<number, { randomness: bigint; commitment?: Hex }> = {
      1: { randomness: 34087361598899540700858093802762811301080211858428014809071910725761382910295n, commitment: '0xf2acc704af2fe5b7ff2b6a57a744432726adbd4541a3245f1afa6bb366871544' },
      2: { randomness: 51618971047074452727932179389961416270671989840901773503227362300949373621163n },
    };
    for (const [id, f] of Object.entries(fuji)) {
      const rec = (l1.audits as L1Record[]).find((a) => a.auditId === Number(id))!;
      const got = checkRecord({ auditId: BigInt(id), oracleRequestId: BigInt(rec.oracleRequestId), commitment: f.commitment ?? commitmentFor(rec.fileHash, rec.itemCount), answered: true, randomness: f.randomness, forwarded: true }, rec);
      expect(got).toMatchObject({ commitment: 'match', picks: 'match' });
    }
  });
});
