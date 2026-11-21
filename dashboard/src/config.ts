import { isAddress, type Address } from 'viem';

function address(name: string, value: string | undefined, problems: string[]): Address | undefined {
  if (!value) return undefined;
  if (isAddress(value)) return value;
  problems.push(`${name} is not a valid address: ${value}`);
  return undefined;
}

const problems: string[] = [];
export const config = {
  rpcUrl: (import.meta.env.VITE_RPC_URL as string | undefined) ?? '',
  oracle: address('VITE_ORACLE_ADDRESS', import.meta.env.VITE_ORACLE_ADDRESS, problems),
  sampler: address('VITE_SAMPLER_ADDRESS', import.meta.env.VITE_SAMPLER_ADDRESS, problems),
  beacon: address('VITE_BEACON_ADDRESS', import.meta.env.VITE_BEACON_ADDRESS, problems),
  /** IcmRandomnessAdapter: the oracle's door for audits filed on the fairpick L1. */
  icmAdapter: address('VITE_ICM_ADAPTER', import.meta.env.VITE_ICM_ADAPTER, problems),
  problems,
};
