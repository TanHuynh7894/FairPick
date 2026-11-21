import { useEffect, useState } from 'react';
import type { Address, Hex, PublicClient } from 'viem';
import { useApp } from '../app-context';
import { SAMPLER_ABI } from '../chain';
import { auditsOf, EXPIRY_BLOCKS, listKey, missingMask, missingReceipts, receiptNo, requestState, selfAnnounced, type Audit, type OracleRequest } from '../derive';
import { errorText, explorerTx, number, plural, shortHex, uintHex } from '../format';
import type { Verification } from '../verify';
import { Chip, Fingerprint, HexValue, Sheet, TxButton } from './common';
import { requestChip } from './RequestsTable';
import { PickedReceipts, Picks } from './Audit';

/** Four squares in a row: what happened to the request, at a glance. Only a step that went wrong or is still open says more. */
function Steps({ r, head }: { r: OracleRequest; head: bigint }) {
  const { state, blocksLeft } = requestState(r, head);
  const a = r.answer;
  const missed = state === 'overdue' || state === 'expired';
  const steps: { done: boolean; failed?: boolean; title: string; detail?: string }[] = [
    { done: true, title: 'Sent' },
    { done: Boolean(a) || r.status === 2, failed: missed, title: 'Signed', detail: a ? undefined : state === 'pending' ? `${plural(blocksLeft, 'block')} left` : 'Missed' },
    { done: Boolean(a), title: 'Checked' },
    { done: Boolean(a), failed: a ? !a.callbackOk : false, title: 'Delivered', detail: a && !a.callbackOk ? 'Stored on oracle' : undefined },
  ];
  return (
    <ol className="steps steps-row">
      {steps.map((s) => (
        <li key={s.title} className={s.failed ? 'is-failed' : s.done ? 'is-done' : ''}>
          <b>{s.title}</b>
          {s.detail && <span>{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

function Verify({ client, chainId, oracle, request }: { client: PublicClient; chainId?: number; oracle: Address; request: OracleRequest }) {
  const [state, setState] = useState<{ busy?: boolean; result?: Verification; error?: string }>({});
  const run = async () => {
    setState({ busy: true });
    try {
      // Loaded only when asked for: the pairing code is most of the page's weight.
      const { verifyAnswer } = await import('../verify');
      // Let "computing" paint first. The pairing holds the main thread for a moment.
      await new Promise((resolve) => setTimeout(resolve, 30));
      setState({ result: await verifyAnswer(client, chainId!, oracle, request) });
    } catch (e) {
      setState({ error: errorText(e) });
    }
  };
  const { result } = state;
  const allOk = result?.kind === 'checked' && result.signatureOk && result.randomnessOk && result.picksOk !== false;
  return (
    <section className="verify" aria-live="polite">
      <button type="button" className="button" disabled={state.busy || chainId === undefined} onClick={run}>
        {state.busy ? 'CHECKING…' : result ? 'CHECK AGAIN' : 'VERIFY SIGNATURE'}
      </button>
      {state.error && <p className="verify-error">{state.error}</p>}
      {result?.kind === 'unreadable' && (
        <p className="verify-note">Signature not in calldata. The contract checked it on chain.</p>
      )}
      {result?.kind === 'checked' && (
        <>
          {allOk && <p className="verify-plain">{request.audit ? 'Nobody chose these receipts.' : 'Nobody chose this number.'} This request has exactly one valid signature, and the pick follows from it.</p>}
          <ul className="checks">
            <li><Chip tone={result.signatureOk ? 'ok' : 'bad'}>{result.signatureOk ? 'VALID' : 'INVALID'}</Chip><span>The oracle's signature for this request <small>BLS pairing, checked here</small></span></li>
            <li><Chip tone={result.randomnessOk ? 'ok' : 'bad'}>{result.randomnessOk ? 'MATCH' : 'MISMATCH'}</Chip><span>The number is the hash of that signature <small>keccak256(signature)</small></span></li>
            {result.picksOk !== undefined && <li><Chip tone={result.picksOk ? 'ok' : 'bad'}>{result.picksOk ? 'MATCH' : 'MISMATCH'}</Chip><span>The receipts follow from the number <small>pick(number, count, sample)</small></span></li>}
            {result.signedBy && <li><Chip tone={result.signedBy.ok ? 'ok' : 'bad'}>{result.signedBy.ok ? `${result.signedBy.threshold} OF ${result.signedBy.count}` : 'MISMATCH'}</Chip><span>Signed by key shares {result.signedBy.shares.join(' and ')} <small>their partial signatures, checked against the share keys in the contract</small></span></li>}
            <li className="checks-time">{number(Math.round(result.ms))} ms in this browser</li>
          </ul>
        </>
      )}
    </section>
  );
}

/** What a single audit does not show by itself: other draws of the list, and how busy its requester and auditor are. */
function useContext(audit: Audit | undefined, version: number) {
  const { client, sampler } = useApp();
  const [context, setContext] = useState<{ draws: number; drawsOfFile: number; byRequester: number; byAuditor: number } | null>(null);
  const fileHash = audit?.fileHash;
  const requester = audit?.requester;
  const auditor = audit?.auditor;
  useEffect(() => {
    if (!sampler || !fileHash || !requester || !auditor) return;
    let current = true;
    const read = { address: sampler, abi: SAMPLER_ABI } as const;
    void Promise.all([
      client.readContract({ ...read, functionName: 'drawsOfList', args: [listKey(auditor, fileHash)] }),
      client.readContract({ ...read, functionName: 'drawsOfFile', args: [fileHash] }),
      client.readContract({ ...read, functionName: 'auditsBy', args: [requester] }),
      client.readContract({ ...read, functionName: 'announcedBy', args: [auditor] }),
    ]).then(([draws, drawsOfFile, byRequester, byAuditor]) => { if (current) setContext({ draws, drawsOfFile, byRequester, byAuditor }); }).catch(() => {});
    return () => { current = false; };
  }, [client, sampler, fileHash, requester, auditor, version]);
  return context;
}

/** The end of the story: what the auditor found when they looked at the picked receipts. */
function AuditorResult({ id, audit }: { id: bigint; audit: Audit }) {
  const { signer, sampler } = useApp();
  const [notFound, setNotFound] = useState<ReadonlySet<number>>(new Set());
  const sorted = [...audit.picks].sort((a, b) => a - b);
  if (audit.reported) {
    const missing = missingReceipts(audit);
    return (
      <div className={`result ${missing.length ? 'result-bad' : 'result-ok'}`} role="status">
        <strong>AUDITOR RESULT · {audit.picks.length - missing.length} OF {audit.picks.length} FOUND</strong>
        <span>{missing.length ? `Not found: receipt ${missing.join(', ')}.` : 'Every picked receipt was there.'} Recorded on chain by the auditor.</span>
      </div>
    );
  }
  const mine = signer && signer.address.toLowerCase() === audit.auditor.toLowerCase();
  if (!mine || !sampler) return <p className="muted">The auditor has not recorded a result yet.</p>;
  const toggle = (p: number) => setNotFound((old) => { const next = new Set(old); if (!next.delete(p)) next.add(p); return next; });
  return (
    <section className="report">
      <p>You are the auditor. Mark each receipt you could not find, then record the result. It cannot be changed.</p>
      <div className="report-picks">
        {sorted.map((p) => (
          <button key={p} type="button" className={`report-pick${notFound.has(p) ? ' is-missing' : ''}`} aria-pressed={notFound.has(p)} onClick={() => toggle(p)}>
            <span className="pick">{receiptNo(p, audit.itemCount)}</span>{notFound.has(p) ? 'NOT FOUND' : 'FOUND'}
          </button>
        ))}
      </div>
      <TxButton label={`RECORD · ${sorted.length - notFound.size} OF ${sorted.length} FOUND`} action={() => signer.write({ address: sampler, abi: SAMPLER_ABI, functionName: 'report', args: [id, missingMask(audit.picks, notFound)] })} />
    </section>
  );
}

function TxLink({ chainId, hash }: { chainId?: number; hash: Hex }) {
  const link = chainId !== undefined ? explorerTx(chainId, hash) : undefined;
  return link ? <a className="hex" href={link} target="_blank" rel="noreferrer">{shortHex(hash)}</a> : <HexValue value={hash} label="transaction hash" />;
}

interface Props {
  request: OracleRequest;
  /** Everything loaded, to place this audit among the others of its requester. */
  requests: readonly OracleRequest[];
  head: bigint;
  client: PublicClient;
  oracle: Address;
  chainId?: number;
  onClose(): void;
}

export function Inspector({ request: r, requests, head, client, oracle, chainId, onClose }: Props) {
  const [tone, text] = requestChip(r, head);
  const used = r.answer ? r.answer.latencyBlocks : Math.min(Number(head - r.requestBlock), 256);
  const context = useContext(r.audit, r.audit?.reported ? 1 : 0);
  const audit = r.audit;
  const siblings = audit ? auditsOf(requests, audit.requester) : [];
  const position = siblings.findIndex((s) => s.id === r.id) + 1;

  return (
    <Sheet title={audit ? `Audit #${r.id}` : `Request #${r.id}`} chip={<Chip tone={tone}>{text}</Chip>} onClose={onClose}>
        {audit && (
          <div className="audit-head">
            <p className="latest-kicker">{audit.settled ? 'Receipts to check' : 'Receipts to pick'} · {audit.sampleSize} of {number(audit.itemCount)}</p>
            <p className="audit-label">{audit.label || 'Untitled list'}</p>
            {audit.settled && <Picks audit={audit} size="md" />}
          </div>
        )}
        {audit?.settled && <PickedReceipts key={audit.fileHash} id={r.id} audit={audit} />}

        {audit?.settled && <AuditorResult id={r.id} audit={audit} />}

        {audit && (
          <dl className="ledger">
            <div>
              <dt>Announced by <HexValue value={audit.auditor} label="auditor address" /></dt>
              <dd>{selfAnnounced(audit) ? <Chip tone="warn">NO SEPARATE AUDITOR</Chip> : <Chip tone="ok">AUDITOR, BEFORE THE DRAW</Chip>}</dd>
            </div>
            <div>
              <dt>Draws of this list</dt>
              <dd>
                {audit.draw === 1 && (context?.draws ?? 1) === 1
                  ? <Chip tone="ok">DRAWN ONCE</Chip>
                  : <Chip tone="warn">DRAW {audit.draw} OF {context?.draws ?? audit.draw}</Chip>}
              </dd>
            </div>
            {context && context.drawsOfFile > context.draws && (
              <div><dt>Same file drawn under other auditors</dt><dd><Chip tone="warn">{number(context.drawsOfFile - context.draws)}</Chip></dd></div>
            )}
            <div>
              <dt>Audits by this wallet</dt>
              <dd>{context ? (position > 0 ? `no. ${position} of ${number(context.byRequester)}` : number(context.byRequester)) : '–'}</dd>
            </div>
            <div>
              <dt>Lists this auditor announced</dt>
              <dd>{context ? number(context.byAuditor) : '–'}</dd>
            </div>
          </dl>
        )}
        {audit && audit.draw > 1 && <p className="muted">An earlier draw of this list got no answer within 256 blocks and was refunded. It never produced a pick.</p>}

        {r.answer && <Verify key={r.id.toString()} client={client} chainId={chainId} oracle={oracle} request={r} />}

        <Steps r={r} head={head} />

        {!r.answer && (
          <div className="window">
            <p><span>Window</span><b>{number(used)} / {EXPIRY_BLOCKS.toString()} blocks</b></p>
            <div className="window-bar" aria-hidden="true"><i style={{ width: `${Math.max((used / 256) * 100, 0.6)}%` }} /></div>
          </div>
        )}

        {r.answer ? (
          <div className="inspector-value">
            <Fingerprint value={r.answer.randomness} className="fp-large" />
            <HexValue value={uintHex(r.answer.randomness)} label="number" />
          </div>
        ) : <p className="muted">No number yet</p>}

        <dl className="facts facts-col">
          {audit && <div><dt>Requester</dt><dd><HexValue value={audit.requester} label="requester address" /></dd></div>}
          {audit && <div><dt>List hash</dt><dd><HexValue value={audit.fileHash} label="receipt list hash" /></dd></div>}
          {!audit && <div><dt>Caller</dt><dd><HexValue value={r.consumer} label="caller contract address" /></dd></div>}
          {r.requestTx && <div><dt>Request tx</dt><dd><TxLink chainId={chainId} hash={r.requestTx} /></dd></div>}
          {r.answer && <div><dt>Answer tx</dt><dd><TxLink chainId={chainId} hash={r.answer.txHash} /></dd></div>}
          {r.answer?.from && <div><dt>Sent by node wallet</dt><dd><HexValue value={r.answer.from} label="node wallet address" /></dd></div>}
          {r.answer?.gasUsed !== undefined && <div><dt>Gas charged for the check</dt><dd>{number(Number(r.answer.gasUsed))}</dd></div>}
        </dl>
    </Sheet>
  );
}
