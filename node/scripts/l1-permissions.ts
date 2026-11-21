// Who may send transactions on the fairpick L1, shown on the chain itself. Run through ../scripts/l1-permissions.sh.
//   onboard:  an outsider's audit request is refused by the node; the audit office admin enables a new treasurer
//             wallet (TxAllowList precompile) and sends it gas. The shell script then has that wallet file an audit.
//   offboard: the admin sets the treasurer back to none; its next transaction is refused again.
// Prints every hash and every refusal. Keys come from the environment and are never printed.
import { appendFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};
const step = process.argv[2];
if (step !== 'onboard' && step !== 'offboard') throw new Error('usage: l1-permissions onboard|offboard');

const ALLOW_LIST = '0x0200000000000000000000000000000000000002' as Address;
const ROLES = ['none', 'enabled', 'admin', 'manager'];
const fairpick = defineChain({
  id: 510103,
  name: 'fairpick',
  nativeCurrency: { name: 'FPK', symbol: 'FPK', decimals: 18 },
  rpcUrls: { default: { http: [process.env.L1_RPC ?? 'http://127.0.0.1:9650/ext/bc/24ttXXTxYDu7QNNMbdMkmjiZkBB5zYN5qQikNWTr3REqcibFYg/rpc'] } },
});
const l1 = createPublicClient({ chain: fairpick, transport: http() });
const admin = privateKeyToAccount(env('FUJI_KEY') as Hex); // the audit office: allow-list admin and auditor on the L1
const adminWallet = createWalletClient({ chain: fairpick, transport: http(), account: admin });
const sampler = env('L1_SAMPLER') as Address;

const allowListAbi = parseAbi([
  'function readAllowList(address) view returns (uint256)',
  'function setEnabled(address)',
  'function setNone(address)',
]);
const samplerAbi = parseAbi(['function requestAudit(bytes32 fileHash, address auditor, string label) returns (uint256)']);

const role = async (who: Address) => ROLES[Number(await l1.readContract({ address: ALLOW_LIST, abi: allowListAbi, functionName: 'readAllowList', args: [who] }))];
const show = (k: string, v: string) => console.log(`${k.padEnd(52)} ${v}`);

async function mined(hash: Hex) {
  const r = await l1.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`);
  return hash;
}

/** Signs locally and hands the raw transaction to the node, so a refusal comes from the node and not from a gas estimate. */
async function tryRequest(who: PrivateKeyAccount, what: string): Promise<void> {
  const data = encodeFunctionData({
    abi: samplerAbi,
    functionName: 'requestAudit',
    args: ['0x1111111111111111111111111111111111111111111111111111111111111111', admin.address, 'not announced'],
  });
  const [nonce, fees] = await Promise.all([l1.getTransactionCount({ address: who.address }), l1.estimateFeesPerGas()]);
  const raw = await who.signTransaction({ chainId: fairpick.id, to: sampler, data, nonce, gas: 300_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  try {
    const hash = await l1.sendRawTransaction({ serializedTransaction: raw });
    show(`${what}: NOT refused (unexpected)`, hash);
    process.exitCode = 1;
  } catch (e) {
    const msg = (e as { details?: string; shortMessage?: string }).details ?? (e as Error).message;
    show(`${what}: refused by the node`, msg.split('\n')[0]);
  }
}

if (step === 'onboard') {
  const outsider = privateKeyToAccount(env('OUTSIDER_KEY') as Hex);
  show('outsider', `${outsider.address} role=${await role(outsider.address)} balance=${await l1.getBalance({ address: outsider.address })} wei FPK`);
  await tryRequest(outsider, 'outsider requestAudit');

  // A new treasurer wallet for this run. Written to ../.env (git-ignored) so the next steps can use it.
  const key = generatePrivateKey();
  const member = privateKeyToAccount(key);
  appendFileSync('../.env', `# Treasurer onboarded by scripts/l1-permissions.sh on ${new Date().toISOString()} (test only)\nL1_MEMBER_KEY=${key}\n`);
  show('new treasurer (key in .env as L1_MEMBER_KEY)', `${member.address} role=${await role(member.address)}`);
  show('admin', `${admin.address} role=${await role(admin.address)}`);
  // Gas first, so that the refusal below is the allow-list's and not an empty balance.
  show('admin sends the treasurer 1 FPK for gas', await mined(await adminWallet.sendTransaction({ to: member.address, value: parseEther('1') })));
  await tryRequest(member, 'new treasurer before it is enabled');
  show('admin setEnabled(new treasurer)', await mined(await adminWallet.writeContract({ address: ALLOW_LIST, abi: allowListAbi, functionName: 'setEnabled', args: [member.address] })));
  show('new treasurer role now', await role(member.address));
} else {
  const member = privateKeyToAccount(env('L1_MEMBER_KEY') as Hex);
  show('admin setNone(treasurer), offboarded', await mined(await adminWallet.writeContract({ address: ALLOW_LIST, abi: allowListAbi, functionName: 'setNone', args: [member.address] })));
  show('treasurer role now', `${member.address} ${await role(member.address)}`);
  await tryRequest(member, 'offboarded treasurer requestAudit');
}
