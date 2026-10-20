// Release 1.2 — L1: the progression tracker for one person: their level (from their position), the next level and
// every criterion with real numbers (weekly sales and team sales from gauges, lessons learned / taught back), plus the
// criteria the office ticks by hand (admins tick them here). Data: GET /learning/progression/:userId.
import { ArrowRight, CheckCircle2, Circle, Minus, Plus, TrendingUp } from 'lucide-react';
import clsx from 'clsx';
import {
  CAREER_LEVEL_LABELS,
  PROGRESSION_RULES,
  isProgressionMilestoneKey,
  type Progression,
  type ProgressionCriterion,
  type ProgressionRequirement,
} from '@lm/shared';
import { useProgression, useSetMilestone } from '@/api/learning';
import { Badge, Button, Card, CardHeader, ProgressBar, Skeleton, Switch, useToast } from '@/components/ui';
import { ErrorState, apiMessage } from '@/features/common';
import { CareerLadder } from './CareerLadder';
import { WeeklyBars } from './WeeklyBars';

export interface ProgressionPanelProps {
  userId: number;
  /** Admins tick the manual criteria. */
  canEditMilestones?: boolean;
  /** Show the whole ladder under the tracker (needs a full-width column). */
  showLadder?: boolean;
  /** The viewer is the person (copy says "your"). */
  self?: boolean;
  className?: string;
}

export function ProgressionPanel({ userId, canEditMilestones, showLadder = false, self = true, className }: ProgressionPanelProps) {
  const q = useProgression(userId);
  if (q.isLoading) {
    return (
      <Card className={className}>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-4 w-full" lines={4} />
      </Card>
    );
  }
  if (q.isError || !q.data) return <ErrorState className={className} error={q.error} onRetry={() => void q.refetch()} title="Could not load the progression tracker" />;
  const p = q.data;
  return (
    <div className={clsx('space-y-4', className)}>
      <Card>
        <CardHeader
          icon={<TrendingUp />}
          title="Progression"
          description={p.level ? `From ${self ? 'your' : 'their'} position, logged gauges and lessons; criteria from the COD pack.` : undefined}
        />
        <LevelLine p={p} />
        {p.enabled === false ? (
          <p className="mt-4 rounded-lg bg-surface-2/70 p-3 text-sm text-muted">The progression tracker is switched off on this server. The ladder below still shows what each level needs.</p>
        ) : (
          <>
            {p.headline && p.level && <p className="mt-3 text-[15px] font-medium leading-relaxed text-fg">{p.headline}</p>}
            {p.requirements.length > 0 && (
              <ul className="mt-4 space-y-3" aria-label={p.nextLevel ? `What ${CAREER_LEVEL_LABELS[p.nextLevel]} needs` : 'Criteria'}>
                {p.requirements.map((r) => (
                  <Requirement key={r.key} r={r} userId={p.userId} canEdit={Boolean(canEditMilestones)} />
                ))}
              </ul>
            )}
            <SalesChart p={p} self={self} />
          </>
        )}
      </Card>
      {showLadder && p.level && (
        <Card>
          <CardHeader title="The ladder" description="Pre- and post-management progression structure (COD pack pages 18–19)." />
          <CareerLadder current={p.level} next={p.nextLevel} headingLevel="h4" hereLabel={self ? 'You are here' : 'Current level'} />
        </Card>
      )}
    </div>
  );
}

function LevelLine({ p }: { p: Progression }) {
  if (!p.level) return <p className="text-sm text-muted">{p.headline || 'Recruiters sit outside the field ladder.'}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="primary" size="md">
        {CAREER_LEVEL_LABELS[p.level]}
      </Badge>
      {p.nextLevel && (
        <>
          <ArrowRight className="h-4 w-4 text-subtle" aria-label="next" />
          <Badge tone="accent" variant="outline" size="md">
            Next: {CAREER_LEVEL_LABELS[p.nextLevel]}
          </Badge>
        </>
      )}
    </div>
  );
}

function Requirement({ r, userId, canEdit }: { r: ProgressionRequirement; userId: number; canEdit: boolean }) {
  return (
    <li className={clsx('rounded-xl border p-3', r.met ? 'border-success/30 bg-success-soft/50' : 'border-border bg-surface-2/40')}>
      <div className="flex items-start gap-2">
        {r.met ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-sm font-semibold text-fg">{r.label}</span>
            <span className={clsx('text-xs font-medium', r.met ? 'text-success' : 'text-muted')}>{r.met ? 'Met' : 'Not yet'}</span>
          </div>
          <div className="mt-2 space-y-2">
            {r.options.map((o, i) => (
              <div key={o.key}>
                {i > 0 && <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">or</div>}
                <Option o={o} userId={userId} canEdit={canEdit} showLabel={r.options.length > 1} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

function Option({ o, userId, canEdit, showLabel }: { o: ProgressionCriterion; userId: number; canEdit: boolean; showLabel: boolean }) {
  // A met option already says "Reached: …"; its bar (this week against the target) would only confuse.
  const showBar = !o.met && o.current !== null && o.target !== null && o.target > 1 && !o.manual;
  const office = o.manual && (
    <Badge size="sm" tone="neutral">
      Office
    </Badge>
  );
  return (
    <div className="min-w-0">
      {/* A requirement with one way to meet it already names it: just the numbers then. */}
      {showLabel && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className={clsx('font-medium', o.met ? 'text-success' : 'text-fg')}>{o.label}</span>
          {office}
        </div>
      )}
      <p className={clsx('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted', showLabel && 'mt-0.5')}>
        <span>{o.detail}</span>
        {!showLabel && office}
      </p>
      {/* The detail line above carries the numbers; the bar is the picture of them. */}
      {showBar && (
        <div aria-hidden>
          <ProgressBar className="mt-1.5" size="sm" value={Math.min(o.current!, o.target!)} max={o.target!} tone="primary" />
        </div>
      )}
      {o.manual && canEdit && isProgressionMilestoneKey(o.key) && <MilestoneControl o={o} userId={userId} />}
    </div>
  );
}

function MilestoneControl({ o, userId }: { o: ProgressionCriterion; userId: number }) {
  const toast = useToast();
  const set = useSetMilestone();
  const key = o.key;
  if (!isProgressionMilestoneKey(key)) return null;
  const value = o.current ?? 0;
  const save = (v: number) =>
    set.mutate({ userId, key, value: v }, { onError: (e) => toast.error('Could not save that', apiMessage(e, 'Try again in a moment.')) });
  if ((o.target ?? 1) <= 1) {
    return <Switch className="mt-2" size="sm" checked={value >= 1} disabled={set.isPending} onChange={(c) => save(c ? 1 : 0)} label="Confirmed by the office" />;
  }
  return (
    <div className="mt-2 flex items-center gap-2">
      <Button size="icon-sm" variant="outline" label="One fewer" disabled={value <= 0 || set.isPending} onClick={() => save(value - 1)}>
        <Minus />
      </Button>
      <span className="min-w-8 text-center text-sm font-semibold tabular text-fg" aria-live="polite">
        {value}
      </span>
      <Button size="icon-sm" variant="outline" label="One more" disabled={set.isPending} onClick={() => save(value + 1)}>
        <Plus />
      </Button>
      <span className="text-xs text-muted">confirmed by the office</span>
    </div>
  );
}

function SalesChart({ p, self }: { p: Progression; self: boolean }) {
  const weeks = p.weeks ?? [];
  if (weeks.length === 0) return null;
  if (p.level === 'entry') {
    return (
      <WeeklyBars
        className="mt-5"
        title={`${self ? 'Your sales' : 'Sales'} per week, last ${weeks.length} weeks`}
        unit="sales"
        weeks={weeks.map((w) => ({ weekStart: w.weekStart, value: w.sales }))}
        targets={[
          { value: PROGRESSION_RULES.salesWeek, label: String(PROGRESSION_RULES.salesWeek) },
          { value: PROGRESSION_RULES.salesTwoWeeks, label: `${PROGRESSION_RULES.salesTwoWeeks}×2` },
        ]}
      />
    );
  }
  if (p.level === 'campaign_manager' && weeks.every((w) => w.teamSales !== null)) {
    return (
      <WeeklyBars
        className="mt-5"
        title={`Team sales per week, last ${weeks.length} weeks`}
        unit="team sales"
        weeks={weeks.map((w) => ({ weekStart: w.weekStart, value: w.teamSales ?? 0 }))}
        targets={[{ value: PROGRESSION_RULES.teamSalesTwoWeeks, label: `${PROGRESSION_RULES.teamSalesTwoWeeks}×2` }]}
      />
    );
  }
  return null;
}
