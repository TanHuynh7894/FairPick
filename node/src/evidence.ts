// Checks that an answer was put together from partial signatures of the oracle's key shares.
//
// What is trusted comes from the oracle contract and nowhere else: its public key, its threshold and the public key of
// every share, all fixed at deployment. A file of evidence only supplies partial signatures. It must not supply the
// keys they are checked against: from the public signature alone, anyone can make up "share keys" that add up to the
// oracle's key together with "partial signatures" that fit them.
//
// What a pass shows: the signature sent to the contract is the combination of `threshold` signatures, each valid
// under a different share key the oracle was deployed with. What it cannot show: where those shares are kept, or that
// nobody holds the whole key. Whoever split the key knew all of it.
import { bn254 } from '@noble/curves/bn254.js';
import type { Hex } from 'viem';
import type { G1Words, G2Words } from './bls';
import { combine, g2, lagrangeAtZero, verify, type Partial } from './threshold';

const { Point: G2 } = bn254.G2;

/** Read from the oracle contract: publicKey(), threshold(), shareKey(1..shareCount()). */
export interface DeployedKey {
  groupKey: G2Words;
  threshold: number;
  /** Public key of share i at index i - 1. */
  shareKeys: readonly G2Words[];
}

export interface Evidence {
  message: Hex;
  partials: Partial[];
  /** The signature in the calldata of the answer. */
  signature: G1Words;
}

const same = (a: readonly bigint[], b: readonly bigint[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Every choice of k items out of `items`, in order. */
function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  return items.flatMap((item, i) => subsets(items.slice(i + 1), k - 1).map((rest) => [item, ...rest]));
}

/** The public key that the shares in `indices` add up to: the same Lagrange sum as for signatures, in G2. */
export function groupKeyFrom(shareKeys: readonly G2Words[], indices: number[]): G2Words {
  let sum = G2.ZERO;
  for (const i of indices) sum = sum.add(g2(shareKeys[i - 1]).multiply(lagrangeAtZero(i, indices)));
  const { x, y } = sum.toAffine();
  return [x.c1, x.c0, y.c1, y.c0];
}

/** The oracle refuses to deploy otherwise. Checked again here, so the result does not rest on that alone. */
export function isRealSplit(key: DeployedKey): boolean {
  const n = key.shareKeys.length;
  if (!Number.isInteger(key.threshold) || key.threshold < 2 || key.threshold > n) return false;
  if (key.shareKeys.some((k, i) => same(k, key.groupKey) || key.shareKeys.some((other, j) => j < i && same(k, other)))) return false;
  try {
    const indices = Array.from({ length: n }, (_, i) => i + 1);
    return subsets(indices, key.threshold).every((s) => same(groupKeyFrom(key.shareKeys, s), key.groupKey));
  } catch {
    return false; // A share key that is not a point of the group.
  }
}

export function checkEvidence(key: DeployedKey, e: Evidence) {
  const n = key.shareKeys.length;
  const indices = e.partials.map((p) => p.index);
  /** The oracle was deployed with a key split at least 2 ways, and its share keys make up its public key. */
  const deployedAsSplit = isRealSplit(key);
  /** Exactly `threshold` partials, each from a different share the oracle knows. */
  const sharesNamed = e.partials.length === key.threshold
    && indices.every((i) => Number.isInteger(i) && i >= 1 && i <= n)
    && new Set(indices).size === indices.length;
  const safe = <T>(work: () => T, otherwise: T) => { try { return work(); } catch { return otherwise; } };
  /** Each partial is a valid signature of the message under its own share's key, as deployed. */
  const partialsOk = sharesNamed && safe(() => e.partials.every((p) => verify(key.shareKeys[p.index - 1], e.message, p.signature)), false);
  /** The partials, combined, give exactly the signature that was sent to the contract. */
  const combinesToSignature = sharesNamed && safe(() => same(combine(e.partials, key.threshold), e.signature), false);
  /** That signature is valid under the oracle's public key. */
  const signatureOk = safe(() => verify(key.groupKey, e.message, e.signature), false);
  return { deployedAsSplit, sharesNamed, partialsOk, combinesToSignature, signatureOk, ok: deployedAsSplit && sharesNamed && partialsOk && combinesToSignature && signatureOk };
}
