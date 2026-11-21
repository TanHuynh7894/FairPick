import { useCallback, useState } from 'react';
import type { Hex } from 'viem';
import { useApp } from '../app-context';
import { BEACON_ABI, readEntries } from '../chain';
import { beaconActions, beaconPhase, claimState, lockedBond, pickSample, receiptNo, type BeaconPhase, type BeaconRound, type ClaimState } from '../derive';
import { amount, duration, number, uintHex } from '../format';
import { usePoll } from '../hooks';
import { commitmentFor, secretForCommit, storedSecret } from '../secrets';
import { Chip, HexValue, LoginPrompt, Sheet, TxButton, type Tone } from './common';

export const BEACON_PHASE: Record<BeaconPhase, [Tone, string]> = {
  commit: ['wait', 'OPEN TO JOIN'],
  reveal: ['wait', 'REVEALING'],
  finalizable: ['warn', 'READY TO FINALIZE'],
  finalized: ['ok', 'SEED READY'],
  failed: ['warn', 'NO RESULT'],
};

export const CLAIM_TEXT: Record<ClaimState, string> = {
  open: 'Held in the round',
  none: 'None',
  claimable: 'Ready to claim',
  claimed: 'Claimed back',
  forfeited: 'Kept: did not reveal',
};

const ORDER: BeaconPhase[] = ['commit', 'reveal', 'finalizable', 'finalized'];

/** The four stages of a round, with the current one marked, so the panel says where the round is before what to do. */
function Stages({ phase, r, now }: { phase: BeaconPhase; r: BeaconRound; now: number }) {
  const at = phase === 'failed' ? 3 : ORDER.indexOf(phase);
  const stages = [
    ['Join', phase === 'commit' ? duration(r.commitEnd - now) : ''],
    ['Reveal', phase === 'reveal' ? duration(r.revealEnd - now) : ''],
    ['Finalize', ''],
    [phase === 'failed' ? 'No result' : 'Seed', ''],
  ];
  return (
    <ol className="steps steps-row">
      {stages.map(([title, text], i) => (
        <li key={title} className={i < at || (i === 3 && phase === 'finalized') ? 'is-done' : i === 3 && phase === 'failed' ? 'is-failed' : i === at ? 'is-current' : ''}>
          <b>{title}</b>
          {text && <span>{text}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Turns the round's seed into a committee: the same pick rule as AuditSampler, so anyone can redo it. */
function Committee({ seed }: { seed: bigint }) {
  const [of, setOf] = useState('12');
  const [take, setTake] = useState('3');
  const n = Number(of), k = Number(take);
  const ok = Number.isInteger(n) && Number.isInteger(k) && k >= 1 && k <= 32 && k <= n && n <= 1_000_000;
  return (
    <div className="committee">
      <span>From this seed, pick</span>
      <input className="search" inputMode="numeric" aria-label="Members to pick" value={take} onChange={(e) => setTake(e.target.value)} />
      <span>of</span>
      <input className="search" inputMode="numeric" aria-label="Candidates" value={of} onChange={(e) => setOf(e.target.value)} />
      {ok ? <span className="picks picks-sm">{pickSample(seed, n, k).sort((a, b) => a - b).map((p) => <span key={p} className="pick">{receiptNo(p, n)}</span>)}</span> : <span className="muted">1–32, at most the candidates</span>}
    </div>
  );
}

const isSecret = (v: string): v is Hex => /^0x[0-9a-fA-F]{64}$/.test(v.trim());

function SecretBackup({ secret }: { secret: Hex }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="band band-warn">
      <strong>Your secret</strong>
      {shown ? <HexValue value={secret} label="secret" full /> : <button type="button" className="button-quiet" onClick={() => setShown(true)}>SHOW SECRET</button>}
    </div>
  );
}

type Entry = Parameters<typeof claimState>[1];

function guidance(phase: BeaconPhase, entry: Entry, can: ReturnType<typeof beaconActions>, r: BeaconRound, now: number): string {
  if (!entry) return 'Loading…';
  if (can.commit) return 'Open to join.';
  if (can.reveal) return `Reveal now · ${duration(r.revealEnd - now)} left`;
  if (can.finalize) return r.reveals === r.commits ? 'All revealed.' : 'Reveal time is over.';
  if (can.claim) return 'Round closed.';
  if (phase === 'commit' && entry.committed) return `Joined · reveal opens in ${duration(r.commitEnd - now)}`;
  if (phase === 'commit') return 'Open to join.';
  if ((phase === 'reveal' || phase === 'finalizable') && entry.revealed) return 'Revealed · waiting for others';
  if (!entry.committed) return phase === 'finalized' || phase === 'failed' ? 'You did not join.' : 'Joining closed.';
  return 'Done.';
}

export function RoundPanel({ round: r, onClose }: { round: BeaconRound; onClose(): void }) {
  const { client, beacon, chainId, nowSec, beaconData, signer, session } = useApp();
  const me = session?.address;
  const read = useCallback(async () => (await readEntries(client, beacon!, [r], me!))[0], [client, beacon, r, me]);
  const { data: entry, refresh } = usePoll(me ? read : undefined, 3_000);
  // A round with a member list only takes the wallets on it.
  const readMember = useCallback(() => client.readContract({ address: beacon!, abi: BEACON_ABI, functionName: 'isMember', args: [r.id, me!] }), [client, beacon, r.id, me]);
  const { data: member } = usePoll(me && r.members > 0 ? readMember : undefined, 60_000);
  const [typedSecret, setTypedSecret] = useState('');

  const now = Math.max(nowSec, beaconData?.headTime ?? 0);
  const phase = beaconPhase(r, now);
  const can = beaconActions(r, entry ?? null, now);
  const [tone, text] = BEACON_PHASE[phase];
  const saved = me && chainId !== undefined ? storedSecret(chainId, beacon!, r.id, me) : null;
  const secret = saved ?? (isSecret(typedSecret) ? (typedSecret.trim() as Hex) : null);
  const call = (functionName: string, args: readonly unknown[], value?: bigint) =>
    signer!.write({ address: beacon!, abi: BEACON_ABI, functionName, args, value });
  const locked = lockedBond(r);

  return (
    <Sheet title={`Round ${r.id}`} chip={<Chip tone={tone}>{text}</Chip>} onClose={onClose}>
      <dl className="ledger">
        <div><dt>Deposit</dt><dd>{amount(r.bond, chainId)}</dd></div>
        <div><dt>Joined</dt><dd>{number(r.commits)} / {number(r.minParticipants)}</dd></div>
        {r.members > 0 && <div><dt>Open to</dt><dd>{number(r.members)} listed members{member === false && ' · not this wallet'}</dd></div>}
        {locked > 0n && <div><dt>Deposit kept: did not reveal</dt><dd>{amount(locked, chainId)}</dd></div>}
      </dl>

      {phase === 'finalized' && <div className="seed"><span className="latest-kicker">Seed</span><HexValue value={uintHex(r.randomness)} label="round seed" full /></div>}
      {phase === 'finalized' && <Committee seed={r.randomness} />}

      <Stages phase={phase} r={r} now={now} />

      {!signer || !me ? (r.status === 0 ? <LoginPrompt>Sign in to take part.</LoginPrompt> : null) : (
        <section className="verify">
          {!(can.commit || can.reveal || can.finalize || can.claim) && <p>{guidance(phase, entry ?? null, can, r, now)}</p>}

          {can.commit && entry && member === false && <p>This round is for its listed members.</p>}
          {can.commit && entry && member !== false && (
            <TxButton label={`JOIN · ${amount(r.bond, chainId)}`} action={async () => {
              // Written down before sending, so a commit that lands can always be revealed.
              const { secret: fresh } = secretForCommit(chainId!, beacon!, r.id, me);
              await call('commit', [r.id, commitmentFor(chainId!, beacon!, r.id, me, fresh)], r.bond);
              refresh();
            }} />
          )}
          {can.reveal && (
            <>
              {!saved && (
                <div className="field">
                  <label htmlFor="round-secret">Paste your secret</label>
                  <input id="round-secret" className="search" autoComplete="off" value={typedSecret} onChange={(e) => setTypedSecret(e.target.value)} placeholder="0x…" />
                </div>
              )}
              <TxButton label="REVEAL" disabled={!secret} action={async () => { await call('reveal', [r.id, secret]); refresh(); }} />
            </>
          )}
          {can.finalize && <TxButton label="FINALIZE" action={() => call('finalize', [r.id])} />}
          {can.claim && <TxButton label={`CLAIM ${amount(r.bond, chainId)}`} action={async () => { await call('claim', [r.id]); refresh(); }} />}
          {saved && entry?.committed && !entry.revealed && r.status === 0 && <SecretBackup secret={saved} />}
        </section>
      )}
    </Sheet>
  );
}
