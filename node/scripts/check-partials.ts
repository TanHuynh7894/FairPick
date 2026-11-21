// Checks a saved answer against the chain: which key shares signed it.
//   npm run check-partials -- ../docs/evidence/audit-1.json [rpc url]
// The file names the oracle, the request, the answer's transaction and the partial signatures. Everything they are
// checked against is read from the oracle contract: its public key, its threshold and its share keys.
import { readFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem';
import { messageFor, type G1Words, type G2Words } from '../src/bls';
import { checkEvidence } from '../src/evidence';

const ABI = parseAbi([
  'function publicKey() view returns (uint256[4])',
  'function threshold() view returns (uint8)',
  'function shareCount() view returns (uint256)',
  'function shareKey(uint256 index) view returns (uint256[4])',
  'function requests(uint256) view returns (address consumer, uint64 requestBlock, uint8 status)',
  'function fulfill(uint256 requestId, uint256[2] signature)',
]);

interface File {
  oracle: Address;
  requestId: string;
  answerTx: Hex;
  partials: { index: number; signature: [string, string] }[];
}

const [path, rpcUrl = 'https://api.avax-test.network/ext/bc/C/rpc'] = process.argv.slice(2);
if (!path) throw new Error('usage: check-partials <evidence.json> [rpc url]');
const file = JSON.parse(readFileSync(path, 'utf8')) as File;
const client = createPublicClient({ transport: http(rpcUrl) });
const oracle = { address: file.oracle, abi: ABI } as const;

const requestId = BigInt(file.requestId);
const [chainId, groupKey, threshold, shareCount, [consumer, requestBlock], tx] = await Promise.all([
  client.getChainId(),
  client.readContract({ ...oracle, functionName: 'publicKey' }),
  client.readContract({ ...oracle, functionName: 'threshold' }),
  client.readContract({ ...oracle, functionName: 'shareCount' }),
  client.readContract({ ...oracle, functionName: 'requests', args: [requestId] }),
  client.getTransaction({ hash: file.answerTx }),
]);
const shareKeys = await Promise.all(Array.from({ length: Number(shareCount) }, (_, i) => client.readContract({ ...oracle, functionName: 'shareKey', args: [BigInt(i + 1)] })));
const block = await client.getBlock({ blockNumber: requestBlock });
const message = messageFor({ chainId, oracle: file.oracle, requestId, consumer, blockHash: block.hash });
const call = decodeFunctionData({ abi: ABI, data: tx.input });
const isAnswer = tx.to?.toLowerCase() === file.oracle.toLowerCase() && call.functionName === 'fulfill' && call.args[0] === requestId;
const signature: G1Words = call.functionName === 'fulfill' ? [call.args[1][0], call.args[1][1]] : [0n, 0n];

const check = checkEvidence(
  { groupKey: groupKey as unknown as G2Words, threshold, shareKeys: shareKeys as unknown as G2Words[] },
  { message, signature, partials: file.partials.map((p) => ({ index: p.index, signature: [BigInt(p.signature[0]), BigInt(p.signature[1])] as const })) },
);

const lines: [boolean, string][] = [
  [isAnswer, `tx ${file.answerTx} is fulfill(${requestId}) on oracle ${file.oracle}, sent by ${tx.from}`],
  [check.deployedAsSplit, `the oracle was deployed with a ${threshold}-of-${shareCount} key: its ${shareCount} share keys are on chain and any ${threshold} of them make up its public key`],
  [check.sharesNamed, `the file holds ${file.partials.length} partial signatures, of shares ${file.partials.map((p) => p.index).join(' and ')}`],
  [check.partialsOk, 'each one verifies under the on-chain key of its share, for the message the contract builds for this request'],
  [check.combinesToSignature, 'combined with Lagrange coefficients, they give exactly the signature in the transaction'],
  [check.signatureOk, "that signature verifies under the oracle's public key"],
];
for (const [ok, text] of lines) console.log(ok ? 'PASS' : 'FAIL', text);
process.exit(isAnswer && check.ok ? 0 : 1);
