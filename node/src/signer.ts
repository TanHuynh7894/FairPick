// Who produces the BLS signature for a request: one full key, or t of n nodes holding key shares.
import type { Hex } from 'viem';
import { publicKey, sign, type G1Words, type G2Words } from './bls';
import { combine, signPartial, verify, type Partial, type Share } from './threshold';

export interface Signer {
  /** The key the oracle contract was deployed with. */
  publicKey(): G2Words;
  /** Called for every request seen pending on chain, so this node can serve its partial to peers. */
  observe(requestId: bigint, message: Hex): void;
  /** The full signature, or null if not enough nodes have answered yet. Try again on the next tick. */
  sign(requestId: bigint, message: Hex): Promise<G1Words | null>;
}

export function keySigner(key: bigint): Signer {
  const pk = publicKey(key);
  return { publicKey: () => pk, observe() {}, sign: async (_id, message) => sign(key, message) };
}

export interface ThresholdOptions {
  share: Share;
  threshold: number;
  groupKey: G2Words;
  /** Public key of every share, by index, to reject a wrong partial from a faulty or lying peer. */
  shareKeys: Record<number, G2Words>;
  peers: string[];
  fetchPartial?: (peer: string, requestId: bigint) => Promise<Partial | null>;
  /** Called with the partial signatures that made up a full signature, to keep as evidence of who signed. */
  onCombined?: (evidence: { requestId: bigint; message: Hex; partials: Partial[]; signature: G1Words }) => void;
  log?: (message: string) => void;
}

export interface ThresholdSigner extends Signer {
  /** This node's partial for a request it has itself seen pending, for peers to collect. */
  partialFor(requestId: bigint): Partial | undefined;
  /** The partial signatures this node combined into an answer. Public once the answer is on chain. */
  evidenceFor(requestId: bigint): Partial[] | undefined;
}

async function httpPartial(peer: string, requestId: bigint): Promise<Partial | null> {
  const res = await fetch(`${peer}/partial/${requestId}`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const body = (await res.json()) as { index: number; signature: [string, string] };
  return { index: body.index, signature: [BigInt(body.signature[0]), BigInt(body.signature[1])] };
}

export function thresholdSigner(o: ThresholdOptions): ThresholdSigner {
  const fetchPartial = o.fetchPartial ?? httpPartial;
  const log = o.log ?? (() => {});
  // Only requests seen pending on chain are signed: a peer cannot get a partial for a message of its choosing.
  const seen = new Map<bigint, { message: Hex; partial: Partial }>();
  const combinedBy = new Map<bigint, Partial[]>();
  const own = (requestId: bigint, message: Hex) => {
    let entry = seen.get(requestId);
    if (!entry || entry.message !== message) { entry = { message, partial: signPartial(o.share, message) }; seen.set(requestId, entry); }
    return entry.partial;
  };
  // A peer's answer is untrusted: a wrong index, a value off the curve or a bad signature must only drop that partial.
  const validPartial = (p: Partial, message: Hex) => {
    try {
      if (!Number.isInteger(p.index) || p.index === o.share.index || !Object.hasOwn(o.shareKeys, p.index)) return false;
      return verify(o.shareKeys[p.index], message, p.signature);
    } catch {
      return false;
    }
  };
  return {
    publicKey: () => o.groupKey,
    observe(requestId, message) { own(requestId, message); },
    partialFor: (requestId) => seen.get(requestId)?.partial,
    evidenceFor: (requestId) => combinedBy.get(requestId),
    async sign(requestId, message) {
      const partials = [own(requestId, message)];
      const answers = await Promise.allSettled(o.peers.map((peer) => fetchPartial(peer, requestId)));
      for (const a of answers) {
        if (a.status !== 'fulfilled' || !a.value) continue;
        if (validPartial(a.value, message)) partials.push(a.value);
        else log(`rejected a bad partial from share ${a.value.index} for request ${requestId}`);
      }
      const used = [...new Map(partials.map((p) => [p.index, p])).values()].slice(0, o.threshold);
      if (used.length < o.threshold) { log(`request ${requestId}: ${used.length} of ${o.threshold} partial signatures`); return null; }
      const signature = combine(used, o.threshold);
      if (!verify(o.groupKey, message, signature)) return null;
      log(`request ${requestId}: combined the partial signatures of shares ${used.map((p) => p.index).join(' and ')}`);
      combinedBy.set(requestId, used);
      if (combinedBy.size > 1024) combinedBy.delete(combinedBy.keys().next().value!);
      o.onCombined?.({ requestId, message, partials: used, signature });
      return signature;
    },
  };
}
