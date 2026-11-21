import { useCallback, useMemo, useState } from 'react';
import { useApp } from '../app-context';
import { ORACLE_ABI, readEntries, SAMPLER_ABI } from '../chain';
import { auditActions, beaconPhase, claimState, requestState, type BeaconRound } from '../derive';
import { amount, number } from '../format';
import { usePoll } from '../hooks';
import { BEACON_PHASE, CLAIM_TEXT, RoundPanel } from './RoundPanel';
import { Chip, Kpi, Loading, LoginPrompt, TxButton } from './common';
import { requestChip } from './RequestsTable';
import { Picks } from './Audit';

export function AccountView() {
  const { client, oracle, sampler, beacon, oracleData, beaconData, chainId, nowSec, signer, session } = useApp();
  const [picked, setPicked] = useState<bigint | null>(null);
  const me = session?.address;

  const rounds = beaconData?.rounds;
  const read = useCallback(async () => {
    const [balance, refund, entries] = await Promise.all([
      client.getBalance({ address: me! }),
      oracle ? client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'refunds', args: [me!] }) : 0n,
      beacon && rounds ? readEntries(client, beacon, rounds, me!) : [],
    ]);
    return { balance, refund, entries };
  }, [client, oracle, beacon, rounds, me]);
  const { data, error } = usePoll(me ? read : undefined, 5_000);

  const lower = me?.toLowerCase();
  const mine = useMemo(
    () => (oracleData?.requests ?? []).filter((r) => r.audit?.requester.toLowerCase() === lower || r.consumer.toLowerCase() === lower),
    [oracleData, lower],
  );

  if (!me || !signer) return <LoginPrompt>Sign in to see your account.</LoginPrompt>;
  if (!data) return error ? <div className="empty">Cannot read wallet data: {String(error)}</div> : <Loading label="Reading your account" />;

  const head = oracleData?.head ?? 0n;
  const now = Math.max(nowSec, oracleData?.headTime ?? 0, beaconData?.headTime ?? 0);
  const myRounds = (rounds ?? []).map((r, i) => ({ r, e: data.entries[i] })).filter((x) => x.e?.committed);
  const pickedRound = rounds?.find((r: BeaconRound) => r.id === picked);

  return (
    <>
      <dl className="kpis kpis-3">
        <Kpi label="Balance" value={amount(data.balance, chainId)} />
        <Kpi label="Audits" value={number(mine.length)} />
        <Kpi label="Refunds" value={amount(data.refund, chainId)} />
      </dl>

      {data.refund > 0n && oracle && (
        <div className="head">
          <h2>Refunds waiting</h2>
          <span className="head-end"><TxButton label={`WITHDRAW ${amount(data.refund, chainId)}`} action={() => signer.write({ address: oracle, abi: ORACLE_ABI, functionName: 'withdrawRefund', args: [me, data.refund] })} /></span>
        </div>
      )}

      <section className="panel">
        <h2>My audits</h2>
        {mine.length === 0 ? <div className="empty">No audits yet.</div> : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="My audits">
            <table>
              <thead><tr><th className="num">ID</th><th>Batch</th><th>Picked</th><th>Status</th><th /></tr></thead>
              <tbody>
                {mine.map((r) => {
                  const [tone, text] = requestChip(r, head);
                  const can = auditActions(r, head);
                  const isAudit = Boolean(r.audit && sampler);
                  const closed = requestState(r, head).state === 'expired';
                  return (
                    <tr key={r.id.toString()} className="no-pick">
                      <td className="num">{r.id.toString()}</td>
                      <td>{r.audit?.label || '–'}</td>
                      <td>{r.audit ? <Picks audit={r.audit} size="sm" /> : '–'}</td>
                      <td><Chip tone={tone}>{r.refunded ? 'REFUNDED' : text}</Chip></td>
                      <td>
                        {isAudit && can.settle && <TxButton quiet label="FINISH" action={() => signer.write({ address: sampler!, abi: SAMPLER_ABI, functionName: 'settle', args: [r.id] })} />}
                        {isAudit && can.refund && <TxButton quiet label={closed ? 'REFUND' : 'CLOSE + REFUND'} action={() => signer.write({ address: sampler!, abi: SAMPLER_ABI, functionName: 'refund', args: [r.id] })} />}
                        {!(isAudit && (can.settle || can.refund)) && <span className="muted">–</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {beacon && (
        <section className="panel">
          <h2>My group picks</h2>
          {myRounds.length === 0 ? <div className="empty">No rounds yet.</div> : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="My group picks">
              <table>
                <thead><tr><th className="num">Round</th><th>Status</th><th>Deposit</th><th /></tr></thead>
                <tbody>
                  {myRounds.map(({ r, e }) => {
                    const [tone, text] = BEACON_PHASE[beaconPhase(r, now)];
                    return (
                      <tr key={r.id.toString()} className="no-pick">
                        <td className="num">{r.id.toString()}</td>
                        <td><Chip tone={tone}>{text}</Chip></td>
                        <td>{CLAIM_TEXT[claimState(r, e)]}</td>
                        <td><button type="button" className="button-quiet" onClick={() => setPicked(r.id)} aria-label={`Open round ${r.id}`}>OPEN</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {pickedRound && <RoundPanel round={pickedRound} onClose={() => setPicked(null)} />}
    </>
  );
}
