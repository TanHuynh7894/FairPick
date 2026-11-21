// Where an answer's transaction is found. The oracle keeps the number but not the transaction that brought it, and
// the page needs that transaction: its calldata holds the signature the browser re-checks.
//
// On Avalanche the page asks the Avalanche Data API for the oracle's transactions: one request, any age. Plain RPC is
// the fallback and the only way on a local chain. Public Avalanche RPCs cap eth_getLogs at 100 blocks per request,
// counted across a whole JSON-RPC batch, so that path reads the 256-block answer window in pieces, one at a time.
import { createPublicClient, http, parseAbi, parseEventLogs, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';

export const DATA_API = 'https://data-api.avax.network';
const DATA_API_CHAINS = new Set([43113, 43114]);
const LOG_SPAN = 100n;
const WINDOW = 256n;
const MAX_PAGES = 5;
const REFRESH_MS = 2_500;

const EVENTS = parseAbi([
  'event RandomnessRequested(uint256 indexed requestId, address indexed consumer)',
  'event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackOk)',
]);
const FULFILL = toFunctionSelector('fulfill(uint256,uint256[2])');

export interface FoundAnswer {
  randomness: bigint;
  callbackOk: boolean;
  txHash: Hex;
  block: bigint;
  /** Who sent the answer and what it cost. Known when the transaction itself was read, not only its log. */
  from?: Address;
  gasUsed?: bigint;
}

export interface AnswerSource {
  find(id: bigint, requestBlock: bigint, head: bigint): Promise<FoundAnswer | undefined>;
  /** The transaction that made a request, when the source knows it. */
  requestTx?(id: bigint): Hex | undefined;
}

/** Scans the answer window of one request for its log, 100 blocks at a time and never two requests at once. */
export function rpcAnswers(client: PublicClient, oracle: Address): AnswerSource {
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  return {
    find: (id, requestBlock, head) => inTurn(async () => {
      const last = requestBlock + WINDOW < head ? requestBlock + WINDOW : head;
      for (let start = requestBlock + 1n; start <= last; start += LOG_SPAN) {
        const end = start + LOG_SPAN - 1n < last ? start + LOG_SPAN - 1n : last;
        const [log] = await client.getContractEvents({ address: oracle, abi: EVENTS, eventName: 'RandomnessFulfilled', args: { requestId: id }, fromBlock: start, toBlock: end });
        if (log) return { randomness: log.args.randomness!, callbackOk: log.args.callbackOk!, txHash: log.transactionHash, block: log.blockNumber };
      }
      return undefined;
    }),
  };
}

interface DataApiTx {
  txHash: Hex;
  blockNumber: string;
  txStatus: string;
  from: { address: Address };
  gasUsed: string;
  method?: { methodHash?: string };
}

/**
 * Lists the oracle's transactions through the Avalanche Data API, then reads each one's receipt once to learn which
 * request it made or answered. The listing does not carry event data, the receipt does.
 */
export function dataApiAnswers(client: PublicClient, oracle: Address, chainId: number, fetcher: typeof fetch = fetch): AnswerSource {
  const answers = new Map<bigint, FoundAnswer>();
  const requestTxs = new Map<bigint, Hex>();
  const seen = new Set<Hex>();
  let loading: Promise<void> | null = null;
  let loadedAt = 0;
  let failure: unknown = null;

  async function load(downTo: bigint) {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${DATA_API}/v1/chains/${chainId}/addresses/${oracle}/transactions?pageSize=100&sortOrder=desc${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`Avalanche Data API answered ${res.status}`);
      const body = (await res.json()) as { transactions?: { nativeTransaction: DataApiTx }[]; nextPageToken?: string };
      const listed = (body.transactions ?? []).map((t) => t.nativeTransaction).filter((t) => t.txStatus === '1');
      const fresh = listed.filter((t) => !seen.has(t.txHash));
      const receipts = await Promise.all(fresh.map((t) => client.getTransactionReceipt({ hash: t.txHash })));
      receipts.forEach((receipt, i) => {
        const tx = fresh[i];
        for (const log of parseEventLogs({ abi: EVENTS, logs: receipt.logs.filter((l) => l.address.toLowerCase() === oracle.toLowerCase()) })) {
          if (log.eventName === 'RandomnessRequested') requestTxs.set(log.args.requestId, tx.txHash);
          else answers.set(log.args.requestId, {
            randomness: log.args.randomness,
            callbackOk: log.args.callbackOk,
            txHash: tx.txHash,
            block: receipt.blockNumber,
            // Only a direct call to fulfill is known to come from a node's own wallet.
            from: tx.method?.methodHash === FULFILL ? tx.from.address : undefined,
            gasUsed: receipt.gasUsed,
          });
        }
        seen.add(tx.txHash);
      });
      pageToken = body.nextPageToken;
      const oldest = listed.length ? BigInt(listed[listed.length - 1].blockNumber) : 0n;
      // Stop at the first page that reaches known transactions, or blocks older than what was asked for.
      if (!pageToken || fresh.length < listed.length || oldest <= downTo) break;
    }
  }

  return {
    async find(id, requestBlock) {
      if (!answers.has(id) && Date.now() - loadedAt > REFRESH_MS) {
        loading ??= load(requestBlock).then(() => { failure = null; }, (e) => { failure = e; }).finally(() => {
          loading = null;
          loadedAt = Date.now();
        });
      }
      if (loading) await loading;
      // Until the next try, a failed listing stays a failure, so a caller with another source uses it.
      if (!answers.has(id) && failure) throw failure;
      return answers.get(id);
    },
    requestTx: (id) => requestTxs.get(id),
  };
}

/** The first source, unless it fails: then the second, for that one lookup. */
export function withFallback(first: AnswerSource, second: AnswerSource): AnswerSource {
  return {
    async find(id, requestBlock, head) {
      try {
        return await first.find(id, requestBlock, head);
      } catch {
        return second.find(id, requestBlock, head);
      }
    },
    requestTx: (id) => first.requestTx?.(id),
  };
}

/** The Data API on Avalanche's public chains, plain RPC everywhere else and whenever the API cannot be reached. */
export function answersFor(client: PublicClient, oracle: Address, chainId: number, localFork = false): AnswerSource {
  // Log scans must not share a JSON-RPC batch: the 100-block cap counts the whole batch.
  const url = (client.transport as { url?: string }).url;
  const rpc = rpcAnswers(url ? createPublicClient({ transport: http(url, { timeout: 8_000 }) }) : client, oracle);
  return DATA_API_CHAINS.has(chainId) && !localFork ? withFallback(dataApiAnswers(client, oracle, chainId), rpc) : rpc;
}
