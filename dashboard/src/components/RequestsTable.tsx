import { useState } from 'react';
import { requestState, type OracleRequest } from '../derive';
import { duration, latency, number, plural, shortHex, vnd } from '../format';
import { loadList, receiptSummary } from '../receipts';
import { Picks } from './Audit';
import { Chip, type Tone } from './common';

const PAGE = 15;

export function requestChip(r: OracleRequest, head: bigint): [Tone, string] {
  const { state, blocksLeft } = requestState(r, head);
  if (state === 'pending') return [blocksLeft <= 32 ? 'warn' : 'wait', 'WAITING'];
  if (state === 'overdue') return ['warn', 'OVERDUE'];
  if (state === 'expired') return ['bad', r.refunded ? 'REFUNDED' : 'EXPIRED'];
  if (r.answer && !r.answer.callbackOk) return ['warn', 'CALLBACK FAILED'];
  if (r.audit?.reported) return r.audit.missing ? ['bad', 'RECEIPT MISSING'] : ['ok', 'ALL FOUND'];
  return ['ok', r.audit ? 'PICKED' : 'ANSWERED'];
}

/** One line under the chip, saying what the state means for the caller. */
export function requestNote(r: OracleRequest, head: bigint): string {
  const { state, blocksLeft } = requestState(r, head);
  if (state === 'pending') return `${plural(blocksLeft, 'block')} left to answer`;
  if (state === 'overdue') return 'past 256 blocks, waiting for refund';
  if (state === 'expired') return 'fee refunded';
  return r.answer && !r.answer.callbackOk ? 'result stored, can be fetched' : '';
}

interface Props {
  requests: OracleRequest[];
  head: bigint;
  nowSec: number;
  onPick(id: bigint): void;
}

const name = (r: OracleRequest) => (r.audit ? r.audit.label || 'Untitled list' : shortHex(r.consumer));

/** The first picked receipt in words, when this browser has the list: a number alone says little. */
function FirstPick({ r }: { r: OracleRequest }) {
  const audit = r.audit;
  if (!audit?.settled) return null;
  const list = loadList(audit.fileHash);
  const lowest = Math.min(...audit.picks);
  const row = list ? receiptSummary(list, lowest) : null;
  if (!row?.item) return null;
  return <small className="batch-sub pick-words">{row.item}{row.amount !== null && <> · {vnd(row.amount)}</>}{audit.picks.length > 1 && <> · +{audit.picks.length - 1}</>}</small>;
}

export function RequestsTable({ requests, head, nowSec, onPick }: Props) {
  const [shown, setShown] = useState(PAGE);
  const page = requests.slice(0, shown);
  const chip = (r: OracleRequest) => {
    const [tone, text] = requestChip(r, head);
    return <Chip tone={tone}>{text}</Chip>;
  };

  return (
    <>
      <div className="table-scroll desktop-only" tabIndex={0} role="region" aria-label="Audits">
        <table>
          <thead>
            <tr>
              <th className="num">ID</th>
              <th>List</th>
              <th>Receipts to check</th>
              <th className="num">Time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.id.toString()} onClick={() => onPick(r.id)}>
                <td className="num"><button type="button" className="row-open" aria-label={`Open request ${r.id}`} onClick={(e) => { e.stopPropagation(); onPick(r.id); }}>{r.id.toString()}</button></td>
                <td>
                  <span className="batch">{name(r)}</span>
                  {r.audit && <small className="batch-sub">{r.audit.sampleSize} of {number(r.audit.itemCount)}{r.audit.draw > 1 && <> · draw {r.audit.draw}</>}</small>}
                </td>
                <td>{r.audit ? <><Picks audit={r.audit} size="sm" /><FirstPick r={r} /></> : <span className="muted">–</span>}</td>
                <td className="num">{r.answer ? latency(r.answer.latencySec) : '–'}</td>
                <td>{chip(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="cards mobile-only">
        {page.map((r) => (
          <li key={r.id.toString()}>
            <button type="button" className="card" onClick={() => onPick(r.id)}>
              <span className="card-title">{name(r)}</span>
              {chip(r)}
              {r.audit?.settled && <Picks audit={r.audit} size="sm" />}
              <span className="card-meta">#{r.id.toString()} · {r.answer ? latency(r.answer.latencySec) : `${duration(nowSec - r.requestTime)} ago`}</span>
            </button>
          </li>
        ))}
      </ul>

      {requests.length > shown && (
        <button type="button" className="button-quiet" onClick={() => setShown((n) => n + PAGE)}>
          MORE ({number(requests.length - shown)})
        </button>
      )}
    </>
  );
}
