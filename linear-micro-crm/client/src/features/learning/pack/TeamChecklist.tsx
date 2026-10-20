// Release 1.2 — L1: the leader's (own team) and admin's (everyone) view of the leadership checklist: teach-backs
// waiting for a sign-off, everyone's Learn / Teach counts, and on wider screens the whole grid. Data: GET /learning/team.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Inbox, Users } from 'lucide-react';
import clsx from 'clsx';
import { LESSON_KEYS, POSITION_LABELS, type LessonState, type TeachbackAwaiting, type TeamLearningRow } from '@lm/shared';
import { useSignOffTeachback, useTeamLearning } from '@/api/learning';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ProgressBar, SkeletonCard, useToast } from '@/components/ui';
import { ErrorState, apiMessage } from '@/features/common';
import { LESSONS } from '@/content/learning';
import { formatRelative } from '@/lib/format';

export interface TeamChecklistProps {
  /** Where a person's row links to (their checklist and tracker). */
  personHref: (userId: number) => string;
  isAdmin: boolean;
  className?: string;
}

export function TeamChecklist({ personHref, isAdmin, className }: TeamChecklistProps) {
  const q = useTeamLearning();
  if (q.isLoading) return <SkeletonCard className={className} lines={6} />;
  if (q.isError || !q.data) return <ErrorState className={className} error={q.error} onRetry={() => void q.refetch()} title="Could not load the team checklist" />;
  const { rows, total, pending = [] } = q.data;
  return (
    <div className={clsx('space-y-4', className)}>
      <PendingCard pending={pending} personHref={personHref} />
      <Card padded={false}>
        <div className="p-5 pb-3">
          <CardHeader
            className="mb-0"
            icon={<Users />}
            title={isAdmin ? 'Everyone' : 'Your team'}
            description={`${rows.length} ${rows.length === 1 ? 'person' : 'people'} · ${total} lessons each. Open someone to sign off their teach-backs and see their progression.`}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState className="m-5 mt-0" size="sm" title="Nobody here yet" description="Field people on the team appear here once they are active." />
        ) : (
          <ul className="divide-y divide-border/70 border-t border-border">
            {rows.map((r) => (
              <PersonRow key={r.userId} r={r} total={total} href={personHref(r.userId)} showTeam={isAdmin} />
            ))}
          </ul>
        )}
      </Card>
      {rows.length > 0 && <Grid rows={rows} personHref={personHref} />}
    </div>
  );
}

/** Longer teach-backs are clamped to three lines with "Read all". */
const LONG_TEACHBACK = 220;

function PendingCard({ pending, personHref }: { pending: TeachbackAwaiting[]; personHref: (userId: number) => string }) {
  const toast = useToast();
  const signOff = useSignOffTeachback();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader
        icon={<Inbox />}
        title="Waiting for your sign-off"
        description={pending.length ? `${pending.length} teach-back${pending.length === 1 ? '' : 's'} to read. Sign off once you are happy they could teach it.` : undefined}
      />
      {pending.length === 0 ? (
        <p className="text-sm text-muted">Nothing waiting. Teach-backs your team sends appear here.</p>
      ) : (
        <ul className="space-y-3">
          {pending.slice(0, 12).map((p) => {
            const k = `${p.userId}:${p.lessonKey}`;
            const open = expanded === k;
            const lesson = LESSONS[p.lessonKey];
            return (
              <li key={k} className="rounded-xl border border-border bg-surface-2/40 p-3">
                <div className="flex items-start gap-3">
                  <Avatar name={p.userName} color={p.avatarColor} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Link to={personHref(p.userId)} className="focus-ring rounded text-sm font-semibold text-fg hover:underline">
                        {p.userName}
                      </Link>
                      <span className="text-xs text-muted">{formatRelative(p.teachbackAt)}</span>
                    </div>
                    <Link to={`/learning/pack/${p.lessonKey}`} className="focus-ring rounded text-xs font-medium text-primary hover:underline">
                      {lesson.short}
                    </Link>
                    {p.teachbackText &&
                      (p.teachbackText.length > LONG_TEACHBACK ? (
                        <button type="button" onClick={() => setExpanded(open ? null : k)} aria-expanded={open} className="focus-ring mt-1 block w-full rounded text-left">
                          <span className={clsx('block whitespace-pre-line text-sm leading-relaxed text-fg', !open && 'line-clamp-3')}>{p.teachbackText}</span>
                          <span className="text-xs font-medium text-primary">{open ? 'Show less' : 'Read all'}</span>
                        </button>
                      ) : (
                        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-fg">{p.teachbackText}</p>
                      ))}
                  </div>
                  <Button
                    size="sm"
                    className="min-h-10 shrink-0"
                    loading={signOff.isPending && signOff.variables?.userId === p.userId && signOff.variables?.lessonKey === p.lessonKey}
                    aria-label={`Sign off ${lesson.short} for ${p.userName}`}
                    onClick={() =>
                      signOff.mutate(
                        { userId: p.userId, lessonKey: p.lessonKey, signedOff: true },
                        {
                          onSuccess: () => toast.success(`Signed off: ${lesson.short}`, `${p.userName} has taught it back.`),
                          onError: (e) => toast.error('Could not save the sign-off', apiMessage(e, 'Try again in a moment.')),
                        },
                      )
                    }
                  >
                    Sign off
                  </Button>
                </div>
              </li>
            );
          })}
          {pending.length > 12 && <li className="text-xs text-muted">And {pending.length - 12} more: open each person to see them all.</li>}
        </ul>
      )}
    </Card>
  );
}

function PersonRow({ r, total, href, showTeam }: { r: TeamLearningRow; total: number; href: string; showTeam: boolean }) {
  return (
    <li>
      <Link to={href} className="focus-ring-inset group flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
        <Avatar name={r.userName} color={r.avatarColor} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-semibold text-fg">{r.userName}</span>
            {r.awaitingSignOff > 0 && (
              <Badge tone="warning" size="sm">
                {r.awaitingSignOff} waiting
              </Badge>
            )}
          </div>
          <div className="truncate text-xs text-muted">
            {POSITION_LABELS[r.position]}
            {showTeam && r.teamName ? ` · ${r.teamName}` : ''}
          </div>
          <div className="mt-1.5 grid max-w-md grid-cols-2 gap-3">
            <ProgressBar size="xs" value={r.learned} max={total} tone="primary" label={`Learned ${r.learned} of ${total}`} />
            <ProgressBar size="xs" value={r.taught} max={total} tone="success" label={`Taught ${r.taught} of ${total}`} />
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}

const CELL: Record<LessonState, { cls: string; label: string }> = {
  new: { cls: 'border border-border bg-surface', label: 'not started' },
  learned: { cls: 'bg-primary/35', label: 'learned' },
  teachback_sent: { cls: 'bg-warning ring-2 ring-warning/30', label: 'teach-back sent' },
  taught: { cls: 'bg-success', label: 'taught' },
};

/** The whole checklist at a glance (tablet and up): one row per person, one cell per lesson. */
function Grid({ rows, personHref }: { rows: TeamLearningRow[]; personHref: (userId: number) => string }) {
  return (
    <Card padded={false} className="hidden md:block">
      <div className="p-5 pb-3">
        <CardHeader className="mb-0" title="Checklist grid" description="Every lesson in checklist order. Hover a column number for the lesson." />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
          {(['new', 'learned', 'teachback_sent', 'taught'] as LessonState[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className={clsx('inline-block h-3 w-3 rounded-[3px]', CELL[s].cls)} />
              {CELL[s].label}
            </span>
          ))}
        </div>
      </div>
      <div className="scrollbar-thin overflow-x-auto border-t border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-surface-2/60">
              <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-4 py-2 text-left font-semibold text-muted">
                Person
              </th>
              {LESSON_KEYS.map((k, i) => (
                <th key={k} scope="col" className="px-0.5 py-2 text-center font-semibold tabular text-muted" title={LESSONS[k].short}>
                  <Link to={`/learning/pack/${k}`} className="focus-ring inline-block min-w-5 rounded hover:text-primary" aria-label={LESSONS[k].short}>
                    {i + 1}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-t border-border/60">
                <th scope="row" className="sticky left-0 z-10 max-w-[12rem] truncate bg-surface px-4 py-1.5 text-left font-medium text-fg">
                  <Link to={personHref(r.userId)} className="focus-ring rounded hover:underline">
                    {r.userName}
                  </Link>
                </th>
                {r.lessons.map((l) => (
                  <td key={l.lessonKey} className="px-0.5 py-1.5 text-center">
                    <span
                      className={clsx('mx-auto block h-4 w-4 rounded-[4px]', CELL[l.state].cls)}
                      role="img"
                      aria-label={`${LESSONS[l.lessonKey].short}: ${CELL[l.state].label}`}
                      title={`${LESSONS[l.lessonKey].short}: ${CELL[l.state].label}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
