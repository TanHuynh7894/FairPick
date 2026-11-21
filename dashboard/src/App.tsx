import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EIP1193Provider } from 'viem';
import { AppProvider, type AppState } from './app-context';
import { clearSession, storedSession, verifySession, type Session } from './auth';
import { createBeaconReader, createOracleReader, makeClient, parseTestKeys, walletFor, type Wallet } from './chain';
import { AccountView } from './components/AccountView';
import { AdminView } from './components/AdminView';
import { BeaconSection } from './components/BeaconSection';
import { Band, Chip } from './components/common';
import { DeveloperView } from './components/DeveloperView';
import { Intro } from './components/guide';
import { L1View } from './components/L1View';
import { Login } from './components/Login';
import { LIMIT, OracleSection } from './components/OracleSection';
import { config } from './config';
import { chainName, number, shortHex } from './format';
import { useNow, usePoll, useView, type View } from './hooks';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    /** Core, the Avalanche wallet, also answers here. It is preferred when both are installed. */
    avalanche?: EIP1193Provider;
  }
}
// A wallet announced through EIP-6963. Some wallets only announce themselves that way, or inject window.ethereum
// a moment after the page has loaded, so the page waits a little before deciding there is none.
let announced: EIP1193Provider | undefined;
const injectedWallet = () => window.avalanche ?? window.ethereum ?? announced;

function findWallet(waitMs = 2_000): Promise<EIP1193Provider | undefined> {
  return new Promise((resolve) => {
    const onAnnounce = (e: Event) => {
      const { info, provider } = (e as CustomEvent<{ info?: { rdns?: string }; provider: EIP1193Provider }>).detail ?? {};
      if (!provider) return;
      // Core is preferred when several wallets announce themselves.
      if (!announced || info?.rdns?.startsWith('app.core')) announced = provider;
    };
    const check = () => {
      const found = injectedWallet();
      if (found) finish(found);
    };
    const finish = (found: EIP1193Provider | undefined) => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      window.removeEventListener('ethereum#initialized', check);
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(found);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.addEventListener('ethereum#initialized', check);
    const poll = setInterval(check, 100);
    const timeout = setTimeout(() => finish(injectedWallet()), waitMs);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    check();
  });
}

const NAV: [View, string][] = [['oracle', 'AUDITS'], ['l1', 'FROM L1'], ['beacon', 'GROUP PICK'], ['account', 'ACCOUNT'], ['developer', 'DEVELOPER'], ['admin', 'ADMIN']];
/** Audits, From L1 and Group pick draw their own heading. */
const PAGE: Partial<Record<View, string>> = { account: 'My account', developer: 'Developer', admin: 'Admin' };

const SCREEN: Record<View, () => React.JSX.Element> = { oracle: OracleSection, l1: L1View, beacon: BeaconSection, account: AccountView, developer: DeveloperView, admin: AdminView };

/** The mark: a fixed 4 by 4 of the kind of cell the page draws its values with. */
function Logo() {
  const levels = [0.95, 0.35, 0.7, 0.2, 0.5, 1, 0.25, 0.8, 0.15, 0.6, 0.9, 0.4, 0.75, 0.3, 0.55, 1];
  return <span className="logo-mark" aria-hidden="true">{levels.map((o, i) => <i key={i} style={{ opacity: o }} />)}</span>;
}

function Connected({ client }: { client: AppState['client'] }) {
  const readChain = useCallback(async () => {
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
    return { chainId, head };
  }, [client]);
  const chain = usePoll(readChain, 1_500);
  const chainId = chain.data?.chainId;
  const nowSec = useNow();
  const [view, setView] = useView();

  const readOracle = useMemo(() => (config.oracle ? createOracleReader(client, config.oracle, config.sampler, LIMIT) : undefined), [client]);
  const readBeacon = useMemo(() => (config.beacon ? createBeaconReader(client, config.beacon) : undefined), [client]);
  const oracle = usePoll(readOracle);
  const beacon = usePoll(readBeacon);

  const [wallet, setWallet] = useState<Wallet | null | undefined>();
  const [session, setSession] = useState<Session | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    void findWallet().then((injected) => walletFor(client, config.rpcUrl, injected, client, import.meta.env.DEV ? parseTestKeys(import.meta.env.VITE_TEST_KEYS) : [])).then(setWallet);
  }, [client]);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  // A reload keeps the session only if its signature still holds for this wallet, chain and site.
  useEffect(() => {
    const stored = storedSession();
    if (!stored || chainId === undefined) return;
    void verifySession(stored, { now: Date.now() / 1000, chainId, host: location.host }).then((ok) => (ok ? setSession(stored) : clearSession()));
  }, [chainId]);

  // Switching accounts in the wallet must not leave the page acting as the previous one.
  useEffect(() => {
    const injected = injectedWallet() as (EIP1193Provider & { on?(e: string, f: (a: string[]) => void): void; removeListener?(e: string, f: (a: string[]) => void): void }) | undefined;
    if (!injected?.on || !session || wallet?.kind !== 'wallet') return;
    const onChange = (accounts: string[]) => {
      if (accounts[0]?.toLowerCase() !== session.address.toLowerCase()) logout();
    };
    injected.on('accountsChanged', onChange);
    return () => injected.removeListener?.('accountsChanged', onChange);
  }, [session, wallet, logout]);

  const refreshOracle = oracle.refresh;
  const refreshBeacon = beacon.refresh;
  const refresh = useCallback(() => {
    refreshOracle();
    refreshBeacon();
  }, [refreshOracle, refreshBeacon]);

  const signer = useMemo(() => (session && wallet ? wallet.signerFor(session.address) : null), [session, wallet]);
  const isOperator = Boolean(session && oracle.data && session.address.toLowerCase() === oracle.data.operator.toLowerCase());

  const state: AppState = {
    client, rpcUrl: config.rpcUrl, chainId, nowSec,
    oracle: config.oracle, sampler: config.sampler, beacon: config.beacon,
    oracleData: oracle.data, oracleError: oracle.error, beaconData: beacon.data, beaconError: beacon.error,
    refresh, wallet, session, signer, isOperator, logout,
    openLogin: () => setLoggingIn(true),
  };
  const Screen = SCREEN[view];

  return (
    <AppProvider value={state}>
      <header className="top">
        <h1 className="logo"><Logo />fairpick</h1>
        <nav aria-label="Sections">
          {NAV.filter(([key]) => key !== 'admin' || isOperator || view === 'admin').map(([key, label]) => (
            <a key={key} href={`#${key}`} className={view === key ? 'is-on' : ''} aria-current={view === key ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setView(key); }}>{label}</a>
          ))}
        </nav>
        <p className={`live${chain.error ? ' is-down' : ''}`} role="status">
          <i key={chain.data?.head.toString()} />
          {chain.error ? 'RPC DISCONNECTED' : chain.data ? <>{chainName(chain.data.chainId).toUpperCase()} · BLOCK <b>{number(Number(chain.data.head))}</b></> : 'CONNECTING…'}
        </p>
        <div className="who">
          {session ? (
            <>
              {isOperator && <Chip tone="ok">OPERATOR</Chip>}
              <span className="hex-plain" title={session.address}>{shortHex(session.address)}</span>
              <button type="button" className="button-quiet" onClick={logout}>SIGN OUT</button>
            </>
          ) : (
            <button type="button" className="button-quiet" onClick={() => setLoggingIn(true)}>SIGN IN</button>
          )}
        </div>
      </header>
      <main>
        {PAGE[view] && <Intro id={view} title={PAGE[view]!} />}
        <Screen />
      </main>
      {loggingIn && <Login onClose={() => setLoggingIn(false)} onSession={(s) => { setSession(s); setLoggingIn(false); }} />}
    </AppProvider>
  );
}

export function App() {
  const client = useMemo(() => (config.rpcUrl ? makeClient(config.rpcUrl) : undefined), []);
  return (
    <>
      {config.problems.length > 0 && <main>{config.problems.map((p) => <Band key={p} tone="bad" title="Configuration problem">{p}</Band>)}</main>}
      {client ? <Connected client={client} /> : (
        <main><div className="empty">No RPC yet. Copy <code>dashboard/.env.example</code> to <code>.env.local</code> and fill in the addresses, or run <code>./scripts/dashboard-demo.sh</code> to try it on a local chain.</div></main>
      )}
    </>
  );
}
