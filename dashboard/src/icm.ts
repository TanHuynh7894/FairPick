// Audits filed from the fairpick L1, as seen on Fuji. The L1's RPC is local to the team, so everything here is read
// from the IcmRandomnessAdapter on Fuji, which anyone can reach: which L1 audits arrived over ICM, the oracle request
// each became, the oracle's answer, and whether the answer was sent back. The L1's own record (l1-audits.json,
// written by scripts/l1-export.sh) is checked against it, not trusted.
import { parseAbi, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { DATA_API } from './answers';
import { pickSample } from './derive';
import { commitmentFor } from './receipts';

export const ADAPTER_ABI = parseAbi([
  'function remoteBlockchainID() view returns (bytes32)',
  'function remoteSampler() view returns (address)',
  'function requestOfRemoteAudit(uint256) view returns (uint256)',
  'function pending(uint256) view returns (uint256 remoteAuditId, bytes32 commitment, bytes32 requestBlockHash, uint256 randomness, bool answered, bool forwarded)',
  'event RemoteRequestFiled(uint256 indexed remoteAuditId, uint256 indexed oracleRequestId, bytes32 commitment)',
  'event AnswerForwarded(uint256 indexed remoteAuditId, uint256 indexed oracleRequestId, bytes32 messageID)',
]);

const DATA_API_CHAINS = new Set([43113, 43114]);
/** L1 audit ids are sequential. One still on its way over ICM leaves a gap, so the scan looks a few ids further. */
const GAP = 3;

export interface RemoteAudit {
  auditId: bigint;
  oracleRequestId: bigint;
  /** keccak256(fileHash, receipt count) as the L1 sent it. */
  commitment: Hex;
  answered: boolean;
  randomness?: bigint;
  forwarded: boolean;
  /** Fuji transactions, when the Avalanche Data API listed them: the ICM delivery that filed it, and the send back. */
  filedTx?: Hex;
  forwardTx?: Hex;
}

export interface IcmSnapshot {
  remoteBlockchainID: Hex;
  remoteSampler: Address;
  balance: bigint;
  /** Newest first. */
  audits: RemoteAudit[];
}

/** What the L1 says about one audit (l1-audits.json). */
export interface L1Record {
  auditId: number;
  label: string;
  itemCount: number;
  sampleSize: number;
  fileHash: Hex;
  requester: Address;
  settled: boolean;
  oracleRequestId: number;
  picks: number[];
  requestTx: Hex | null;
  answerTx: Hex | null;
}

export type Check = 'match' | 'mismatch' | 'waiting' | 'unknown';

/**
 * Checks the L1's record against Fuji. The commitment binds the list hash and receipt count; the receipts must be
 * what the pick rule gives for the oracle's answer, which is the seed the L1 uses.
 */
export function checkRecord(remote: RemoteAudit, record: L1Record | undefined): { commitment: Check; picks: Check; expected?: number[] } {
  if (!record) return { commitment: 'unknown', picks: 'unknown' };
  const commitment = commitmentFor(record.fileHash, record.itemCount).toLowerCase() === remote.commitment.toLowerCase() ? 'match' : 'mismatch';
  if (remote.randomness === undefined) return { commitment, picks: 'waiting' };
  const expected = pickSample(remote.randomness, record.itemCount, record.sampleSize);
  if (!record.settled) return { commitment, picks: 'waiting', expected };
  const same = expected.length === record.picks.length && expected.every((p, i) => p === record.picks[i]);
  return { commitment, picks: same ? 'match' : 'mismatch', expected };
}

interface DataApiTx {
  txHash: Hex;
  txStatus: string;
}

/**
 * Reads the adapter. Audits are found by id with plain calls, so it works on any chain; on Avalanche's public chains
 * the Data API also lists the adapter's transactions, and their receipts say which Fuji transaction did what.
 */
export function createIcmReader(client: PublicClient, adapter: Address, chainId: number, fetcher: typeof fetch = fetch) {
  const settled = new Map<bigint, RemoteAudit>();
  const txs = new Map<string, Hex>();
  const seen = new Set<Hex>();
  let remote: { id: Hex; sampler: Address } | undefined;

  const read = <T>(functionName: 'requestOfRemoteAudit' | 'pending', id: bigint) =>
    client.readContract({ address: adapter, abi: ADAPTER_ABI, functionName, args: [id] }) as Promise<T>;

  async function listTransactions() {
    const res = await fetcher(`${DATA_API}/v1/chains/${chainId}/addresses/${adapter}/transactions?pageSize=100&sortOrder=desc`);
    if (!res.ok) throw new Error(`Avalanche Data API answered ${res.status}`);
    const body = (await res.json()) as { transactions?: { nativeTransaction: DataApiTx }[] };
    const fresh = (body.transactions ?? []).map((t) => t.nativeTransaction).filter((t) => t.txStatus === '1' && !seen.has(t.txHash));
    const receipts = await Promise.all(fresh.map((t) => client.getTransactionReceipt({ hash: t.txHash })));
    receipts.forEach((receipt, i) => {
      const logs = receipt.logs.filter((l) => l.address.toLowerCase() === adapter.toLowerCase());
      for (const log of parseEventLogs({ abi: ADAPTER_ABI, logs })) {
        txs.set(`${log.eventName === 'RemoteRequestFiled' ? 'filed' : 'forward'}:${log.args.remoteAuditId}`, fresh[i].txHash);
      }
      seen.add(fresh[i].txHash);
    });
  }

  return async (): Promise<IcmSnapshot> => {
    if (!remote) {
      const [id, sampler] = await Promise.all([
        client.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: 'remoteBlockchainID' }),
        client.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: 'remoteSampler' }),
      ]);
      remote = { id, sampler };
    }
    const audits: RemoteAudit[] = [];
    for (let id = 1n, misses = 0; misses < GAP; id++) {
      const known = settled.get(id);
      if (known) {
        audits.push(known);
        continue;
      }
      const oracleRequestId = await read<bigint>('requestOfRemoteAudit', id);
      if (oracleRequestId === 0n) {
        misses++;
        continue;
      }
      misses = 0;
      const [, commitment, , randomness, answered, forwarded] = await read<readonly [bigint, Hex, Hex, bigint, boolean, boolean]>('pending', oracleRequestId);
      audits.push({ auditId: id, oracleRequestId, commitment, answered, randomness: answered ? randomness : undefined, forwarded });
    }
    if (DATA_API_CHAINS.has(chainId) && audits.some((a) => !a.filedTx || (a.forwarded && !a.forwardTx))) {
      // The hashes are extra: without them the page still shows every audit and links the adapter.
      await listTransactions().catch(() => {});
    }
    for (const a of audits) {
      a.filedTx ??= txs.get(`filed:${a.auditId}`);
      a.forwardTx ??= txs.get(`forward:${a.auditId}`);
      if (a.forwarded && a.filedTx && a.forwardTx) settled.set(a.auditId, a);
    }
    const balance = await client.getBalance({ address: adapter });
    return { remoteBlockchainID: remote.id, remoteSampler: remote.sampler, balance, audits: audits.reverse() };
  };
}
