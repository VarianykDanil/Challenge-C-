// The six personal KPI tiles of the dashboard (split out of pages/Dashboard.tsx by p1 with identical output).
import type { Dashboard, Role, Streaks } from '@lm/shared';
import { KpiTile } from '@/components/ui';
import { KpiSkeletons } from '@/features/common';
import { streakHint } from '@/features/smart/streakHint';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatGBP, formatNumber, formatPct, formatRelative } from '@/lib/format';
import { ratioTone } from '@/lib/ratios';

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
 * The Sales tile's hint: p2's streak first (the tile clamps hints to two lines, so on a phone the streak stays
 * visible), then the rank, or the days worked. "0 days worked" is left out beside a streak: on a Monday it would read
 * "21-day sales streak · best 21 · 0 days worked".
 */
export function salesHint(personal: Dashboard['personal'], role: Role, streaks: Streaks | null | undefined): string | undefined {
  const streak = safeStreakHint(streaks);
  const rank = personal.rank ? `Ranked #${personal.rank} of ${personal.rankOutOf} ${role === 'rep' ? 'in your team' : 'company-wide'}` : null;
  const days = streak && personal.days === 0 ? null : `${formatNumber(personal.days)} days worked`;
  return joinHints(streak, rank ?? days);
}

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
          <KpiTile label="Sales" value={formatNumber(d.personal.totals.sales)} delta={d.personal.deltas.sales} deltaLabel={deltaLabel} tone="primary" hint={salesHint(d.personal, role, streaks)} />
          <KpiTile label="Conversion" value={formatPct(d.personal.ratios.overallConversion, 1)} delta={d.personal.deltas.conversion} deltaLabel={deltaLabel} tone={ratioTone('overallConversion', d.personal.ratios.overallConversion)} hint="sales ÷ stops" />
          <KpiTile label="Stops" value={formatNumber(d.personal.totals.stops)} delta={d.personal.deltas.stops} deltaLabel={deltaLabel} hint={`${formatNumber(d.personal.totals.presentations)} presentations`} />
          <KpiTile label="Earnings to date" value={formatGBP(d.personal.earningsToDate)} hint="gross, this period" />
          <KpiTile label="Next payday" value={d.personal.nextPayday ? formatDateShort(d.personal.nextPayday) : '—'} tone={d.personal.nextPayday && d.personal.nextPayday < todayISO() ? 'danger' : 'default'} hint={d.personal.nextPayday ? `${d.personal.nextPayAmount != null ? formatGBP(d.personal.nextPayAmount, { cents: true }) : 'amount pending'} · ${d.personal.nextPayday < todayISO() ? 'overdue · ' : ''}${formatRelative(d.personal.nextPayday)}` : 'No pending run'} />
          <KpiTile label="Punctuality" value={d.personal.punctualityRate == null ? '—' : formatPct(d.personal.punctualityRate)} tone={d.personal.punctualityRate == null ? 'default' : d.personal.punctualityRate >= 0.9 ? 'success' : d.personal.punctualityRate >= 0.75 ? 'warning' : 'danger'} hint="check-ins on time" />
        </>
      )}
    </div>
  );
}
