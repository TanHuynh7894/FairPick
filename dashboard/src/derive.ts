// What the dashboard concludes from chain data. Pure, so every rule here is tested without a chain.
import { encodeAbiParameters, keccak256, parseEther, type Address, type Hex } from 'viem';

/** RandomnessOracle.EXPIRY_BLOCKS */
export const EXPIRY_BLOCKS = 256n;
/** Below this many blocks left, a waiting request is about to be lost. */
const EXPIRING_BLOCKS = 32;
const SLOW_BLOCKS = 10n;
/** Avalanche makes no blocks on a quiet chain, so a dead node may not show up in block counts at all. */
const SLOW_SECONDS = 60;

export interface OracleAnswer {
  randomness: bigint;
  callbackOk: boolean;
  txHash: Hex;
  block: bigint;
  latencySec: number;
  latencyBlocks: number;
  /** The wallet that sent the answer, and the gas it used, when the transaction itself was read. */
  from?: Address;
  gasUsed?: bigint;
}

export interface OracleRequest {
  id: bigint;
  consumer: Address;
  requestBlock: bigint;
  requestTime: number;
  /** RandomnessOracle.Status: 1 pending, 2 fulfilled, 3 expired. */
  status: number;
  /** Absent until the answer's transaction has been found. */
  answer?: OracleAnswer;
  /** The transaction that made the request, when the Avalanche Data API listed it. */
  requestTx?: Hex;
  /** Set when the consumer is the configured AuditSampler. */
  audit?: Audit;
  refunded?: boolean;
}

/** AuditSampler.audits(id), plus the receipts it picked once settled. */
export interface Audit {
  requester: Address;
  itemCount: number;
  sampleSize: number;
  /** 1 for the first request under this announcement. Higher only after an unanswered draw was refunded. */
  draw: number;
  settled: boolean;
  refunded: boolean;
  /** Who announced the list before the draw. The requester itself when there was no separate auditor. */
  auditor: Address;
  /** The auditor's result, once recorded: bit i of `missing` says the i-th drawn receipt was not found. */
  reported: boolean;
  missing: number;
  /** keccak256 of the list's canonical bytes. */
  fileHash: Hex;
  seed: bigint;
  label: string;
  /** 1-based receipt numbers, in draw order. Empty until settled. */
  picks: number[];
}

export interface BeaconRound {
  id: bigint;
  creator: Address;
  commitEnd: number;
  revealEnd: number;
  minParticipants: number;
  commits: number;
  reveals: number;
  /** RandomnessBeacon.Status: 0 open, 1 finalized, 2 failed. */
  status: number;
  bond: bigint;
  randomness: bigint;
  /** Size of the member list, or 0 for a round any address can join. */
  members: number;
}

export type RequestStateName = 'pending' | 'overdue' | 'fulfilled' | 'expired';

export function requestState(r: Pick<OracleRequest, 'status' | 'requestBlock'>, head: bigint): { state: RequestStateName; blocksLeft: number } {
  if (r.status === 2) return { state: 'fulfilled', blocksLeft: 0 };
  if (r.status === 3) return { state: 'expired', blocksLeft: 0 };
  // An answer lands in head + 1 at the earliest and must be at most EXPIRY_BLOCKS after the request.
  const left = r.requestBlock + EXPIRY_BLOCKS - head;
  return left > 0n ? { state: 'pending', blocksLeft: Number(left) } : { state: 'overdue', blocksLeft: 0 };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(requests: readonly OracleRequest[], head: bigint) {
  const count = { pending: 0, overdue: 0, fulfilled: 0, expired: 0 };
  for (const r of requests) count[requestState(r, head).state]++;
  const answers = requests.flatMap((r) => (r.answer ? [r.answer] : []));
  const closed = count.fulfilled + count.expired + count.overdue;
  return {
    ...count,
    /** Share of the requests that are past waiting and got an answer. */
    answeredShare: closed === 0 ? null : count.fulfilled / closed,
    medianLatencySec: median(answers.map((a) => a.latencySec)),
    callbackFailures: answers.filter((a) => !a.callbackOk).length,
  };
}

export type HealthCode = 'idle' | 'ok' | 'waiting' | 'slow' | 'overdue' | 'expiring';
export interface Health {
  level: 'good' | 'warning' | 'critical';
  code: HealthCode;
  count: number;
}

export function oracleHealth(requests: readonly OracleRequest[], head: bigint, nowSec: number): Health {
  if (requests.length === 0) return { level: 'good', code: 'idle', count: 0 };
  const open = requests.filter((r) => r.status === 1).map((r) => ({ r, ...requestState(r, head) }));
  const waiting = open.filter((o) => o.state === 'pending');

  const expiring = waiting.filter((o) => o.blocksLeft <= EXPIRING_BLOCKS).length;
  if (expiring > 0) return { level: 'critical', code: 'expiring', count: expiring };

  const slow = waiting.filter((o) => head - o.r.requestBlock > SLOW_BLOCKS || nowSec - o.r.requestTime > SLOW_SECONDS).length;
  if (slow > 0) return { level: 'warning', code: 'slow', count: slow };

  const overdue = open.length - waiting.length;
  if (overdue > 0) return { level: 'warning', code: 'overdue', count: overdue };

  return waiting.length > 0 ? { level: 'good', code: 'waiting', count: waiting.length } : { level: 'good', code: 'ok', count: 0 };
}

/**
 * AuditSampler.pick: draw i is keccak256(abi.encode(seed, i, try)) mod itemCount, plus 1, retried on a repeat.
 * Kept identical to the contract so a browser can recompute a sample from the verified randomness.
 */
export function pickSample(seed: bigint, itemCount: number, sampleSize: number): number[] {
  if (sampleSize < 1 || sampleSize > 32 || sampleSize > itemCount) throw new Error('bad sample size');
  const picks: number[] = [];
  const n = BigInt(itemCount);
  for (let i = 0; picks.length < sampleSize; i++) {
    for (let t = 0; ; t++) {
      const h = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [seed, BigInt(i), BigInt(t)]));
      const candidate = Number(BigInt(h) % n) + 1;
      if (!picks.includes(candidate)) {
        picks.push(candidate);
        break;
      }
    }
  }
  return picks;
}

/** Receipt numbers as a fixed width, so a column of picks lines up: 7 of 40 reads "07". */
export function receiptNo(n: number, itemCount: number): string {
  return String(n).padStart(String(itemCount).length, '0');
}

export type BeaconPhase = 'commit' | 'reveal' | 'finalizable' | 'finalized' | 'failed';

export function beaconPhase(r: BeaconRound, nowSec: number): BeaconPhase {
  if (r.status === 1) return 'finalized';
  if (r.status === 2) return 'failed';
  if (nowSec <= r.commitEnd) return 'commit';
  if (r.reveals === r.commits || nowSec > r.revealEnd) return 'finalizable';
  return 'reveal';
}

/** Deposits that stay in the contract for good: those of members who did not reveal in a round that reached its minimum. */
export function lockedBond(r: BeaconRound): bigint {
  if (r.status !== 2 || r.commits < r.minParticipants) return 0n;
  return BigInt(r.commits - r.reveals) * r.bond;
}

/** The value drawn, one level per 16-bit word, most significant first. Nothing here is decoration. */
export function fingerprint(value: bigint): number[] {
  const levels: number[] = [];
  for (let word = 15n; word >= 0n; word--) levels.push(Number((value >> (word * 16n)) & 0xffffn) / 0xffff);
  return levels;
}

/** AuditSampler.listKey: what one announcement is filed under. */
export const listKey = (auditor: Address, fileHash: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [auditor, fileHash]));

/** An audit whose auditor is its own requester has nobody independent behind the choice of list. */
export const selfAnnounced = (a: Pick<Audit, 'auditor' | 'requester'>) => a.auditor.toLowerCase() === a.requester.toLowerCase();

/** The receipts the auditor reported as not found, lowest first. `missing` counts positions in draw order. */
export function missingReceipts(a: Pick<Audit, 'picks' | 'missing'>): number[] {
  return a.picks.filter((_, i) => (a.missing >> i) & 1).sort((x, y) => x - y);
}

/** The report mask for a set of receipt numbers the auditor did not find. */
export function missingMask(picks: readonly number[], notFound: ReadonlySet<number>): number {
  return picks.reduce((mask, p, i) => (notFound.has(p) ? mask | (1 << i) : mask), 0);
}

/** The audits of one wallet among those loaded, oldest first, to put a single audit in context. */
export function auditsOf(requests: readonly OracleRequest[], requester: Address): OracleRequest[] {
  return requests.filter((r) => r.audit?.requester.toLowerCase() === requester.toLowerCase()).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function matchesSearch(r: OracleRequest, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  if (r.id.toString() === q) return true;
  const randomness = r.answer ? `0x${r.answer.randomness.toString(16).padStart(64, '0')}` : '';
  if (r.audit?.label.toLowerCase().includes(q)) return true;
  return [r.consumer, r.answer?.txHash ?? '', randomness, r.audit?.fileHash ?? '', r.audit?.requester ?? '', r.audit?.auditor ?? ''].some((text) => q.startsWith('0x') && text.toLowerCase().includes(q));
}

/** What to draw for a round's participants. Bounded, since minParticipants is whatever a round's creator chose. */
export function seatCells(r: BeaconRound, max = 32) {
  const seats = Math.max(r.commits, r.minParticipants);
  const revealed = Math.min(r.reveals, max);
  const committed = Math.min(r.commits - r.reveals, max - revealed);
  const empty = Math.min(seats - r.commits, max - revealed - committed);
  return { revealed, committed, empty, hidden: seats - revealed - committed - empty };
}

export interface BeaconEntry {
  commitment: Hex;
  committed: boolean;
  revealed: boolean;
  claimed: boolean;
}

export type ClaimState = 'open' | 'none' | 'claimable' | 'claimed' | 'forfeited';

/** Mirrors RandomnessBeacon.claim. */
export function claimState(r: BeaconRound, e: BeaconEntry | null): ClaimState {
  if (r.status === 0) return 'open';
  if (!e?.committed) return 'none';
  if (e.claimed) return 'claimed';
  return !e.revealed && r.commits >= r.minParticipants ? 'forfeited' : 'claimable';
}

/** What the contract would accept now. The chain's next block may differ by a moment, and the send re-checks. */
export function beaconActions(r: BeaconRound, e: BeaconEntry | null, nowSec: number) {
  const open = r.status === 0;
  return {
    commit: open && nowSec <= r.commitEnd && !e?.committed,
    reveal: open && nowSec > r.commitEnd && nowSec <= r.revealEnd && Boolean(e?.committed) && !e?.revealed,
    finalize: beaconPhase(r, nowSec) === 'finalizable',
    claim: claimState(r, e) === 'claimable',
  };
}

export function auditActions(r: OracleRequest, head: bigint) {
  const { state } = requestState(r, head);
  return {
    /** The callback failed, so the audit has no sample yet. */
    settle: state === 'fulfilled' && Boolean(r.answer) && Boolean(r.audit) && !r.audit!.settled,
    refund: (state === 'overdue' || state === 'expired') && !r.refunded,
  };
}

export function consumerStats(requests: readonly OracleRequest[], head: bigint, consumerAddress: Address) {
  const mine = requests.filter((r) => r.consumer.toLowerCase() === consumerAddress.toLowerCase());
  const s = summarize(mine, head);
  return {
    total: mine.length,
    answered: s.fulfilled,
    open: s.pending + s.overdue,
    expired: s.expired,
    callbackFailures: s.callbackFailures,
    medianLatencySec: s.medianLatencySec,
  };
}

/** The oracle owes its earned fees, the refunds it credited, and the fee of every request still open. */
export function reconcile(a: { balance: bigint; earned: bigint; refunds: bigint; pending: number; fee: bigint }) {
  const owed = a.earned + a.refunds + BigInt(a.pending) * a.fee;
  const surplus = a.balance - owed;
  return { owed, surplus, ok: surplus >= 0n };
}

/** Below this many answers' worth of gas, the node needs topping up. */
const LOW_GAS_ANSWERS = 10n;

export interface AdminAlert {
  level: 'warning' | 'critical';
  code: 'node-expiring' | 'node-slow' | 'node-overdue' | 'shortfall' | 'gas-out' | 'gas-low' | 'fee-below-cost' | 'callback-failures';
  count?: number;
}

export function adminAlerts(a: {
  health: Health;
  fee: bigint;
  /** Null until an answer gives a cost to compare with. */
  avgCost: bigint | null;
  walletBalance: bigint;
  callbackFailures: number;
  /** Null when the window does not cover every request, so nothing can be said. */
  reconcileOk: boolean | null;
}): AdminAlert[] {
  const alerts: AdminAlert[] = [];
  if (a.health.code === 'expiring') alerts.push({ level: 'critical', code: 'node-expiring', count: a.health.count });
  if (a.health.code === 'slow') alerts.push({ level: 'warning', code: 'node-slow', count: a.health.count });
  if (a.health.code === 'overdue') alerts.push({ level: 'warning', code: 'node-overdue', count: a.health.count });
  if (a.reconcileOk === false) alerts.push({ level: 'critical', code: 'shortfall' });
  if (a.avgCost !== null) {
    if (a.walletBalance < a.avgCost) alerts.push({ level: 'critical', code: 'gas-out' });
    else if (a.walletBalance < a.avgCost * LOW_GAS_ANSWERS) alerts.push({ level: 'warning', code: 'gas-low' });
    if (a.avgCost > a.fee) alerts.push({ level: 'warning', code: 'fee-below-cost' });
  }
  if (a.callbackFailures > 0) alerts.push({ level: 'warning', code: 'callback-failures', count: a.callbackFailures });
  return alerts.sort((x, y) => Number(y.level === 'critical') - Number(x.level === 'critical'));
}

export type RoundForm = Record<'commitMinutes' | 'revealMinutes' | 'bond' | 'minParticipants', string>;
const WHOLE = /^\d+$/;
const UINT32_MAX = 4_294_967_295;

export function parseRoundForm(f: RoundForm):
  | { ok: true; args: readonly [bigint, bigint, bigint, number] }
  | { ok: false; field: 'commit' | 'reveal' | 'bond' | 'minParticipants' } {
  if (!WHOLE.test(f.commitMinutes) || BigInt(f.commitMinutes) === 0n) return { ok: false, field: 'commit' };
  if (!WHOLE.test(f.revealMinutes) || BigInt(f.revealMinutes) === 0n) return { ok: false, field: 'reveal' };
  let bond: bigint;
  try {
    bond = parseEther(f.bond.trim() as `${number}`);
  } catch {
    return { ok: false, field: 'bond' };
  }
  if (bond <= 0n) return { ok: false, field: 'bond' };
  const min = Number(f.minParticipants);
  if (!WHOLE.test(f.minParticipants) || min < 2 || min > UINT32_MAX) return { ok: false, field: 'minParticipants' };
  return { ok: true, args: [BigInt(f.commitMinutes) * 60n, BigInt(f.revealMinutes) * 60n, bond, min] };
}
