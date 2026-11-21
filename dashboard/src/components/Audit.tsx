import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { useApp } from '../app-context';
import { SAMPLER_ABI } from '../chain';
import { listKey, receiptNo, type Audit } from '../derive';
import { amount, number, shortHex, vnd } from '../format';
import { describeList, downloadList, EXAMPLES, listText, matchList, parseCsv, receiptSummary, storeList, type ReceiptList } from '../receipts';
import { Chip, COPY_TEXT, Sheet, TxButton, useCopy } from './common';

/** The picked receipt numbers as small tiles, lowest first. `sampleOf` on chain returns them in draw order. */
export function Picks({ audit, size = 'md' }: { audit: Audit; size?: 'sm' | 'md' }) {
  if (!audit.settled) return <span className="muted">–</span>;
  return (
    <span className={`picks picks-${size}`} aria-label={`Receipts ${audit.picks.join(', ')} of ${audit.itemCount}`}>
      {[...audit.picks].sort((a, b) => a - b).map((p) => <span key={p} className="pick">{receiptNo(p, audit.itemCount)}</span>)}
    </span>
  );
}

/** The receipts to check, one per line: its number, what was bought, how much. With no list, the numbers alone. */
export function ReceiptRows({ audit, list }: { audit: Audit; list: ReceiptList | null }) {
  return (
    <ol className="rrows">
      {[...audit.picks].sort((a, b) => a - b).map((p) => {
        const row = list ? receiptSummary(list, p) : null;
        return (
          <li key={p}>
            <span className="pick">{receiptNo(p, audit.itemCount)}</span>
            <span className="rrow-item">{row ? row.item || `Receipt ${p}` : list ? `Receipt ${p} is not in this file` : `Receipt ${p}`}</span>
            {row?.amount != null && <span className="rrow-amount">{vnd(row.amount)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** What the picked receipts add up to, when the list has an amount column. */
export function pickedTotal(audit: Audit, list: ReceiptList | null): number | null {
  if (!list) return null;
  const amounts = audit.picks.map((p) => receiptSummary(list, p)?.amount ?? null);
  return amounts.some((a) => a === null) ? null : amounts.reduce<number>((sum, a) => sum + a!, 0);
}

function CopyLink({ id }: { id: bigint }) {
  const { state, copy } = useCopy(`${location.origin}${location.pathname}#oracle/${id}`);
  return <button type="button" className="button-quiet" onClick={() => void copy()}>{state !== 'idle' ? COPY_TEXT[state] : 'COPY LINK'}</button>;
}

/** A refusal, large enough to read at a glance: the list was changed, was already drawn, or was never announced. */
export function Refusal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="refusal" role="alert">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

/** The invented lists from examples/, so a list can be tried without going through a file dialog. */
function ExampleMenu({ onPick }: { onPick(example: { name: string; csv: string }): void }) {
  return (
    <select className="search example-menu" aria-label="Example lists" value="" onChange={(e) => { const example = EXAMPLES[Number(e.target.value)]; if (example) onPick(example); }}>
      <option value="">EXAMPLE LISTS…</option>
      {EXAMPLES.map((example, i) => <option key={example.name} value={i}>{example.name}</option>)}
    </select>
  );
}

/** The picked rows of a receipt list this browser has, or a way to load the list and check it against the commitment. */
export function PickedReceipts({ id, audit }: { id: bigint; audit: Audit }) {
  const [text, setText] = useState(() => listText(audit.fileHash));
  const [refused, setRefused] = useState(false);
  const [copy, setCopy] = useState<'same' | 'different' | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => (text === null ? null : parseCsv(text)), [text]);
  const match = useMemo(() => (text === null ? null : matchList(text, audit)), [text, audit]);

  const load = async (file: File) => loadText(await file.text());
  const loadText = (loaded: string) => {
    // A file with other bytes is another list. One with the right bytes and the wrong count is shown, with a warning.
    if (matchList(loaded, audit).kind === 'different') return setRefused(true);
    storeList(loaded);
    setRefused(false);
    setText(listText(audit.fileHash));
  };

  if (!list || !match) {
    return (
      <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void load(f); }}>
        {refused && <Refusal title="FILE CHANGED">This file does not match the committed hash.</Refusal>}
        <div className="list-load">
          {!refused && <span className="muted">Receipt list not in this browser.</span>}
          <button type="button" className="button-quiet" onClick={() => input.current?.click()}>LOAD CSV</button>
          <ExampleMenu onPick={(example) => void loadText(example.csv)} />
          <CopyLink id={id} />
          <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
        </div>
      </div>
    );
  }

  const amountCol = list.header.findIndex((h) => /amount|vnd/i.test(h));
  // A copy somebody was sent can be held against the audit too, without replacing the list shown here.
  const check = (other: string) => setCopy(matchList(other, audit).kind === 'match' ? 'same' : 'different');
  return (
    <div className="picked drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void f.text().then(check); }}>
      {copy === 'different' && <Refusal title="FILE CHANGED">That file does not match the committed hash. It is not the list this audit was drawn from.</Refusal>}
      <div className="list-check">
        {match.kind === 'match'
          ? <><Chip tone="ok">LIST MATCHES</Chip><span className="muted">same hash, {number(audit.itemCount)} receipts</span></>
          : <><Chip tone="bad">COUNT MISMATCH</Chip><span className="tx-error">This file has {number(match.kind === 'count' ? match.rows : 0)} receipts. The audit committed to {number(audit.itemCount)}, so the others could never be picked.</span></>}
      </div>
      <div className="mobile-only"><ReceiptRows audit={audit} list={list} /></div>
      <div className="table-scroll receipts desktop-only" tabIndex={0} role="region" aria-label="Picked receipts">
        <table>
          <thead><tr>{list.header.map((h) => <th key={h} className={/^(no|amount)/i.test(h) ? 'num' : ''}>{h.replace(/_vnd$/i, ' (VND)').replace(/_/g, ' ')}</th>)}</tr></thead>
          <tbody>
            {[...audit.picks].sort((a, b) => a - b).map((p) => {
              const row = list.rows[p - 1];
              return (
                <tr key={p} className="no-pick">
                  {row ? row.map((cell, i) => (
                    <td key={i} className={i === 0 || i === amountCol ? 'num' : ''}>{i === amountCol && /^\d+$/.test(cell) ? number(Number(cell)) : cell}</td>
                  )) : <td colSpan={list.header.length}>Receipt {p} is not in this file.</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="list-actions">
        <button type="button" className="button-quiet" onClick={() => downloadList(audit.fileHash, `fairpick-audit-${id}.csv`)}>DOWNLOAD CSV</button>
        <CopyLink id={id} />
        <ExampleMenu onPick={(example) => check(example.csv)} />
        <button type="button" className="button-quiet" onClick={() => input.current?.click()}>CHECK A FILE</button>
        <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(check); e.target.value = ''; }} />
        {copy === 'same' && <Chip tone="ok">THAT FILE MATCHES</Chip>}
        <span className="muted">The list is on no server. Send the file with the link.</span>
      </div>
    </div>
  );
}

interface Draft {
  name: string;
  text: string;
  rows: number;
  hash: Hex;
}

const draftOf = (name: string, text: string): Draft => {
  const { fileHash, itemCount } = describeList(text);
  return { name, text, rows: itemCount, hash: fileHash };
};

const AUDITOR_KEY = 'fairpick:auditor';
// The auditor's address last used here, or else the one this page was configured with (VITE_AUDITOR).
const configured = (import.meta.env.VITE_AUDITOR as string | undefined) ?? '';
const remembered = () => { try { return localStorage.getItem(AUDITOR_KEY) ?? configured; } catch { return configured; } };
const remember = (value: string) => { try { localStorage.setItem(AUDITOR_KEY, value); } catch { /* Stays for this visit only. */ } };

interface Announced {
  requester: Address;
  itemCount: number;
  sampleSize: number;
  /** The latest draw under this announcement, if there was one. */
  previous: { id: bigint; refunded: boolean } | null;
}

/** What `auditor` announced for this file hash, and whether its one draw was used. Null while it is being read. */
function useAnnouncement(sampler: Address, auditor: Address | null, fileHash: Hex, version: number): Announced | null {
  const { client } = useApp();
  const [state, setState] = useState<{ key: string; value: Announced } | null>(null);
  const key = `${auditor}:${fileHash}:${version}`;
  useEffect(() => {
    if (!auditor) return;
    let current = true;
    void (async () => {
      const [requester, itemCount, sampleSize] = await client.readContract({ address: sampler, abi: SAMPLER_ABI, functionName: 'announcements', args: [auditor, fileHash] });
      const id = await client.readContract({ address: sampler, abi: SAMPLER_ABI, functionName: 'auditOfList', args: [listKey(auditor, fileHash)] });
      const previous = id === 0n ? null : { id, refunded: (await client.readContract({ address: sampler, abi: SAMPLER_ABI, functionName: 'audits', args: [id] })).refunded };
      if (current) setState({ key, value: { requester, itemCount, sampleSize, previous } });
    })().catch(() => {});
    return () => { current = false; };
  }, [client, sampler, auditor, fileHash, key]);
  return state?.key === key ? state.value : null;
}

/** The list to announce or to draw: a file, a dropped file, or one of the example lists. */
function ListField({ draft, onPick }: { draft: Draft; onPick(name: string, text: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  const pickFile = async (file: File) => onPick(file.name.replace(/\.csv$/i, ''), await file.text());
  return (
    <div className="field drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void pickFile(f); }}>
      <label>Receipt list</label>
      <div className="file-row">
        <span className="file-name">{draft.name}.csv</span>
        <button type="button" className="button-quiet" onClick={() => input.current?.click()}>CHOOSE CSV</button>
        <ExampleMenu onPick={(example) => onPick(example.name, example.csv)} />
        <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = ''; }} />
      </div>
      <small className="mono">{number(draft.rows)} receipts · {draft.hash.slice(0, 10)}…{draft.hash.slice(-6)} · or drop a CSV here</small>
    </div>
  );
}

const sampleProblem = (k: number, rows: number) =>
  rows === 0 ? 'This file has no receipts under its header line.'
    : !Number.isInteger(k) || k < 1 || k > 32 ? 'Pick 1 to 32 receipts.'
      : k > rows ? 'The list has fewer receipts than that.' : null;

/**
 * Two people, two steps. The auditor announces a list: its hash, its receipt count, how many receipts to check, and the
 * treasurer's wallet. The treasurer then pays for the draw. A treasurer with no auditor can announce their own list,
 * and the audit says so.
 */
export function NewAudit({ sampler, fee, onClose, onOpen }: { sampler: Address; fee: bigint; onClose(): void; onOpen(id: bigint): void }) {
  const { signer, chainId } = useApp();
  const me = signer?.address ?? null;
  const [role, setRole] = useState<'treasurer' | 'auditor'>('treasurer');
  const [draft, setDraft] = useState<Draft>(() => draftOf(EXAMPLES[0].name, EXAMPLES[0].csv));
  const [label, setLabel] = useState(EXAMPLES[0].name);
  const [sample, setSample] = useState('3');
  const [auditorText, setAuditorText] = useState(remembered);
  const [treasurerText, setTreasurerText] = useState('');
  const [version, setVersion] = useState(0);

  const pick = (name: string, text: string) => {
    setDraft(draftOf(name, text));
    setLabel(name.replace(/ \(.*\)$/, '').slice(0, 40));
  };
  const k = Number(sample);
  // As treasurer: the auditor whose announcement to use. Left empty, the treasurer is their own auditor.
  const auditorTyped = auditorText.trim();
  const auditor = role === 'auditor' ? me : auditorTyped === '' ? me : isAddress(auditorTyped) ? auditorTyped : null;
  const self = Boolean(me && auditor && auditor.toLowerCase() === me.toLowerCase());
  const announced = useAnnouncement(sampler, auditor, draft.hash, version);
  const exists = announced && announced.requester !== zeroAddress;
  const forMe = Boolean(exists && me && announced.requester.toLowerCase() === me.toLowerCase());
  const taken = exists && announced.previous && !announced.previous.refunded ? announced.previous : null;
  const labelTooLong = new TextEncoder().encode(label).length > 64;
  const treasurer = treasurerText.trim();
  const announce = (requester: Address) => async () => {
    storeList(draft.text);
    await signer!.write({ address: sampler, abi: SAMPLER_ABI, functionName: 'announce', args: [draft.hash, draft.rows, k, requester] });
    setVersion((v) => v + 1);
  };

  return (
    <Sheet title="New audit" onClose={onClose}>
      <div className="seg" role="tablist" aria-label="Your part in the audit">
        <button type="button" role="tab" aria-selected={role === 'treasurer'} className={role === 'treasurer' ? 'is-on' : ''} onClick={() => setRole('treasurer')}>I HOLD THE FUND</button>
        <button type="button" role="tab" aria-selected={role === 'auditor'} className={role === 'auditor' ? 'is-on' : ''} onClick={() => setRole('auditor')}>I AM THE AUDITOR</button>
      </div>
      <div className="form">
        <ListField draft={draft} onPick={pick} />

        {role === 'auditor' && (
          <>
            {exists ? (
              <div className="announced"><Chip tone="ok">ANNOUNCED</Chip><span>You announced this list for {shortHex(announced.requester)}: check {announced.sampleSize} of {number(announced.itemCount)}. Give the treasurer your address, {me ? shortHex(me) : ''}.</span></div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="audit-sample">Receipts to check</label>
                  <input id="audit-sample" className="search" inputMode="numeric" autoComplete="off" value={sample} onChange={(e) => setSample(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="audit-treasurer">Treasurer's wallet</label>
                  <input id="audit-treasurer" className="search" autoComplete="off" spellCheck={false} placeholder="0x… the only wallet that may ask for the draw" value={treasurerText} onChange={(e) => setTreasurerText(e.target.value)} />
                </div>
                {sampleProblem(k, draft.rows) && <p className="tx-error" role="alert">{sampleProblem(k, draft.rows)}</p>}
                <TxButton label="ANNOUNCE THIS LIST" disabled={!signer || !announced || Boolean(sampleProblem(k, draft.rows)) || !isAddress(treasurer)} action={announce(treasurer as Address)} />
              </>
            )}
          </>
        )}

        {role === 'treasurer' && (
          <>
            <div className="field">
              <label htmlFor="audit-auditor">Auditor's wallet</label>
              <input id="audit-auditor" className="search" autoComplete="off" spellCheck={false} placeholder="0x… empty: no separate auditor" value={auditorText}
                onChange={(e) => { setAuditorText(e.target.value); if (e.target.value.trim() === '' || isAddress(e.target.value.trim())) remember(e.target.value.trim()); }} />
            </div>
            {!auditor && <p className="tx-error" role="alert">This is not a valid address.</p>}

            {announced && !exists && !self && <Refusal title="NOT ANNOUNCED">This auditor has not announced this list. A draw needs their announcement first.</Refusal>}
            {exists && !forMe && <Refusal title="NOT ANNOUNCED FOR THIS WALLET">The auditor named {shortHex(announced.requester)} as the one who may ask for this draw.</Refusal>}
            {taken && forMe && (
              <Refusal title={`ALREADY DRAWN · AUDIT #${taken.id}`}>
                A list is drawn once. Asking again cannot change the pick.
                <button type="button" className="button-quiet" onClick={() => { onClose(); onOpen(taken.id); }}>OPEN AUDIT #{taken.id.toString()}</button>
              </Refusal>
            )}

            {announced && !exists && self && (
              <>
                <div className="announced"><Chip tone="warn">NO SEPARATE AUDITOR</Chip><span>You announce your own list. The audit will say so.</span></div>
                <div className="field">
                  <label htmlFor="audit-sample">Receipts to check</label>
                  <input id="audit-sample" className="search" inputMode="numeric" autoComplete="off" value={sample} onChange={(e) => setSample(e.target.value)} />
                </div>
                {sampleProblem(k, draft.rows) && <p className="tx-error" role="alert">{sampleProblem(k, draft.rows)}</p>}
                <TxButton label="ANNOUNCE · STEP 1 OF 2" disabled={!signer || Boolean(sampleProblem(k, draft.rows))} action={announce(me!)} />
              </>
            )}

            {exists && forMe && !taken && (
              <>
                <div className="announced">
                  <Chip tone={self ? 'warn' : 'ok'}>{self ? 'NO SEPARATE AUDITOR' : 'ANNOUNCED BY THE AUDITOR'}</Chip>
                  <span>{self ? 'You announced this list yourself' : `Auditor ${shortHex(auditor!)} announced this list for your wallet`}: check {announced.sampleSize} of {number(announced.itemCount)}.</span>
                </div>
                {announced.previous?.refunded && <p className="muted">A second draw: audit #{announced.previous.id.toString()} expired unanswered and was refunded.</p>}
                <div className="field">
                  <label htmlFor="audit-label">Name</label>
                  <input id="audit-label" className="search" autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} />
                </div>
                {labelTooLong && <p className="tx-error" role="alert">Name too long.</p>}
                <TxButton label={`REQUEST · ${amount(fee, chainId)}`} disabled={labelTooLong || !signer} onDone={onClose} action={async () => {
                  storeList(draft.text);
                  return signer!.write({ address: sampler, abi: SAMPLER_ABI, functionName: 'requestAudit', args: [draft.hash, auditor!, label], value: fee });
                }} />
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
