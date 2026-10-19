// Private "Check in with…" list — OWNED BY p4-leader-check-ins-coaching.
// Mounted (inside ErrorBoundaries) in the leader's team card with insights.team.checkIns, and in CompanySection
// (admin) with insights.company.checkIns and showTeam. Contract:
//   people === null / undefined → render nothing (not entitled, loading, or LM_SMART=0);
//   people === []               → the empty state 'Nobody needs a check-in this week'.
// Each person: avatar, name (plus team for the admin), the first two reasons on their own lines, a '+N more'
// toggle under them that reveals the rest in the same list (above the toggle, so the reasons read in order), and a
// link to their profile. Reasons are conversation starters, never verdicts.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, HeartHandshake, Lock, Smile } from 'lucide-react';
import clsx from 'clsx';
import type { CheckInPerson } from '@lm/shared';
import { Avatar } from '@/components/ui';

export interface CheckInListProps {
  people: CheckInPerson[] | null | undefined;
  /** Admin view: show each person's team next to their name. */
  showTeam?: boolean;
  className?: string;
}

/** Reasons shown before the '+N more' disclosure. */
const VISIBLE_REASONS = 2;

export function CheckInList({ people, showTeam = false, className }: CheckInListProps) {
  const headingId = useId();
  if (!people) return null;
  return (
    <section aria-labelledby={headingId} className={clsx('min-w-0', className)} data-testid="check-in-list">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
          <HeartHandshake className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="font-sans text-sm font-semibold tracking-normal text-fg">Check in with…</h3>
          <p className="mt-0.5 flex items-start gap-1 text-xs leading-relaxed text-muted">
            <Lock className="mt-[3px] h-3 w-3 shrink-0" aria-hidden />
            <span>Private to you — conversation starters, not verdicts</span>
          </p>
        </div>
      </div>
      {people.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg bg-surface-2 p-3 text-xs text-muted">
          <Smile className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          Nobody needs a check-in this week
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {people.map((p) => (
            <CheckInRow key={p.userId} person={p} showTeam={showTeam} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckInRow({ person: p, showTeam }: { person: CheckInPerson; showTeam: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const more = p.reasons.length - VISIBLE_REASONS;
  const shown = open ? p.reasons : p.reasons.slice(0, VISIBLE_REASONS);
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <Link
        to={`/team/${p.userId}`}
        className="focus-ring -mx-2 flex min-h-10 items-center gap-3 rounded-lg px-2 py-1 hover:bg-surface-2"
        aria-label={`${p.userName}${showTeam && p.teamName ? `, ${p.teamName}` : ''}: open profile`}
      >
        <Avatar name={p.userName} color={p.avatarColor} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{p.userName}</span>
          {showTeam && p.teamName && <span className="block truncate text-xs text-muted">{p.teamName}</span>}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      </Link>
      <ul id={listId} className="mt-1 space-y-1 pl-11" aria-label={`Why check in with ${p.userName}`}>
        {shown.map((r) => (
          <Reason key={r.code} text={r.text} />
        ))}
      </ul>
      {more > 0 && (
        <div className="pl-11">
          <button
            type="button"
            className="focus-ring inline-flex min-h-10 items-center rounded-md text-xs font-medium text-primary hover:underline"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Show less' : `+${more} more`}
          </button>
        </div>
      )}
    </li>
  );
}

function Reason({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 text-xs leading-snug text-muted">
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" aria-hidden />
      <span className="min-w-0">{text}</span>
    </li>
  );
}
