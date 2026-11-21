import { useState } from 'react';
import { useApp } from '../app-context';
import { beaconPhase, lockedBond, seatCells, type BeaconPhase, type BeaconRound } from '../derive';
import { amount, duration, number, uintHex } from '../format';
import { Chip, Fingerprint, HexValue, Kpi, Loading, NotConfigured, StaleBand } from './common';
import { CreateRound } from './CreateRound';
import { Intro } from './guide';
import { BEACON_PHASE as PHASE, RoundPanel } from './RoundPanel';

/** One square per participant: outlined for a commit, filled once they revealed. Empty ones are still needed. */
function Seats({ r }: { r: BeaconRound }) {
  const { revealed, committed, empty, hidden } = seatCells(r);
  const cell = (count: number, className: string) => Array.from({ length: count }, (_, i) => <i key={`${className}${i}`} className={className} />);
  return (
    <span className="seats" role="img" aria-label={`${number(r.commits)} joined, ${number(r.reveals)} revealed, at least ${number(r.minParticipants)} needed`}>
      {cell(revealed, 'is-revealed')}{cell(committed, 'is-committed')}{cell(empty, '')}
      {hidden > 0 && <small>+{number(hidden)}</small>}
    </span>
  );
}

/** The tick is the end of commit, the marker the chain time. The contract keeps no start time, so the commit side is drawn as long as the reveal side. */
function Timeline({ r, now, phase }: { r: BeaconRound; now: number; phase: BeaconPhase }) {
  if (phase === 'finalized' || phase === 'failed') return <span className="muted">–</span>;
  const start = r.commitEnd - Math.max(r.revealEnd - r.commitEnd, 1);
  const span = r.revealEnd - start;
  const split = ((r.commitEnd - start) / span) * 100;
  const left = Math.min(100, Math.max(0, ((now - start) / span) * 100));
  const until = phase === 'commit' ? r.commitEnd : r.revealEnd;
  return (
    <span className="timeline">
      <span className="timeline-bar" aria-hidden="true"><i style={{ left: `${split}%` }} className="timeline-split" /><i style={{ left: `${left}%` }} className="timeline-now" /></span>
      <span>{nextStep(r, phase, now, until)}</span>
    </span>
  );
}

/** What happens next in the round, as a sentence anyone can act on. */
function nextStep(r: BeaconRound, phase: BeaconPhase, now: number, until: number): string {
  if (phase === 'commit') return `Join · ${duration(until - now)}`;
  if (phase === 'reveal') return `Reveal · ${duration(until - now)}`;
  return r.reveals === r.commits && now <= r.revealEnd ? 'All revealed' : 'Time is up';
}

function Outcome({ r, phase, chainId }: { r: BeaconRound; phase: BeaconPhase; chainId?: number }) {
  if (phase === 'finalized') return <span className="outcome"><Fingerprint value={r.randomness} /><HexValue value={uintHex(r.randomness)} label="random number" /></span>;
  if (phase !== 'failed') return <>–</>;
  const locked = lockedBond(r);
  return <>{locked > 0n ? `Deposit kept: did not reveal (${amount(locked, chainId)})` : 'No result, deposits returned'}</>;
}

export function BeaconSection() {
  const { beacon, chainId, nowSec, beaconData: data, beaconError: error, signer, openLogin } = useApp();
  const [picked, setPicked] = useState<bigint | null>(null);
  const [creating, setCreating] = useState(false);

  if (!beacon) return <NotConfigured name="beacon" variable="VITE_BEACON_ADDRESS" />;
  if (!data) return error ? <StaleBand error={error} hasData={false} /> : <Loading label="Reading the rounds" />;
  const now = Math.max(nowSec, data.headTime);
  const phases = data.rounds.map((r) => beaconPhase(r, now));
  const count = (...names: BeaconPhase[]) => phases.filter((p) => names.includes(p)).length;
  const pickedRound = data.rounds.find((r) => r.id === picked);

  return (
    <>
      <StaleBand error={error} hasData />
      <Intro id="beacon" title="Group pick" tag={<Chip tone="info">NO NODE</Chip>} note="A committee makes a seed together: each member adds a secret, and no member alone decides it.">
        <button type="button" className="button" onClick={signer ? () => setCreating(true) : openLogin}>{signer ? 'NEW ROUND' : 'SIGN IN TO CREATE A ROUND'}</button>
      </Intro>

      <dl className="kpis kpis-3">
        <Kpi label="Rounds" value={number(data.total)} />
        <Kpi label="In progress" value={number(count('commit', 'reveal'))} note={count('finalizable') > 0 ? `${number(count('finalizable'))} waiting to be finalized` : undefined} />
        <Kpi label="With a seed" value={number(count('finalized'))} />
      </dl>

      <div className="head">
        <h2>Rounds</h2>
      </div>
      {data.rounds.length === 0 ? (
        <div className="empty">No rounds yet.</div>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Rounds">
          <table>
            <thead><tr><th className="num">Round</th><th>Status</th><th>Time</th><th>Joined</th><th>Seed</th></tr></thead>
            <tbody>
              {data.rounds.map((r, i) => (
                <tr key={r.id.toString()} onClick={() => setPicked(r.id)}>
                  <td className="num"><button type="button" className="row-open" aria-label={`Open round ${r.id}`} onClick={(e) => { e.stopPropagation(); setPicked(r.id); }}>{r.id.toString()}</button></td>
                  <td><Chip tone={PHASE[phases[i]][0]}>{PHASE[phases[i]][1]}</Chip></td>
                  <td><Timeline r={r} now={now} phase={phases[i]} /></td>
                  <td><Seats r={r} /> <span className="seats-text">{number(r.commits)}/{number(r.members || r.minParticipants)}{r.members > 0 && ' members'}</span></td>
                  <td><Outcome r={r} phase={phases[i]} chainId={chainId} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pickedRound && <RoundPanel round={pickedRound} onClose={() => setPicked(null)} />}
      {creating && <CreateRound onClose={() => setCreating(false)} />}
    </>
  );
}
