// Checks an oracle answer in the browser, the way the contract does, from chain data alone.
import { bn254 } from '@noble/curves/bn254.js';
import { decodeFunctionData, encodeAbiParameters, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { hashToG1, messageFor, type G2Words } from '../../node/src/bls';
import { checkEvidence } from '../../node/src/evidence';
import { ORACLE_ABI } from './chain';
import { pickSample, type OracleRequest } from './derive';

const { Point: G1 } = bn254.G1;
const { Point: G2 } = bn254.G2;

/** Which key shares signed an answer, checked against the share keys stored in the oracle. */
export interface SignedBy {
  shares: number[];
  threshold: number;
  count: number;
  ok: boolean;
}

export type Verification =
  | { kind: 'unreadable' }
  | { kind: 'checked'; message: Hex; signature: [bigint, bigint]; signatureOk: boolean; randomnessOk: boolean; picksOk?: boolean; signedBy: SignedBy | null; ms: number };

interface PartialFile { index: number; signature: [string, string] }
// Partial signatures the nodes kept for past answers (docs/evidence), built into the page.
const BUNDLED = import.meta.glob('../../docs/evidence/audit-*.json', { eager: true, import: 'default' }) as Record<string, { oracle: string; requestId: string; partials: PartialFile[] }>;
/** Nodes this page may ask for the partial signatures of an answer. They are public once the answer is on chain. */
const NODE_URLS = ((import.meta.env?.VITE_NODE_URLS as string | undefined) ?? '').split(',').map((u) => u.trim()).filter(Boolean);

async function findPartials(oracle: Address, id: bigint, fetcher: typeof fetch, nodeUrls: readonly string[]): Promise<PartialFile[] | null> {
  const known = Object.values(BUNDLED).find((f) => f.oracle.toLowerCase() === oracle.toLowerCase() && f.requestId === id.toString());
  if (known) return known.partials;
  for (const url of nodeUrls) {
    try {
      const res = await fetcher(`${url}/evidence/${id}`, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) return ((await res.json()) as { partials: PartialFile[] }).partials;
    } catch {
      // That node is down or did not put this answer together. Ask the next one.
    }
  }
  return null;
}

/**
 * Null when nobody has the partial signatures, or the oracle has a single signer. Otherwise whether the partials
 * verify under the share keys the oracle was deployed with and combine to the signature in the answer.
 */
export async function verifyShares(client: PublicClient, oracle: Address, id: bigint, message: Hex, signature: readonly [bigint, bigint], fetcher: typeof fetch = fetch, nodeUrls: readonly string[] = NODE_URLS): Promise<SignedBy | null> {
  const [threshold, count] = await Promise.all([
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'threshold' }),
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'shareCount' }).then(Number),
  ]);
  if (count === 0) return null;
  const partials = await findPartials(oracle, id, fetcher, nodeUrls);
  if (!partials) return null;
  const [groupKey, ...shareKeys] = await Promise.all([
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'publicKey' }),
    ...Array.from({ length: count }, (_, i) => client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'shareKey', args: [BigInt(i + 1)] })),
  ]);
  const check = checkEvidence(
    { groupKey: groupKey as unknown as G2Words, threshold, shareKeys: shareKeys as unknown as G2Words[] },
    { message, signature, partials: partials.map((p) => ({ index: p.index, signature: [BigInt(p.signature[0]), BigInt(p.signature[1])] as const })) },
  );
  return { shares: partials.map((p) => p.index).sort((a, b) => a - b), threshold, count, ok: check.ok };
}

/** e(signature, G2) == e(H(message), publicKey), the same equation the contract hands to the precompile. */
function pairingHolds(publicKey: readonly bigint[], message: Hex, signature: readonly [bigint, bigint]): boolean {
  try {
    const sig = G1.fromAffine({ x: signature[0], y: signature[1] });
    sig.assertValidity();
    const [xi, xr, yi, yr] = publicKey;
    const pk = G2.fromAffine({ x: { c0: xr, c1: xi }, y: { c0: yr, c1: yi } });
    const h = hashToG1(message);
    return bn254.fields.Fp12.eql(bn254.pairing(sig, G2.BASE), bn254.pairing(G1.fromAffine({ x: h.x, y: h.y }), pk));
  } catch {
    return false; // Not a point on the curve, which the precompile refuses too.
  }
}

/**
 * The signature is only in the transaction's calldata, so an answer sent through another contract cannot be read
 * here. That says nothing against the answer: the contract checked it either way.
 */
export async function verifyAnswer(client: PublicClient, chainId: number, oracle: Address, request: OracleRequest): Promise<Verification> {
  if (!request.answer) throw new Error('This request has no answer to check');
  const [publicKey, tx, block] = await Promise.all([
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'publicKey' }),
    client.getTransaction({ hash: request.answer.txHash }),
    client.getBlock({ blockNumber: request.requestBlock }),
  ]);
  if (tx.to?.toLowerCase() !== oracle.toLowerCase()) return { kind: 'unreadable' };

  let signature: [bigint, bigint];
  try {
    const call = decodeFunctionData({ abi: ORACLE_ABI, data: tx.input });
    if (call.functionName !== 'fulfill' || call.args[0] !== request.id) return { kind: 'unreadable' };
    signature = [call.args[1][0], call.args[1][1]];
  } catch {
    return { kind: 'unreadable' };
  }

  const started = performance.now();
  const message = messageFor({ chainId, oracle, requestId: request.id, consumer: request.consumer, blockHash: block.hash });
  const signatureOk = pairingHolds(publicKey, message, signature);
  const hashed = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256[2]' }], [signature])));
  // For an audit, redo the sample from the number just checked, not from what the page was told.
  const a = request.audit;
  const picksOk = a?.settled ? a.seed === hashed && pickSample(hashed, a.itemCount, a.sampleSize).join() === a.picks.join() : undefined;
  const ms = performance.now() - started;
  // Which shares signed is extra: without the partial signatures the answer is checked all the same.
  const signedBy = await verifyShares(client, oracle, request.id, message, signature).catch(() => null);
  return { kind: 'checked', message, signature, signatureOk, randomnessOk: hashed === request.answer.randomness, picksOk, signedBy, ms };
}
