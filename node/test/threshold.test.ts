import { describe, expect, it } from 'vitest';
import { publicKey, sign } from '../src/bls';
import { combine, shareKey, signPartial, splitKey, verify } from '../src/threshold';

const SK = 0x1234567890abcdef1234567890abcdefn;
const M = `0x${'cd'.repeat(32)}` as const;

describe('threshold BLS', () => {
  const shares = splitKey(SK, 2, 3);

  it('any 2 of 3 partial signatures combine into the full-key signature', () => {
    const full = sign(SK, M);
    for (const pair of [[0, 1], [0, 2], [1, 2], [2, 0]]) {
      expect(combine(pair.map((i) => signPartial(shares[i], M)), 2)).toEqual(full);
    }
  });

  it('the combined signature verifies against the group key', () => {
    expect(verify(publicKey(SK), M, combine([signPartial(shares[0], M), signPartial(shares[2], M)], 2))).toBe(true);
  });

  it('one share alone is not enough', () => {
    expect(() => combine([signPartial(shares[1], M)], 2)).toThrow(/need 2/);
    expect(() => combine([signPartial(shares[1], M), signPartial(shares[1], M)], 2)).toThrow(/need 2/);
    expect(sign(shares[1].key, M)).not.toEqual(sign(SK, M));
  });

  it('a partial verifies against its own share key and no other', () => {
    const p = signPartial(shares[0], M);
    expect(verify(shareKey(shares[0]), M, p.signature)).toBe(true);
    expect(verify(shareKey(shares[1]), M, p.signature)).toBe(false);
  });

  it('works for 3 of 5', () => {
    const five = splitKey(SK, 3, 5);
    expect(combine([4, 1, 3].map((i) => signPartial(five[i], M)), 3)).toEqual(sign(SK, M));
  });
});
