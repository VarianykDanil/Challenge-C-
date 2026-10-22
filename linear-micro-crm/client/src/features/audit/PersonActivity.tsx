// Release 1.3 slot — OWNED BY P9 audit-everything (laid down by r3-foundation).
// Team → person → Activity (administrators): that person's timeline from the audit trail (GET /audit/person/:userId) —
// everything they did, newest first (changes, sign-ins and failed attempts on their account, exports, records they
// opened), a line with their last sign-in, last activity (not counting failed tries on the sign-in page, which may be
// somebody else's) and failed sign-ins in the last 30 days, the kind chips, and
// "Show more" in steps of 20 (up to 200; the Audit page has the rest). Mounted in pages/UserDetail.tsx in the right
// column under the performance panel, administrators only, in an ErrorBoundary with fallback={null}. A whole Card.
// Viewing it is not itself recorded (it is a summary on a person's page; opening the audit trail is).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowUpRight, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { AUDIT_EVENT_KIND_LABELS, type UserWithTeam } from '@lm/shared';
import { usePersonActivity } from '@/api/audit';
import { Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { AuditEntryItem } from './AuditEntryItem';
import { KindChips, type KindFilter } from './kinds';

export interface PersonActivityProps {
  user: UserWithTeam;
  className?: string;
}

const FIRST = 10;
const MORE = 20;
const MAX = 200;

export function PersonActivity({ user, className }: PersonActivityProps) {
  const [kind, setKind] = useState<KindFilter>('');
  const [limit, setLimit] = useState(FIRST);
  const q = usePersonActivity(user.id, { kind, limit });
  const data = q.data;
  const first = user.firstName || 'They';
  const choose = (k: KindFilter) => {
    setKind(k);
    setLimit(FIRST);
  };
  const shown = data?.rows.length ?? 0;
  const total = data?.total ?? 0;
  const trailLink = `/audit?userId=${user.id}${kind ? `&kind=${kind}` : ''}`;

  return (
    <Card className={clsx('min-w-0', className)}>
      <CardHeader
        title="Activity"
        icon={<Activity />}
        description={`Everything ${first} did in Linear Hub, and failed attempts to sign in to their account, newest first. Visible to administrators.`}
      />

      {data && (
        <dl className="mb-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted">Last signed in</dt>
            <dd className="font-medium text-fg tabular">{data.lastSignInAt ? formatDateTime(data.lastSignInAt) : 'Not since the trail began'}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted">Last active</dt>
            <dd className="font-medium text-fg tabular">{data.lastActiveAt ? formatDateTime(data.lastActiveAt) : '—'}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted" title="Failed sign-ins, wrong PINs and wrong two-step codes on this account">Failed attempts, last 30 days</dt>
            <dd className={clsx('inline-flex items-center gap-1 font-medium tabular', data.failedSignIns > 0 ? 'text-danger' : 'text-fg')}>
              {data.failedSignIns > 0 && <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
              {data.failedSignIns > 0 ? formatNumber(data.failedSignIns) : 'None'}
            </dd>
          </div>
        </dl>
      )}

      <KindChips value={kind} onChange={choose} omit={['automatic', 'client']} aria-label={`Show ${first}'s`} className="mb-3" />

      {q.isError ? (
        <div className="rounded-lg border border-border bg-surface-2/60 p-3 text-sm">
          <p className="text-fg">The activity could not be loaded.</p>
          <Button variant="outline" size="sm" className="mt-2 h-10 sm:h-8" onClick={() => void q.refetch()}>Try again</Button>
        </div>
      ) : q.isLoading ? (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((i) => <div key={i} className="space-y-1.5"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/3" /></div>)}
        </div>
      ) : total === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted">
          {kind ? `No ${AUDIT_EVENT_KIND_LABELS[kind].toLowerCase()} for ${first} yet.` : `Nothing recorded for ${first} yet.`}
        </p>
      ) : (
        <div className={clsx('-mx-5 border-y border-border', q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isFetching || undefined}>
          <ul className="divide-y divide-border">
            {data!.rows.map((r) => <AuditEntryItem key={r.id} entry={r} compact hideWho />)}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        {total > 0 ? <span className="tabular">Showing {formatNumber(shown)} of {formatNumber(total)}</span> : <span />}
        <span className="flex flex-wrap items-center gap-2">
          {shown < total && limit < MAX && (
            <Button variant="outline" size="sm" className="h-10 sm:h-8" disabled={q.isFetching} onClick={() => setLimit((l) => Math.min(MAX, l + MORE))}>
              Show more
            </Button>
          )}
          <Link to={trailLink} className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-md px-1 font-medium text-primary hover:underline sm:min-h-8">
            {shown < total && limit >= MAX ? 'See the rest in the audit trail' : 'Open in the audit trail'} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </span>
      </div>
    </Card>
  );
}
