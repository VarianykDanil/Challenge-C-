// Release 1.3 slot — OWNED BY P8 venue-insights. The event page's plan: yours ("To make 5 sales at Golden Square you
// need about 120 stops → 42 to table → 21 presentations → 9 closes → 6 taps"), or — for the event's leader and the
// admin — every booked person's, with where the numbers come from and a link to the venue's profile. Mounted in
// pages/EventDetail.tsx after the forecast, in an ErrorBoundary with fallback={null}. A whole Card or nothing: nothing
// for a finished event, for someone neither booked nor managing, while nothing is booked, or with LM_SMART=0.
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowRight, BarChart3, Target } from 'lucide-react';
import type { EventPlan, SalesEventWithMeta } from '@lm/shared';
import { Avatar, Card, CardHeader, Skeleton } from '@/components/ui';
import { useEventPlan } from '@/api/venues';
import { useCurrentUser } from '@/auth/AuthProvider';
import { formatNumber } from '@/lib/format';
import { venuePath } from './VenueLink';
import { bookingsOpen, planBasisText, planRangeText, planTargetText, salesText, stepLabel } from './venueCopy';

export interface EventPlanCardProps {
  event: SalesEventWithMeta;
  /** The page's own rule: the admin, or the leader of the event's team. */
  canManage: boolean;
  className?: string;
}

export function EventPlanCard({ event, canManage, className }: EventPlanCardProps) {
  const me = useCurrentUser();
  const open = bookingsOpen(event);
  const booked = event.bookings?.booked ?? 0;
  const mine = !!event.bookings?.me;
  // managers see everyone booked (GET /plan); anyone else only their own (shares the cache with the strip)
  const enabled = open && booked > 0 && (canManage || mine);
  const q = useEventPlan(event.id, canManage ? null : me.id, { enabled });
  if (!enabled) return null;
  if (q.isLoading) return <Skeleton className={clsx('h-32 max-w-3xl', className)} />;
  const plans = (q.data ?? []).filter((p) => p.steps.length || p.userId === me.id);
  if (!plans.length) return null;
  const own = plans.find((p) => p.userId === me.id) ?? null;
  const others = canManage ? plans.filter((p) => p.userId !== me.id) : [];
  const to = venuePath(event.venue, event.city);

  return (
    <Card className={clsx('max-w-3xl', className)} data-event-plan>
      <CardHeader
        icon={<Target />}
        title={own ? 'Your plan' : `Plans for the ${formatNumber(booked)} booked`}
        description={own ? `An estimate for ${event.venue}, from your numbers and everyone's there.` : `Each person's numbers blended with everyone's at ${event.venue}.`}
        actions={
          to ? (
            <Link to={to} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">
              <BarChart3 className="h-3.5 w-3.5" aria-hidden />
              <span className="max-sm:sr-only">Venue numbers</span>
            </Link>
          ) : undefined
        }
      />
      {own && <OwnPlan plan={own} booked={booked} />}
      {others.length > 0 && (
        <div className={clsx(own && 'mt-5 border-t border-border pt-4')}>
          {own && <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Everyone else booked</h4>}
          <ul className="divide-y divide-border">
            {others.map((p) => <PersonPlan key={p.userId} plan={p} booked={booked} />)}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** "120 stops → 42 to table → …" as five tiles that wrap on a phone, then the target, the range and the basis. */
function OwnPlan({ plan, booked }: { plan: EventPlan; booked: number }) {
  if (!plan.steps.length) return <p className="text-sm text-muted">{plan.sentence}</p>;
  const range = planRangeText(plan);
  return (
    <div>
      <p className="sr-only">{plan.sentence}</p>
      <p className="text-sm text-fg" aria-hidden>
        To make <span className="font-semibold">{salesText(plan.targetSales)}</span> you need about:
      </p>
      <ol className="mt-2 grid grid-cols-2 gap-2 min-[420px]:grid-cols-3 sm:grid-cols-5" aria-hidden>
        {plan.steps.map((s, i) => (
          <li key={s.key} className={clsx('relative flex min-h-14 flex-col justify-center rounded-lg border border-border bg-surface-2/60 px-3 py-2', i === 0 && 'col-span-2 min-[420px]:col-span-1')}>
            <span className="kpi-number text-xl leading-tight text-fg">{formatNumber(s.need)}</span>
            <span className="text-xs text-muted">{stepLabel(s.key, s.need)}</span>
            {i < plan.steps.length - 1 && <ArrowRight className="absolute -right-2 top-1/2 hidden h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-surface text-subtle sm:block" aria-hidden />}
          </li>
        ))}
      </ol>
      <div className="mt-3 space-y-1 text-xs leading-relaxed text-muted">
        <p>{planTargetText(plan, booked)}</p>
        {range && <p>{range}</p>}
        <p>{planBasisText(plan)}</p>
      </div>
    </div>
  );
}

/** One booked person's plan in a row (the leader's view): avatar, name, the aim and where the target came from. */
function PersonPlan({ plan, booked }: { plan: EventPlan; booked: number }) {
  const name = plan.userName ?? 'Someone';
  const first = name.split(' ')[0] ?? name;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Avatar name={name} color={plan.avatarColor} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{name}</p>
        {plan.steps.length ? (
          <>
            <p className="text-sm text-fg">
              <span className="font-semibold">{salesText(plan.targetSales)}</span>
              <span className="text-muted">: </span>
              {plan.steps.map((s, i) => (
                <span key={s.key} className="whitespace-nowrap">
                  {i > 0 && <span className="text-subtle"> → </span>}
                  {formatNumber(s.need)} {i === 0 || i === plan.steps.length - 1 ? stepLabel(s.key, s.need) : ''}
                </span>
              ))}
            </p>
            <p className="text-xs text-muted">{planTargetText(plan, booked, first)}</p>
            {plan.limited && <p className="text-xs text-muted" data-plan-limited>{planBasisText(plan, first)}</p>}
          </>
        ) : (
          <p className="text-xs text-muted">{plan.sentence}</p>
        )}
      </div>
    </li>
  );
}
