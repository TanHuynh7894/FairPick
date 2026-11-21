import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { matchesSearch, missingReceipts, oracleHealth, requestState, selfAnnounced, summarize, type Health, type OracleRequest } from '../derive';
import { amount, duration, explorerAddress, latency, number, plural, shortHex, uintHex, vnd } from '../format';
import { auditInAddress, setAuditInAddress } from '../hooks';
import { loadList } from '../receipts';
import { useAnswerCost } from '../cost';
import { NewAudit, pickedTotal, ReceiptRows } from './Audit';
import { Band, HexValue, Kpi, Loading, NotConfigured, StaleBand } from './common';
import { Intro } from './guide';
import { Inspector } from './Inspector';
import { RequestsTable } from './RequestsTable';

/** To four decimals of an AVAX, the precision amounts are shown in. */
const rounded = (wei: bigint) => ((wei + 50_000_000_000_000n) / 100_000_000_000_000n) * 100_000_000_000_000n;
const LATENCY_COLUMNS = 30;
export const LIMIT = 200;

const HEALTH_TEXT: Record<Health['code'], (n: number) => [string, string]> = {
  idle: () => ['No requests yet', ''],
  ok: () => ['Every request has been handled', ''],
  waiting: (n) => [`${plural(n, 'request')} waiting for the nodes`, ''],
  slow: (n) => [`${plural(n, 'request')} waiting unusually long`, 'Check that the nodes are running and their wallets can still pay for gas.'],
  overdue: (n) => [`${plural(n, 'request')} past 256 blocks`, 'They can no longer be answered. Anyone can call expire() to close them and refund the caller.'],
  expiring: (n) => [`${plural(n, 'request')} about to expire`, 'Fewer than 32 blocks left to answer. If the nodes have stopped, restart them now.'],
};

/** The newest audit, large: the receipts an auditor now has to check, and the way into verifying the pick. */
function Latest({ request: r, now, head, onOpen }: { request: OracleRequest; now: number; head: bigint; onOpen(): void }) {
  const audit = r.audit;
  const a = r.answer;
  const list = useMemo(() => (audit ? loadList(audit.fileHash) : null), [audit?.fileHash]);
  const total = audit?.settled ? pickedTotal(audit, list) : null;
  const { state, blocksLeft } = requestState(r, head);
  return (
    <section className="latest" aria-label="Latest audit">
      <div className="latest-head">
        <p className="latest-kicker">
          {audit?.settled ? <>Receipts to check · {audit.sampleSize} of {number(audit.itemCount)}</> : a ? 'Number' : state === 'pending' ? 'Waiting for the signature' : 'Not answered'}
        </p>
        <h3 className="latest-label">{audit ? audit.label || 'Untitled list' : `Request #${r.id}`}</h3>
      </div>
      <button type="button" className="button-quiet latest-open" onClick={onOpen}>{a ? 'VERIFY' : 'OPEN'}</button>
      {audit?.settled ? <ReceiptRows audit={audit} list={list} />
        : a ? <p className="latest-hex" title={uintHex(a.randomness)}>{shortHex(uintHex(a.randomness))}</p>
          : <p className="latest-wait">{state === 'pending' ? <>The list is locked. The pick comes with the oracle's signature, {plural(blocksLeft, 'block')} left.</> : 'Nobody answered within 256 blocks. The fee can be refunded.'}</p>}
      <p className="latest-meta">
        {audit ? 'Audit' : 'Request'} #{r.id.toString()}
        {audit && (selfAnnounced(audit) ? <> · no separate auditor</> : <> · announced by auditor {shortHex(audit.auditor)}</>)}
        {audit && audit.draw > 1 && <> · draw {audit.draw} of this list</>}
        {audit?.reported && <> · auditor found {audit.picks.length - missingReceipts(audit).length} of {audit.picks.length}</>}
        {a ? <> · picked in {latency(a.latencySec)} · {duration(now - r.requestTime - a.latencySec)} ago</> : <> · sent {duration(now - r.requestTime)} ago</>}
        {total !== null && <> · {vnd(total)} to check</>}
        {audit?.settled && !list && <> · list not in this browser</>}
      </p>
    </section>
  );
}

export function OracleSection() {
  const { client, oracle, sampler, chainId, nowSec, oracleData: data, oracleError: error, signer, openLogin } = useApp();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPickedState] = useState<bigint | null>(auditInAddress);
  const searchRef = useRef<HTMLInputElement>(null);
  const setPicked = (id: bigint | null) => {
    setPickedState(id);
    setAuditInAddress(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).matches?.('input, textarea');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // With a sampler configured the page is about audits. Requests from other contracts are left to the Developer page.
  const rows = useMemo(() => (data ? (sampler ? data.requests.filter((r) => r.audit) : data.requests) : []), [data, sampler]);
  const latestAnswer = rows.find((r) => r.answer);
  const cost = useAnswerCost(client, chainId, latestAnswer?.answer?.txHash, latestAnswer?.answer?.gasUsed);

  if (!oracle) return <NotConfigured name="oracle" variable="VITE_ORACLE_ADDRESS" />;
  if (!data) return error ? <StaleBand error={error} hasData={false} /> : <Loading label="Reading the oracle" />;

  const now = Math.max(nowSec, data.headTime);
  const s = summarize(rows, data.head);
  const health = oracleHealth(data.requests, data.head, now);
  const [title, detail] = HEALTH_TEXT[health.code](health.count);
  const explorer = chainId !== undefined ? explorerAddress(chainId, oracle) : undefined;
  const visible = rows.filter((r) => matchesSearch(r, search));
  const pickedRequest = data.requests.find((r) => r.id === picked);
  const latencies = rows.filter((r) => r.answer).slice(0, LATENCY_COLUMNS).reverse().map((r) => r.answer!.latencySec);
  // The newest audit leads, also while it waits, so a new request is seen turning into a pick.
  const latest = rows[0];

  return (
    <>
      <StaleBand error={error} hasData />
      <Intro id="oracle" title="Audits" note={sampler ? 'An auditor announces a receipt list by its hash. A signature nobody can choose then picks which receipts get checked, once.' : undefined}>
        {sampler && <button type="button" className="button" onClick={signer ? () => setCreating(true) : openLogin}>NEW AUDIT</button>}
      </Intro>

      {/* Health is a claim about now. Old data can't back it, and the stale band is already on screen. */}
      {!error && health.level !== 'good' && <Band tone={health.level === 'critical' ? 'bad' : 'warn'} title={title}>{detail}</Band>}

      {latest && <Latest request={latest} now={now} head={data.head} onOpen={() => setPicked(latest.id)} />}

      <dl className="kpis kpis-4">
        <Kpi label={sampler ? 'Audits' : 'Requests'} value={number(rows.length)} />
        <Kpi label="Answered" value={s.answeredShare === null ? '–' : `${Math.round(s.answeredShare * 100)}%`} />
        <Kpi label="Median time to pick" value={s.medianLatencySec === null ? '–' : latency(s.medianLatencySec)} spark={latencies} />
        <Kpi label="Gas charged for the on-chain check" value={cost ? `${number(Number(cost.gasUsed))} gas` : '–'}
          note={cost?.mainnetCost != null ? `≈ ${amount(rounded(cost.mainnetCost), chainId)} at today's mainnet gas price · fee ${amount(data.fee, chainId)}` : cost ? `fee ${amount(data.fee, chainId)}` : undefined} />
      </dl>

      <div className="head">
        <h2>{sampler ? 'All audits' : 'Requests'}</h2>
        <input ref={searchRef} className="search" type="search" id="request-search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search (/)" aria-label="Search by audit number, name, wallet, list hash or transaction hash" />
      </div>

      {visible.length > 0 ? (
        <RequestsTable requests={visible} head={data.head} nowSec={now} onPick={setPicked} />
      ) : (
        <div className="empty">{rows.length === 0 ? <>No audits yet.</> : 'No audits match this search.'}</div>
      )}

      <dl className="facts">
        <div><dt>ORACLE</dt><dd>{explorer ? <a className="hex" href={explorer} target="_blank" rel="noreferrer">{shortHex(oracle)}</a> : <HexValue value={oracle} label="oracle address" />}</dd></div>
        <div><dt>SIGNERS</dt><dd>{data.shares > 0 ? `any ${data.threshold} of ${data.shares} key shares, fixed in the contract` : 'one key holder'}</dd></div>
        {sampler && <div><dt>SAMPLER</dt><dd>{chainId !== undefined && explorerAddress(chainId, sampler) ? <a className="hex" href={explorerAddress(chainId, sampler)} target="_blank" rel="noreferrer">{shortHex(sampler)}</a> : <HexValue value={sampler} label="sampler address" />}</dd></div>}
      </dl>

      {creating && sampler && <NewAudit sampler={sampler} fee={data.fee} onClose={() => setCreating(false)} onOpen={setPicked} />}
      {pickedRequest && <Inspector key={pickedRequest.id.toString()} request={pickedRequest} requests={data.requests} head={data.head} client={client} oracle={oracle} chainId={chainId} onClose={() => setPicked(null)} />}
    </>
  );
}
