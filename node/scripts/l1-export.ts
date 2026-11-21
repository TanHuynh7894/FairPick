// Writes what the fairpick L1 holds about its audits, and who may send transactions on it, to
// dashboard/src/l1-audits.json. Judges cannot reach the L1's RPC (it is local), so the page ships this file and
// checks it against Fuji: each audit's commitment must equal the one the adapter received over ICM, and the
// receipts must follow from the oracle's answer on Fuji. Run through ../scripts/l1-export.sh, which loads .env.
import { writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const BLOCKCHAIN_ID = '24ttXXTxYDu7QNNMbdMkmjiZkBB5zYN5qQikNWTr3REqcibFYg';
const fairpick = defineChain({
  id: 510103,
  name: 'fairpick',
  nativeCurrency: { name: 'FPK', symbol: 'FPK', decimals: 18 },
  rpcUrls: { default: { http: [process.env.L1_RPC ?? `http://127.0.0.1:9650/ext/bc/${BLOCKCHAIN_ID}/rpc`] } },
});
const l1 = createPublicClient({ chain: fairpick, transport: http() });
const sampler = getAddress(process.env.L1_SAMPLER ?? '0x3A54a96d74891C3d8E707760A60A1Ef96e07f7dF');

const samplerAbi = parseAbi([
  'function auditCount() view returns (uint256)',
  'function audits(uint256) view returns ((address requester, uint32 itemCount, uint16 sampleSize, bool settled, address auditor, bytes32 fileHash, uint256 oracleRequestId, bytes32 requestBlockHash, uint256[2] signature, uint256 seed, uint32[] picks, string label))',
  'event AuditRequested(uint256 indexed auditId, address indexed requester, bytes32 indexed fileHash, address auditor, bytes32 messageID)',
  'event AuditPicked(uint256 indexed auditId, uint256 indexed oracleRequestId, uint256 seed, bytes32 requestBlockHash, uint32[] picks)',
]);
const allowListAbi = parseAbi(['function readAllowList(address) view returns (uint256)']);
const ROLES = ['none', 'enabled', 'admin', 'manager'];

// Who each allow-listed address is. The genesis and l1/upgrade.json list them; the roles are read live below.
const WHO: [Address, string][] = [
  ['0x8e19042500d59CB3DceFC508221af9630337Fa75', 'Audit office (auditor, allow-list admin)'],
  ['0x7855c958eC2e104D358aBAd285b50e7C759547F9', 'Team ops (validator manager owner)'],
  ['0x05431B6a89398994B65Fa8cc71d94afa57298639', 'Treasurer'],
  ['0x474044236309DC089A92c5AB9A3daF853831F1DC', 'ICM relayer'],
  ['0x9D75a7fF8DA5B07BF624C2e5B17208f33fcc36C5', 'Genesis FPK holder'],
];
if (process.env.L1_MEMBER_KEY) WHO.push([privateKeyToAccount(process.env.L1_MEMBER_KEY as Hex).address, 'Treasurer 2: enabled, filed an audit, then removed']);
const OUTSIDER: Address = '0x2cC649f2d93bF4b7d8Fb031D00B155171e99a77E';

const head = await l1.getBlockNumber();
const [requested, picked] = await Promise.all([
  l1.getContractEvents({ address: sampler, abi: samplerAbi, eventName: 'AuditRequested', fromBlock: 0n, toBlock: head }),
  l1.getContractEvents({ address: sampler, abi: samplerAbi, eventName: 'AuditPicked', fromBlock: 0n, toBlock: head }),
]);
const count = await l1.readContract({ address: sampler, abi: samplerAbi, functionName: 'auditCount' });
const audits = [];
for (let id = 1n; id <= count; id++) {
  const a = await l1.readContract({ address: sampler, abi: samplerAbi, functionName: 'audits', args: [id] });
  audits.push({
    auditId: Number(id),
    label: a.label,
    itemCount: a.itemCount,
    sampleSize: a.sampleSize,
    fileHash: a.fileHash,
    auditor: a.auditor,
    requester: a.requester,
    settled: a.settled,
    oracleRequestId: Number(a.oracleRequestId),
    picks: a.picks,
    requestTx: requested.find((e) => e.args.auditId === id)?.transactionHash ?? null,
    answerTx: picked.find((e) => e.args.auditId === id)?.transactionHash ?? null,
  });
}
const writers = [];
for (const [address, who] of [...WHO, [OUTSIDER, 'Outsider (test wallet)'] as [Address, string]]) {
  const role = await l1.readContract({ address: '0x0200000000000000000000000000000000000002', abi: allowListAbi, functionName: 'readAllowList', args: [address] });
  writers.push({ address, who, role: ROLES[Number(role)] });
}

const out = {
  readAt: new Date().toISOString(),
  l1: { name: 'fairpick', chainId: fairpick.id, blockchainID: BLOCKCHAIN_ID, subnetID: 'xhPrD6175hcsC8WRTb1e64c7agEkcBmkLA1YFtuTVxi42dXmj', block: Number(head) },
  sampler,
  audits,
  writers,
};
writeFileSync(new URL('../../dashboard/src/l1-audits.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`L1 block ${head}: ${audits.length} audits, ${writers.length} addresses -> dashboard/src/l1-audits.json`);
for (const w of writers) console.log(`${w.role.padEnd(8)} ${w.address} ${w.who}`);
