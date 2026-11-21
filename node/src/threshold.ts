// Threshold BLS: the oracle key is split so that any t of n nodes can sign, and fewer than t learn nothing.
// A combined signature is exactly the signature of the full key, so the contract does not change.
import { bn254 } from '@noble/curves/bn254.js';
import { toHex, type Hex } from 'viem';
import { hashToG1, publicKey, sign, type G1Words, type G2Words } from './bls';

const { Point: G1 } = bn254.G1;
const { Point: G2 } = bn254.G2;
const R = G1.Fn.ORDER;

export interface Share { index: number; key: bigint }
export interface Partial { index: number; signature: G1Words }

const mod = (a: bigint) => ((a % R) + R) % R;
function inverse(a: bigint) {
  let [t, newT, r, newR] = [0n, 1n, R, mod(a)];
  while (newR !== 0n) { const q = r / newR; [t, newT] = [newT, t - q * newT]; [r, newR] = [newR, r - q * newR]; }
  return mod(t);
}
// Web Crypto, which Node and browsers both have: the page shares this file to check partial signatures.
const randomScalar = () => (BigInt(toHex(crypto.getRandomValues(new Uint8Array(64)))) % (R - 1n)) + 1n;

/** Shamir split of `key` into n shares with threshold t. Share i is f(i) for a random polynomial with f(0) = key. */
export function splitKey(key: bigint, t: number, n: number, random: () => bigint = randomScalar): Share[] {
  if (!(t >= 1 && t <= n && n < 256)) throw new Error('need 1 <= t <= n < 256');
  const coefficients = [mod(key), ...Array.from({ length: t - 1 }, random)];
  return Array.from({ length: n }, (_, i) => {
    const x = BigInt(i + 1);
    let y = 0n;
    for (let k = coefficients.length - 1; k >= 0; k--) y = mod(y * x + coefficients[k]);
    return { index: i + 1, key: y };
  });
}

/** Lagrange coefficient for share `i` at x = 0, given the indices taking part. */
export function lagrangeAtZero(i: number, indices: number[]) {
  let num = 1n, den = 1n;
  for (const j of indices) if (j !== i) { num = mod(num * BigInt(j)); den = mod(den * BigInt(j - i)); }
  return mod(num * inverse(den));
}

export const signPartial = (share: Share, message: Hex): Partial => ({ index: share.index, signature: sign(share.key, message) });
export const shareKey = (share: Share): G2Words => publicKey(share.key);

export function g2(words: G2Words) {
  const [xi, xr, yi, yr] = words;
  return G2.fromAffine({ x: { c0: xr, c1: xi }, y: { c0: yr, c1: yi } });
}

/** True if `signature` is valid for `message` under the public key `key` (a share key or the group key). */
export function verify(key: G2Words, message: Hex, signature: G1Words) {
  const h = hashToG1(message);
  const left = bn254.pairing(G1.fromAffine({ x: signature[0], y: signature[1] }), G2.BASE);
  const right = bn254.pairing(G1.fromAffine({ x: h.x, y: h.y }), g2(key));
  return bn254.fields.Fp12.eql(left, right);
}

/** Combines t partial signatures from distinct shares into the full-key signature. */
export function combine(partials: Partial[], t: number): G1Words {
  const unique = [...new Map(partials.map((p) => [p.index, p])).values()].slice(0, t);
  if (unique.length < t) throw new Error(`need ${t} partial signatures, have ${unique.length}`);
  const indices = unique.map((p) => p.index);
  let sum = G1.ZERO;
  for (const p of unique) sum = sum.add(G1.fromAffine({ x: p.signature[0], y: p.signature[1] }).multiply(lagrangeAtZero(p.index, indices)));
  const { x, y } = sum.toAffine();
  return [x, y];
}
