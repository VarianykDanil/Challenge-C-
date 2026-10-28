// The six personal KPI tiles of the dashboard (split out of pages/Dashboard.tsx by p1 with identical output).
import type { Dashboard, Role, Streaks } from '@lm/shared';
import { KpiTile } from '@/components/ui';
import { KpiSkeletons } from '@/features/common';
import { streakHint } from '@/features/smart/streakHint';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatGBP, formatNumber, formatPct, formatRelative } from '@/lib/format';
import { conversionKpi } from '@/lib/ratios';

/** Joins hint fragments with ' · ', skipping empty ones; undefined when nothing is left. */
export function joinHints(...parts: Array<string | null | undefined | false>): string | undefined {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return kept.length ? kept.join(' · ') : undefined;
}

/**
 * p2's streakHint() is a plain function inside the Sales tile's props, so no ErrorBoundary can catch it: a throw (or a
 * non-string) drops the fragment and logs it, and the tiles render as before.
 */
export function safeStreakHint(streaks: Streaks | null | undefined): string | undefined {
  try {
    const hint = streakHint(streaks);
    return typeof hint === 'string' ? hint : undefined;
  } catch (error) {
    console.error('[ErrorBoundary:streak-hint]', error);
    return undefined;
  }
}

/**
 * The Sales tile's hint, in p1's order (lead decision): the rank (or the days worked) first, then p2's streak. The tile
 * gives this hint three lines of its own (`hintLines={3}`) and, on phones, the six tiles use 16 px padding, so neither
 * fragment is cut at 360–390 px. Beside a streak the rank drops its "Ranked" (the "#" says it), which is what makes the
 * longest real hints fit three lines at 360 px: "#6 of 23 company-wide · 8-day sales streak · best 85". On its own it
 * reads as in 1.0, "Ranked #2 of 6 in your team". "0 days worked" is left out beside a streak: on a Monday it would read
 * "0 days worked · 21-day sales streak · best 21".
 */
export function salesHint(personal: Dashboard['personal'], role: Role, streaks: Streaks | null | undefined): string | undefined {
  const streak = safeStreakHint(streaks);
  const position = personal.rank ? `#${personal.rank} of ${personal.rankOutOf} ${role === 'rep' ? 'in your team' : 'company-wide'}` : null;
  const rank = position && !streak ? `Ranked ${position}` : position;
  const days = streak && personal.days === 0 ? null : `${formatNumber(personal.days)} days worked`;
  return joinHints(rank ?? days, streak);
}

/** Phones: 16 px padding for the six tiles (one grid, so the numbers still line up), 20 px from 640 px as before. */
const TILE = 'max-sm:p-4';

export interface PersonalKpisProps {
  dashboard: Dashboard | undefined;
  role: Role;
  /** "vs 5 Oct – 8 Oct" */
  deltaLabel?: string;
  /** insights.personal.streaks: adds the p2 streak hint to the Sales tile. */
  streaks?: Streaks | null;
}

export function PersonalKpis({ dashboard: d, role, deltaLabel, streaks }: PersonalKpisProps) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {!d ? (
        <KpiSkeletons count={6} />
      ) : (
        <>
          <KpiTile className={TILE} label="Sales" value={formatNumber(d.personal.totals.sales)} delta={d.personal.deltas.sales} deltaLabel={deltaLabel} tone="primary" hint={salesHint(d.personal, role, streaks)} hintLines={3} />
          <KpiTile className={TILE} label="Conversion" {...conversionKpi(d.personal.totals.stops, d.personal.ratios.overallConversion)} delta={d.personal.totals.stops > 0 ? d.personal.deltas.conversion : null} deltaLabel={deltaLabel} hint="sales ÷ stops" />
          <KpiTile className={TILE} label="Stops" value={formatNumber(d.personal.totals.stops)} delta={d.personal.deltas.stops} deltaLabel={deltaLabel} hint={`${formatNumber(d.personal.totals.presentations)} presentations`} />
          <KpiTile className={TILE} label="Earnings to date" value={formatGBP(d.personal.earningsToDate)} hint="gross, this period" />
          <PaydayTile nextPayday={d.personal.nextPayday} amount={d.personal.nextPayAmount} />
          <KpiTile className={TILE} label="Punctuality" value={d.personal.punctualityRate == null ? '—' : formatPct(d.personal.punctualityRate)} tone={d.personal.punctualityRate == null ? 'default' : d.personal.punctualityRate >= 0.9 ? 'success' : d.personal.punctualityRate >= 0.75 ? 'warning' : 'danger'} hint="check-ins on time" />
        </>
      )}
    </div>
  );
}

/** The pay still to come: "Next payday", or "Overdue pay" (in red) once that payday has passed (UX-9). */
function PaydayTile({ nextPayday, amount }: { nextPayday: string | null | undefined; amount: number | null | undefined }) {
  if (!nextPayday) return <KpiTile className={TILE} label="Next payday" value="—" hint="No pending run" />;
  const overdue = nextPayday < todayISO();
  const money = amount != null ? formatGBP(amount, { cents: true }) : 'amount pending';
  return (
    <KpiTile
      className={TILE}
      label={overdue ? 'Overdue pay' : 'Next payday'}
      value={formatDateShort(nextPayday)}
      tone={overdue ? 'danger' : 'default'}
      hint={`${money} · ${overdue ? 'was due ' : ''}${formatRelative(nextPayday)}`}
    />
  );
}
