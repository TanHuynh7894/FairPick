// Reads contract state over plain JSON-RPC. Works on any EVM node: no indexer, and no Multicall3, which anvil lacks.
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche, avalancheFuji } from 'viem/chains';
import { answersFor, type AnswerSource } from './answers';
import { EXPIRY_BLOCKS, pickSample, type Audit, type BeaconEntry, type BeaconRound, type OracleRequest } from './derive';


export const ORACLE_ABI = parseAbi([
  'function requestCount() view returns (uint256)',
  'function requests(uint256) view returns (address consumer, uint64 requestBlock, uint8 status)',
  'function fee() view returns (uint256)',
  'function operator() view returns (address)',
  'function earned() view returns (uint256)',
  'function publicKey() view returns (uint256[4])',
  'function threshold() view returns (uint8)',
  'function shareCount() view returns (uint256)',
  'function shareKey(uint256 index) view returns (uint256[4])',
  'function fulfill(uint256 requestId, uint256[2] signature)',
  'function withdraw()',
  'function expire(uint256 requestId)',
  'function refunds(address) view returns (uint256)',
  'function withdrawRefund(address to, uint256 amount)',
  'function CALLBACK_GAS() view returns (uint256)',
  'error WrongFee()',
  'error NotPending()',
  'error OutsideWindow()',
  'error NothingToWithdraw()',
  'error TransferFailed()',
]);
export const SAMPLER_ABI = parseAbi([
  'function announce(bytes32 fileHash, uint32 itemCount, uint16 sampleSize, address requester)',
  'function announcements(address auditor, bytes32 fileHash) view returns (address requester, uint32 itemCount, uint16 sampleSize)',
  'function announcedBy(address auditor) view returns (uint32)',
  'function requestAudit(bytes32 fileHash, address auditor, string label) payable returns (uint256)',
  'function report(uint256 requestId, uint32 missing)',
  'function audits(uint256) view returns ((address requester, uint32 itemCount, uint16 sampleSize, uint32 draw, bool settled, bool refunded, address auditor, bool reported, uint32 missing, bytes32 fileHash, uint256 seed, string label))',
  'function auditOfList(bytes32 listKey) view returns (uint256)',
  'function drawsOfList(bytes32 listKey) view returns (uint32)',
  'function drawsOfFile(bytes32 fileHash) view returns (uint32)',
  'function auditsBy(address requester) view returns (uint32)',
  'function commitmentOf(uint256 requestId) view returns (bytes32)',
  'function sampleOf(uint256 requestId) view returns (uint32[])',
  'function settle(uint256 requestId)',
  'function refund(uint256 requestId)',
  'error AlreadyAnnounced()',
  'error NotAnnounced()',
  'error AlreadyAudited(uint256 auditId)',
  'error NotAuditor()',
  'error AlreadyReported()',
  'error BadReport()',
  'error BadRequester()',
  'error NotRefundable()',
  'error NotFulfilled()',
  'error OutsideWindow()',
  'error BadSample()',
  'error LabelTooLong()',
  'error NotSettled()',
]);
export const BEACON_ABI = parseAbi([
  'function roundCount() view returns (uint256)',
  'function rounds(uint256) view returns (address creator, uint64 commitEnd, uint64 revealEnd, uint32 minParticipants, uint32 commits, uint32 reveals, uint8 status, uint256 bond, uint256 accumulator, uint256 randomness)',
  'function entries(uint256, address) view returns (bytes32 commitment, bool committed, bool revealed, bool claimed)',
  'function createRound(uint64 commitDuration, uint64 revealDuration, uint256 bond, uint32 minParticipants) returns (uint256)',
  'function createRound(uint64 commitDuration, uint64 revealDuration, uint256 bond, uint32 minParticipants, address[] members) returns (uint256)',
  'function memberCount(uint256) view returns (uint32)',
  'function isMember(uint256, address) view returns (bool)',
  'function commit(uint256 roundId, bytes32 commitment) payable',
  'function reveal(uint256 roundId, bytes32 secret)',
  'function finalize(uint256 roundId)',
  'function claim(uint256 roundId)',
  'error BadParams()',
  'error WrongPhase()',
  'error WrongBond()',
  'error AlreadyCommitted()',
  'error NotCommitted()',
  'error AlreadyRevealed()',
  'error BadReveal()',
  'error AlreadyFinalized()',
  'error NotFinalized()',
  'error NothingToClaim()',
  'error TransferFailed()',
  'error NotMember()',
]);

export const makeClient = (rpcUrl: string): PublicClient =>
  createPublicClient({ transport: http(rpcUrl, { batch: true, timeout: 8_000 }) });

export interface OracleSnapshot {
  head: bigint;
  headTime: number;
  total: number;
  fee: bigint;
  operator: Address;
  earned: bigint;
  balance: bigint;
  /** How many key shares it takes to sign, as fixed in the contract. 1 with 0 shares is a single signer. */
  threshold: number;
  shares: number;
  /** Newest first, and at most the reader's limit. */
  requests: OracleRequest[];
}

export interface BeaconSnapshot {
  head: bigint;
  headTime: number;
  total: number;
  /** Newest first, and at most the reader's limit. */
  rounds: BeaconRound[];
}


const newestIds = (total: bigint, first: bigint, limit: number) => {
  const ids: bigint[] = [];
  for (let id = total - 1n + first; id >= first && ids.length < limit; id--) ids.push(id);
  return ids;
};

/**
 * Closed requests never change, so each is read once. Everything is forgotten if the chain goes backwards.
 * `answers` says where answer transactions are looked up. Left out, it is chosen from the chain: see answers.ts.
 */
export function createOracleReader(client: PublicClient, oracle: Address, sampler?: Address, limit = 200, answers?: AnswerSource) {
  const contract = { address: oracle, abi: ORACLE_ABI } as const;
  let closed = new Map<bigint, OracleRequest>();
  let doneAudits = new Map<bigint, Audit>();
  let blockTimes = new Map<bigint, number>();
  let lastHead = 0n;
  let split: [threshold: number, shares: number] | undefined;

  /** In seconds. Avalanche blocks also carry milliseconds, which is what makes a 1.4 s answer measurable. */
  const blockTime = async (number: bigint) => {
    let time = blockTimes.get(number);
    if (time === undefined) {
      const block = await client.getBlock({ blockNumber: number });
      const ms = (block as { timestampMilliseconds?: Hex }).timestampMilliseconds;
      time = ms ? Number(BigInt(ms)) / 1000 : Number(block.timestamp);
      blockTimes.set(number, time);
    }
    return time;
  };

  async function readRequest(id: bigint, head: bigint, source: AnswerSource): Promise<OracleRequest> {
    const cached = closed.get(id);
    if (cached) return cached;
    const [consumer, requestBlock, status] = await client.readContract({ ...contract, functionName: 'requests', args: [id] });
    const request: OracleRequest = { id, consumer, requestBlock, status, requestTime: await blockTime(requestBlock) };

    if (status === 2) {
      const found = await source.find(id, requestBlock, head);
      // An indexer or a node behind a load balancer may not have it yet. Leave it uncached and look again next time.
      if (!found) return request;
      request.answer = {
        ...found,
        latencySec: Math.round(((await blockTime(found.block)) - request.requestTime) * 10) / 10,
        latencyBlocks: Number(found.block - requestBlock),
      };
    }
    request.requestTx = source.requestTx?.(id);
    if (status !== 1) closed.set(id, request);
    return request;
  }

  async function readAudit(id: bigint): Promise<Audit> {
    const known = doneAudits.get(id);
    if (known) return known;
    const a = await client.readContract({ address: sampler!, abi: SAMPLER_ABI, functionName: 'audits', args: [id] });
    const audit: Audit = { ...a, picks: a.settled ? pickSample(a.seed, a.itemCount, a.sampleSize) : [] };
    // Nothing changes any more once the auditor has reported, or once the fee went back.
    if (a.reported || a.refunded) doneAudits.set(id, audit);
    return audit;
  }

  return async function read(): Promise<OracleSnapshot> {
    const [total, fee, operator, earned, balance] = await Promise.all([
      client.readContract({ ...contract, functionName: 'requestCount' }),
      client.readContract({ ...contract, functionName: 'fee' }),
      client.readContract({ ...contract, functionName: 'operator' }),
      client.readContract({ ...contract, functionName: 'earned' }),
      client.getBalance({ address: oracle }),
    ]);
    // Fixed at deployment, so read once.
    const [threshold, shares] = split ?? await Promise.all([
      client.readContract({ ...contract, functionName: 'threshold' }),
      client.readContract({ ...contract, functionName: 'shareCount' }).then(Number),
    ]);
    split = [threshold, shares];
    // Read after the state above, so every answer that state mentions is at or below this head.
    const latest = await client.getBlock({ blockTag: 'latest' });
    if (latest.number < lastHead) {
      closed = new Map();
      doneAudits = new Map();
      blockTimes = new Map();
    }
    lastHead = latest.number;

    answers ??= answersFor(client, oracle, await client.getChainId(), import.meta.env?.VITE_LOCAL_FORK === '1');
    const source = answers;
    const requests = await Promise.all(newestIds(total, 1n, limit).map((id) => readRequest(id, latest.number, source)));
    const mine = sampler ? requests.filter((r) => r.consumer.toLowerCase() === sampler.toLowerCase()) : [];
    const audits = await Promise.all(mine.map((r) => readAudit(r.id)));
    const auditOf = new Map(mine.map((r, i) => [r.id, audits[i]]));

    return {
      head: latest.number,
      headTime: Number(latest.timestamp),
      total: Number(total),
      fee,
      operator,
      earned,
      balance,
      threshold,
      shares,
      requests: requests.map((r) => {
        const audit = auditOf.get(r.id);
        return audit ? { ...r, audit, refunded: audit.refunded } : r;
      }),
    };
  };
}

/** Closed rounds never change, so each is read once. Everything is forgotten if the chain goes backwards. */
export function createBeaconReader(client: PublicClient, beacon: Address, limit = 50) {
  const contract = { address: beacon, abi: BEACON_ABI } as const;
  let closed = new Map<bigint, BeaconRound>();
  let lastHead = 0n;

  async function readRound(id: bigint): Promise<BeaconRound> {
    const cached = closed.get(id);
    if (cached) return cached;
    const [[creator, commitEnd, revealEnd, minParticipants, commits, reveals, status, bond, , randomness], members] = await Promise.all([
      client.readContract({ ...contract, functionName: 'rounds', args: [id] }),
      client.readContract({ ...contract, functionName: 'memberCount', args: [id] }),
    ]);
    const round: BeaconRound = {
      id,
      creator,
      commitEnd: Number(commitEnd),
      revealEnd: Number(revealEnd),
      minParticipants,
      commits,
      reveals,
      status,
      bond,
      randomness,
      members,
    };
    if (status !== 0) closed.set(id, round);
    return round;
  }

  return async function read(): Promise<BeaconSnapshot> {
    const [total, latest] = await Promise.all([
      client.readContract({ ...contract, functionName: 'roundCount' }),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    if (latest.number < lastHead) closed = new Map();
    lastHead = latest.number;
    return {
      head: latest.number,
      headTime: Number(latest.timestamp),
      total: Number(total),
      rounds: await Promise.all(newestIds(total, 0n, limit).map(readRound)),
    };
  };
}

export async function readEntries(client: PublicClient, beacon: Address, rounds: readonly BeaconRound[], who: Address): Promise<BeaconEntry[]> {
  return Promise.all(
    rounds.map(async (r) => {
      const [commitment, committed, revealed, claimed] = await client.readContract({ address: beacon, abi: BEACON_ABI, functionName: 'entries', args: [r.id, who] });
      return { commitment, committed, revealed, claimed };
    }),
  );
}

/** Any contract call. Typed by the ABIs above where it is written, and checked by the chain when it is sent. */
export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface Signer {
  address: Address;
  signMessage(message: string): Promise<Hex>;
  /** Simulates first, so a call that would revert costs nothing, then sends and waits for it to be mined. */
  write(call: ContractCall): Promise<TransactionReceipt>;
}

export interface Wallet {
  /** 'dev': accounts unlocked on the node itself, so anvil needs no extension. 'wallet': the browser's wallet. */
  kind: 'dev' | 'wallet';
  /** What to call an account in the sign-in sheet, by lower-case address. Test keys are named for their part. */
  labels?: Record<string, string>;
  accounts(): Promise<Address[]>;
  signerFor(address: Address): Signer;
}

/** `reader` reads the chain when `client` stands in for a node with no accounts. */
/** A test wallet whose key sits in this page's local configuration, named for the part it plays. */
export interface TestKey {
  label: string;
  key: Hex;
}

/** `VITE_TEST_KEYS=treasurer:0x…,auditor:0x…`, from a local .env.local. Testnet keys only. */
export function parseTestKeys(value: string | undefined): TestKey[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    const at = entry.lastIndexOf(':');
    const key = entry.slice(at + 1);
    return /^0x[0-9a-fA-F]{64}$/.test(key) ? [{ label: at > 0 ? entry.slice(0, at) : 'test key', key: key as Hex }] : [];
  });
}

/**
 * Wallets that sign in the page with keys from its local configuration: no extension and no popup, which is what a
 * scripted screen recording needs. The transactions are real and go through `rpcUrl`.
 */
export function testKeyWallet(keys: readonly TestKey[], rpcUrl: string, reader: PublicClient): Wallet {
  const accounts = keys.map(({ label, key }) => ({ label, account: privateKeyToAccount(key) }));
  const find = (address: Address) => accounts.find((a) => a.account.address.toLowerCase() === address.toLowerCase())!.account;
  return {
    kind: 'dev',
    labels: Object.fromEntries(accounts.map((a) => [a.account.address.toLowerCase(), a.label])),
    accounts: async () => accounts.map((a) => a.account.address),
    signerFor: (address) => ({
      address,
      signMessage: (message) => find(address).signMessage({ message }),
      write: async (call) => {
        const account = find(address);
        const { request: prepared } = await reader.simulateContract({ ...call, account: address } as never) as { request: Record<string, unknown> };
        const hash = await createWalletClient({ account, transport: http(rpcUrl) }).writeContract({ ...prepared, account, chain: null } as never);
        const receipt = await reader.waitForTransactionReceipt({ hash, pollingInterval: 300 });
        if (receipt.status !== 'success') throw new Error(`The ${call.functionName} transaction reverted.`);
        return receipt;
      },
    }),
  };
}

export async function walletFor(client: PublicClient, rpcUrl: string, injected: EIP1193Provider | undefined, reader: PublicClient = client, testKeys: readonly TestKey[] = []): Promise<Wallet | null> {
  if (testKeys.length > 0) return testKeyWallet(testKeys, rpcUrl, reader);
  // Public nodes refuse this or return nothing. Only a dev node hands out accounts.
  const request = client.request as unknown as (args: { method: string }) => Promise<Address[]>;
  const devAccounts = await request({ method: 'eth_accounts' }).catch((): Address[] => []);
  if (devAccounts.length === 0 && !injected) return null;

  const kind = devAccounts.length > 0 ? 'dev' : 'wallet';
  const wallet = createWalletClient({ transport: kind === 'dev' ? http(rpcUrl) : custom(injected!) });

  const write = async (address: Address, call: ContractCall) => {
    if (kind === 'wallet') {
      const chainId = await reader.getChainId();
      if ((await wallet.getChainId()) !== chainId) {
        try {
          await wallet.switchChain({ id: chainId });
        } catch (e) {
          // A wallet that has never seen Fuji refuses the switch. Offer to add the network, which also switches to it.
          const known = [avalancheFuji, avalanche].find((c) => c.id === chainId);
          if (!known || (e as { code?: number }).code === 4001) throw e;
          await wallet.addChain({ chain: known });
        }
      }
    }
    const { request: prepared } = await reader.simulateContract({ ...call, account: address } as never) as { request: Record<string, unknown> };
    const hash = await wallet.writeContract({ ...prepared, account: address, chain: null } as never);
    const receipt = await reader.waitForTransactionReceipt({ hash, pollingInterval: 300 });
    if (receipt.status !== 'success') throw new Error(`The ${call.functionName} transaction reverted.`);
    return receipt;
  };

  return {
    kind,
    accounts: async () => (kind === 'dev' ? devAccounts : wallet.requestAddresses().then((a) => [...a])),
    signerFor: (address) => ({
      address,
      signMessage: (message) => wallet.signMessage({ account: address, message }),
      write: (call) => write(address, call),
    }),
  };
}
