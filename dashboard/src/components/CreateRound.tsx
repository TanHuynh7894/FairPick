import { useState } from 'react';
import { isAddress } from 'viem';
import { useApp } from '../app-context';
import { BEACON_ABI } from '../chain';
import { parseRoundForm, type RoundForm } from '../derive';
import { Sheet, TxButton } from './common';

const PROBLEM = {
  commit: 'Join time must be a whole number of minutes, above 0.',
  reveal: 'Reveal time must be a whole number of minutes, above 0.',
  bond: 'The deposit must be a number above 0.',
  minParticipants: 'The minimum must be a whole number, 2 or more.',
};

const FIELDS: [keyof RoundForm, string, string][] = [
  ['commitMinutes', 'Join (min)', ''],
  ['revealMinutes', 'Reveal (min)', ''],
  ['bond', 'Deposit', ''],
  ['minParticipants', 'Min members', ''],
];

export function CreateRound({ onClose }: { onClose(): void }) {
  const { beacon, signer } = useApp();
  const [form, setForm] = useState<RoundForm>({ commitMinutes: '10', revealMinutes: '10', bond: '0.01', minParticipants: '2' });
  const [members, setMembers] = useState('');
  const parsed = parseRoundForm(form);
  // Left empty, any wallet can join. With addresses, only they can: an outsider cannot enter and then abort the round.
  const list = members.split(/[\s,;]+/).filter(Boolean);
  const badMember = list.find((a) => !isAddress(a));
  const tooFew = parsed.ok && list.length > 0 && new Set(list.map((a) => a.toLowerCase())).size < parsed.args[3];
  const memberProblem = badMember ? `Not an address: ${badMember}` : tooFew ? 'Fewer members than the minimum to take part.' : null;

  return (
    <Sheet title="New round" onClose={onClose}>
      <div className="form">
        {FIELDS.map(([key, label, hint]) => (
          <div className="field" key={key}>
            <label htmlFor={`round-${key}`}>{label}</label>
            <input id={`round-${key}`} className="search" inputMode="decimal" autoComplete="off" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            {hint && <small>{hint}</small>}
          </div>
        ))}
      </div>
      <div className="field">
        <label htmlFor="round-members">Members (optional)</label>
        <textarea id="round-members" className="search members" rows={3} spellCheck={false} autoComplete="off" value={members} onChange={(e) => setMembers(e.target.value)} placeholder="0x… one address per line. Empty: any wallet can join." />
      </div>
      {!parsed.ok && <p className="tx-error" role="alert">{PROBLEM[parsed.field]}</p>}
      {parsed.ok && memberProblem && <p className="tx-error" role="alert">{memberProblem}</p>}
      <TxButton label="CREATE ROUND" disabled={!parsed.ok || Boolean(memberProblem)} onDone={onClose} action={() => signer!.write({ address: beacon!, abi: BEACON_ABI, functionName: 'createRound', args: parsed.ok ? (list.length > 0 ? [...parsed.args, list] : parsed.args) : [] })} />
    </Sheet>
  );
}
