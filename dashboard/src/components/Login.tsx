import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useApp } from '../app-context';
import { signIn, type Session } from '../auth';
import { errorText, shortHex } from '../format';
import { Chip, Sheet } from './common';

export function Login({ onSession, onClose }: { onSession(session: Session): void; onClose(): void }) {
  const { wallet, chainId, oracleData } = useApp();
  const [accounts, setAccounts] = useState<Address[]>([]);
  const [busy, setBusy] = useState<Address | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only a dev node lists its accounts by itself. A browser wallet opens its own prompt, so that waits for a click.
  useEffect(() => {
    if (wallet?.kind === 'dev') void wallet.accounts().then(setAccounts);
  }, [wallet]);

  const sign = async (address: Address) => {
    setBusy(address);
    setError(null);
    try {
      onSession(await signIn(wallet!.signerFor(address), chainId!));
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };
  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      const [first] = await wallet!.accounts();
      await sign(first);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };
  const isOperator = (a: Address) => a.toLowerCase() === oracleData?.operator.toLowerCase();

  return (
    <Sheet title="Sign in" onClose={onClose}>
      <p className="muted">Signature only, no transaction.</p>

      {wallet === undefined && <p className="muted">Looking for a wallet…</p>}
      {wallet === null && (
        <div className="band band-warn">
          <strong>No wallet found</strong>
          <span>Install <a href="https://core.app/" target="_blank" rel="noreferrer">Core</a> or <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask</a> and reload. Reading needs no wallet.</span>
        </div>
      )}
      {wallet?.kind === 'wallet' && (
        <button type="button" className="button" disabled={busy !== null || chainId === undefined} onClick={connect}>
          {busy ? 'CONFIRM IN WALLET…' : 'CONNECT AND SIGN'}
        </button>
      )}
      {wallet?.kind === 'dev' && (
        <>
          <ul className="account-list">
            {accounts.map((a) => (
              <li key={a}>
                <button type="button" className="account" disabled={busy !== null || chainId === undefined} onClick={() => sign(a)}>
                  <span className="hex-plain" title={a}>{shortHex(a)}</span>
                  {wallet.labels?.[a.toLowerCase()] && <Chip tone="info">{wallet.labels[a.toLowerCase()].toUpperCase()} · TEST KEY</Chip>}
                  {isOperator(a) && <Chip tone="ok">OPERATOR</Chip>}
                  <span className="account-go">{busy === a ? 'SIGNING…' : 'SIGN IN'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="tx-error" role="alert">{error}</p>}
    </Sheet>
  );
}
