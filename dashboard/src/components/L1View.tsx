import { useMemo } from 'react';
import type { Hex } from 'viem';
import { useApp } from '../app-context';
import { config } from '../config';
import type { Audit } from '../derive';
import { explorerAddress, explorerTx, number, shortHex, uintHex } from '../format';
import { usePoll } from '../hooks';
import { checkRecord, createIcmReader, type Check, type L1Record, type RemoteAudit } from '../icm';
import l1 from '../l1-audits.json';
import { Picks } from './Audit';
import { Chip, HexValue, Kpi, Loading, NotConfigured, StaleBand, type Tone } from './common';
import { Intro } from './guide';

const records = l1.audits as L1Record[];

function TxLink({ hash, label }: { hash?: Hex | null; label: string }) {
  const { chainId } = useApp();
  if (!hash) return <span className="muted">{label} –</span>;
  const href = chainId !== undefined ? explorerTx(chainId, hash) : undefined;
  return href ? <a className="hex" href={href} target="_blank" rel="noreferrer" title={hash}>{label}</a> : <HexValue value={hash} label={label} />;
}

function status(a: RemoteAudit, record: L1Record | undefined, picks: Check): [Tone, string] {
  if (!a.answered) return ['wait', 'WAITING'];
  if (!a.forwarded) return ['info', 'ANSWERED'];
  if (picks === 'mismatch') return ['bad', 'MISMATCH'];
  return record?.settled ? ['ok', 'PICKED ON L1'] : ['ok', 'SENT BACK'];
}

const asAudit = (r: L1Record): Audit => ({
  requester: r.requester, itemCount: r.itemCount, sampleSize: r.sampleSize, draw: 1, settled: r.settled, refunded: false,
  auditor: r.requester, reported: false, missing: 0, fileHash: r.fileHash, seed: 0n, label: r.label, picks: r.picks,
});

export function L1View() {
  const { client, chainId, oracleData } = useApp();
  const adapter = config.icmAdapter;
  const read = useMemo(() => (adapter && chainId !== undefined ? createIcmReader(client, adapter, chainId) : undefined), [client, adapter, chainId]);
  const { data, error } = usePoll(read, 6_000);

  if (!adapter) return <NotConfigured name="ICM adapter" variable="VITE_ICM_ADAPTER" />;
  if (!data) return error ? <StaleBand error={error} hasData={false} /> : <Loading label="Reading the ICM adapter on Fuji" />;

  const rows = data.audits.map((a) => {
    const record = records.find((r) => BigInt(r.auditId) === a.auditId);
    return { a, record, check: checkRecord(a, record) };
  });
  const checked = rows.filter((r) => r.check.picks === 'match' && r.check.commitment === 'match').length;
  const answerTx = (id: bigint) => oracleData?.requests.find((r) => r.id === id)?.answer?.txHash;
  const adapterLink = chainId !== undefined ? explorerAddress(chainId, adapter) : undefined;

  return (
    <>
      <StaleBand error={error} hasData />
      <Intro id="l1" title="From the L1"
        note="Audits filed on the audit office's own L1. The oracle on Fuji answers over ICM. Read from Fuji." />

      <dl className="kpis kpis-4">
        <Kpi label="Filed from the L1" value={number(rows.length)} />
        <Kpi label="Answered on Fuji" value={number(rows.filter((r) => r.a.answered).length)} />
        <Kpi label="Sent back to the L1" value={number(rows.filter((r) => r.a.forwarded).length)} />
        <Kpi label="L1 record matches Fuji" value={`${checked} of ${rows.length}`} note="list commitment and receipts, checked here" />
      </dl>

      <div className="head"><h2>L1 audits</h2></div>
      {rows.length === 0 ? <div className="empty">No audits from the L1 yet.</div> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Audits from the L1">
          <table>
            <thead>
              <tr>
                <th className="num">L1 #</th>
                <th>List</th>
                <th>Receipts to check</th>
                <th>Oracle answer</th>
                <th>On Fuji</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ a, record, check }) => {
                const [tone, text] = status(a, record, check.picks);
                return (
                  <tr key={a.auditId.toString()} className="no-pick">
                    <td className="num">{a.auditId.toString()}</td>
                    <td>
                      <span className="batch">{record?.label ?? 'Not in the L1 export yet'}</span>
                      {record && <small className="batch-sub">{record.sampleSize} of {number(record.itemCount)} · treasurer {shortHex(record.requester)}{check.commitment === 'mismatch' && ' · commitment differs'}</small>}
                    </td>
                    <td>{record?.settled ? <Picks audit={asAudit(record)} size="sm" /> : <span className="muted">–</span>}</td>
                    <td>
                      <span className="batch">request #{a.oracleRequestId.toString()}</span>
                      {a.randomness !== undefined && <small className="batch-sub hex-plain" title={uintHex(a.randomness)}>{shortHex(uintHex(a.randomness))}</small>}
                    </td>
                    <td className="links">
                      <TxLink hash={a.filedTx} label="filed" /> · <TxLink hash={answerTx(a.oracleRequestId)} label="2-of-3 answer" /> · <TxLink hash={a.forwardTx} label="sent back" />
                    </td>
                    <td><Chip tone={tone}>{text}</Chip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="panel">
        <div className="head head-flush"><h2>Who may send transactions on the L1</h2></div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="L1 allow-list">
          <table>
            <thead><tr><th>Wallet</th><th>Who</th><th>Role</th></tr></thead>
            <tbody>
              {l1.writers.map((w) => (
                <tr key={w.address} className="no-pick">
                  <td><HexValue value={w.address} label="wallet" /></td>
                  <td>{w.who}</td>
                  <td><Chip tone={w.role === 'none' ? 'bad' : w.role === 'admin' ? 'info' : 'ok'}>{w.role === 'none' ? 'REFUSED' : w.role.toUpperCase()}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <dl className="facts">
        <div><dt>ADAPTER</dt><dd>{adapterLink ? <a className="hex" href={adapterLink} target="_blank" rel="noreferrer">{shortHex(adapter)}</a> : <HexValue value={adapter} label="adapter address" />}</dd></div>
        <div><dt>L1</dt><dd>{l1.l1.name} · chain {l1.l1.chainId} · <HexValue value={l1.l1.blockchainID} label="L1 blockchain ID" /></dd></div>
        <div><dt>L1 SAMPLER</dt><dd><HexValue value={data.remoteSampler} label="L1 sampler address" /></dd></div>
        <div><dt>L1 RECORD</dt><dd>read {l1.readAt.slice(0, 16).replace('T', ' ')} UTC, block {number(l1.l1.block)}</dd></div>
      </dl>
    </>
  );
}
