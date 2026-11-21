// Prints a BLS key as env lines. Secret lines (ORACLE_BLS_KEY, ORACLE_SHARE_*) must go into files git ignores.
//   tsx src/keygen.ts                         one key, one node
//   tsx src/keygen.ts --threshold 2 --nodes 3 a key split so any 2 of 3 nodes can sign
//   add --split-existing to split ORACLE_BLS_KEY from the environment instead of making a new key
import { randomBytes } from 'node:crypto';
import { bn254 } from '@noble/curves/bn254.js';
import { toHex } from 'viem';
import { publicKey } from './bls';
import { shareKey, splitKey } from './threshold';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const order = bn254.G1.Point.Fn.ORDER;
const existing = process.argv.includes('--split-existing') ? process.env.ORACLE_BLS_KEY : undefined;
if (process.argv.includes('--split-existing') && !existing) throw new Error('ORACLE_BLS_KEY is not set');
const sk = existing ? BigInt(existing) : (BigInt(toHex(randomBytes(64))) % (order - 1n)) + 1n;
const hex = (v: bigint) => toHex(v, { size: 32 });
const words = (w: readonly bigint[]) => w.map(hex).join(',');

const t = Number(arg('threshold') ?? 0), n = Number(arg('nodes') ?? 0);
publicKey(sk).forEach((word, i) => console.log(`ORACLE_PK_${i}=${hex(word)}`));
if (!t) {
  console.log(`ORACLE_BLS_KEY=${hex(sk)}`);
} else {
  console.log(`ORACLE_THRESHOLD=${t}`);
  const shares = splitKey(sk, t, n);
  for (const s of shares) console.log(`ORACLE_SHARE_PK_${s.index}=${words(shareKey(s))}`);
  for (const s of shares) console.log(`ORACLE_SHARE_${s.index}=${hex(s.key)}`);
}
