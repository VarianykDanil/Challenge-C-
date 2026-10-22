// Smart release 1.1 (p6): the expected-sales estimate for a scheduled or live event ("expect ≈ 14 (8–20) · 5 reps usually"),
// with an amber "Stretch" or red "Behind target" pill. The forecast comes from GET /events (or /events/:id); events
// without one render no chip at all. Copy: an estimate with its range, never a verdict about people (LOGIC §14.0).
import clsx from 'clsx';
import { Sparkles } from 'lucide-react';
import { EVENT_FORECAST_RULES, type EventForecast, type EventType } from '@lm/shared';
import { Badge, Tooltip } from '@/components/ui';
import { formatNumber, pluralise } from '@/lib/format';

/** How a day of each type reads in a sentence ("BCN private sites"). */
const TYPE_PLURAL: Record<EventType, string> = {
  private_site: 'private sites',
  event: 'events',
  b2b: 'B2B sites',
  residential: 'residential patches',
  retail: 'retail sites',
};

/** "Deansgate team" (or "this team" when the name is not known), never doubling a name that already ends in "team". */
function teamLabel(teamName?: string): string {
  const name = teamName?.trim();
  if (!name) return 'this team';
  return /\bteam$/i.test(name) ? name : `${name} team`;
}

/**
 * "Deansgate team, BCN private sites" · "all teams, BCN private sites" · "all teams, every BCN day". The team is named
 * (not "this team") so the line reads right for anyone looking at another team's event.
 */
export function forecastBasisLabel(f: Pick<EventForecast, 'basis'>, campaignCode: string, type: EventType, teamName?: string): string {
  if (f.basis === 'team') return `${teamLabel(teamName)}, ${campaignCode} ${TYPE_PLURAL[type]}`;
  if (f.basis === 'company') return `all teams, ${campaignCode} ${TYPE_PLURAL[type]}`;
  return `all teams, every ${campaignCode} day`;
}

/** "9–20" (whole sales). */
export function forecastRange(f: Pick<EventForecast, 'low' | 'high'>): string {
  return `${formatNumber(Math.round(f.low))}–${formatNumber(Math.round(f.high))}`;
}

/**
 * Who the estimate is for when people are booked: "4 booked", or — when it counts more people than are booked (a roster
 * still filling up uses the team's usual turnout as its floor; on a live day, people who logged without a booking
 * count too) — "4 booked, 6 expected".
 */
function bookedText(f: Pick<EventForecast, 'expectedReps'>, booked: number): string {
  const expected = Math.round(f.expectedReps);
  return expected > booked ? `${formatNumber(booked)} booked, ${formatNumber(expected)} expected` : `${formatNumber(booked)} booked`;
}

/**
 * ["expect ≈ 14 (8–20)", "· 5 reps usually"]: the two halves a narrow cell may break between (never inside one).
 * Release 1.3 (P8): with people booked the second half reads "· 4 booked" (or "· 4 booked, 6 expected").
 */
export function forecastHeadlineParts(f: Pick<EventForecast, 'expectedSales' | 'expectedReps' | 'low' | 'high'>, booked = 0): [string, string] {
  const reps = Math.max(1, Math.round(f.expectedReps));
  return [`expect ≈ ${formatNumber(Math.round(f.expectedSales))} (${forecastRange(f)})`, booked > 0 ? `· ${bookedText(f, booked)}` : `· ${pluralise(reps, 'rep')} usually`];
}

/** "expect ≈ 14 (8–20) · 5 reps usually": the range is always on show, not only in the hover tooltip (phones). */
export function forecastHeadline(f: Pick<EventForecast, 'expectedSales' | 'expectedReps' | 'low' | 'high'>, booked = 0): string {
  return forecastHeadlineParts(f, booked).join(' ');
}

/**
 * "Estimate from 23 similar days (Deansgate team, BCN private sites, last 12 weeks) · range 9–20 · target 17 needs
 * about 7 reps". The target clause is left out without a target or a rate.
 */
export function forecastSentence(f: EventForecast, targetSales: number, campaignCode: string, type: EventType, teamName?: string): string {
  const parts = [
    `Estimate from ${pluralise(f.basisDays, 'similar day')} (${forecastBasisLabel(f, campaignCode, type, teamName)}, last ${EVENT_FORECAST_RULES.rateWeeks} weeks)`,
    `range ${forecastRange(f)}`,
  ];
  if (targetSales > 0 && f.repsNeeded != null) parts.push(`target ${formatNumber(targetSales)} needs about ${pluralise(f.repsNeeded, 'rep')}`);
  return parts.join(' · ');
}

/** The pill for a flagged forecast, or null. Events (never people) may be "behind target". */
export function ForecastFlag({ flag }: { flag: EventForecast['flag'] }) {
  if (flag === 'stretch') return <Badge tone="warning" size="sm">Stretch</Badge>;
  if (flag === 'at_risk') return <Badge tone="danger" size="sm">Behind target</Badge>;
  return null;
}

/** Plain words for assistive tech (rows put this in their link's accessible name). */
export function forecastAriaText(f: EventForecast): string {
  const flag = f.flag === 'stretch' ? ', the target is a stretch' : f.flag === 'at_risk' ? ', behind target' : '';
  return `estimate about ${formatNumber(Math.round(f.expectedSales))} sales, range ${forecastRange(f)}${flag}`;
}

export interface EventForecastChipProps {
  forecast: EventForecast;
  targetSales: number;
  campaignCode: string;
  type: EventType;
  /** The event's team, named in the basis ("Deansgate team, BCN private sites"). */
  teamName?: string;
  /** `chip` (rows: the headline, wrapping inside its cell, the full sentence on hover) or `detail` (event page: the sentence written out). */
  variant?: 'chip' | 'detail';
  /** Tooltip side for the chip variant. */
  side?: 'top' | 'bottom';
  /** Release 1.3 (P8): people booked on the event (the forecast is then for them). */
  booked?: number;
  className?: string;
}

export function EventForecastChip({ forecast: f, targetSales, campaignCode, type, teamName, variant = 'chip', side = 'top', booked = 0, className }: EventForecastChipProps) {
  const sentence = forecastSentence(f, targetSales, campaignCode, type, teamName);
  const [estimate, reps] = forecastHeadlineParts(f, booked);
  // A block that takes its cell's width and wraps inside it: in a narrow grid cell (Events rows from 768 to ~1600 px)
  // the reps half drops to a second line instead of running over the next cell (each half is an inline-block, so the
  // line breaks between them first). Never truncated: the range stays on show.
  const headline = (
    <span className="flex min-w-0 items-start gap-1 text-xs leading-snug text-muted">
      <Sparkles className="mt-[0.2em] h-3 w-3 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0">
        <span className="inline-block max-w-full">{estimate}</span> <span className="inline-block max-w-full">{reps}</span>
      </span>
    </span>
  );
  if (variant === 'detail') {
    return (
      <div className={clsx('rounded-lg border border-border bg-surface-2/60 px-3 py-2', className)}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-sm font-medium text-fg">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
            Estimate: about {formatNumber(Math.round(f.expectedSales))} sales · {booked > 0 ? `for the ${bookedText(f, booked)}` : `usually ${pluralise(Math.max(1, Math.round(f.expectedReps)), 'rep')}`}
          </span>
          <ForecastFlag flag={f.flag} />
        </div>
        <p className="mt-0.5 text-xs text-muted">{sentence}</p>
      </div>
    );
  }
  return (
    <span className={clsx('flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1', className)} data-testid="event-forecast">
      <Tooltip content={sentence} side={side} className="min-w-0 max-w-full">
        {headline}
      </Tooltip>
      <ForecastFlag flag={f.flag} />
    </span>
  );
}
