// What one answer costs: the gas the chain measured, and that gas at the C-Chain mainnet price read just now.
import { useEffect, useState } from 'react';
import type { Hex, PublicClient } from 'viem';

const MAINNET_RPC = 'https://api.avax.network/ext/bc/C/rpc';
/** Fuji gas costs next to nothing, so a cost in test AVAX says little. Only Avalanche chains get the comparison. */
const AVALANCHE = new Set([43113, 43114]);

export interface AnswerCost {
  gasUsed: bigint;
  /** In wei, or null when the mainnet price could not be read or the chain is not Avalanche. */
  mainnetCost: bigint | null;
  mainnetBaseFee: bigint | null;
}

export async function mainnetBaseFee(fetcher: typeof fetch = fetch): Promise<bigint | null> {
  try {
    const res = await fetcher(MAINNET_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_baseFee', params: [] }),
    });
    const body = (await res.json()) as { result?: Hex };
    return body.result ? BigInt(body.result) : null;
  } catch {
    return null;
  }
}

export const costAt = (gasUsed: bigint, baseFee: bigint | null) => (baseFee === null ? null : gasUsed * baseFee);

/** `gasUsed` is passed when the answer's transaction was already read, which saves a receipt lookup. */
export function useAnswerCost(client: PublicClient, chainId: number | undefined, txHash: Hex | undefined, gasUsed?: bigint): AnswerCost | null {
  const [cost, setCost] = useState<(AnswerCost & { txHash: Hex }) | null>(null);
  useEffect(() => {
    if (!txHash || chainId === undefined) return;
    let current = true;
    void (async () => {
      const [gas, baseFee] = await Promise.all([
        gasUsed ?? client.getTransactionReceipt({ hash: txHash }).then((r) => r.gasUsed),
        AVALANCHE.has(chainId) ? mainnetBaseFee() : null,
      ]);
      if (current) setCost({ txHash, gasUsed: gas, mainnetBaseFee: baseFee, mainnetCost: costAt(gas, baseFee) });
    })().catch(() => {});
    return () => { current = false; };
  }, [client, chainId, txHash, gasUsed]);
  return cost && cost.txHash === txHash ? cost : null;
}
