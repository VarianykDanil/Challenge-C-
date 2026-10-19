/**
 * "Your week in review" digest — OWNED BY p9-week-in-review-digest.
 *
 * Pure, en-GB, deterministic: the same facts always give the same sentences. The server (lib/smart/digest.ts) gathers
 * the facts from the functions behind the tiles (totalsFor + periodDeltas, rankedBoard, the stored payroll run or
 * weekPayFor, coachingInsights, recruitmentSummary, eventForecasts, the checkInList count), so a digest can never
 * contradict a tile. This module only words them.
 *
 * Privacy: pay (anyone's), payroll totals and the check-in count are `private` bullets, which `digestText` never
 * includes. Names appear only where the leaderboard already shows them (the leader's team board), and never for
 * anyone on the leader's private check-in list (that line is left out rather than reworded). Copy rules: LOGIC.md §14.0.
 */
import { LATE_GRACE_MINUTES } from '../constants.ts';
import type { DigestBullet, Role, WeekDigest } from '../types.ts';
import { addDays, isoToUTC } from './dates.ts';
import { EVENT_FORECAST_RULES } from './eventForecast.ts';

const NUM = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const GBP_WHOLE = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const GBP_PENCE = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** plural(1, 'sale') → '1 sale'; plural(2, 'sale') → '2 sales'; plural(1240, 'stop') → '1,240 stops'. */
export function plural(n: number, noun: string, pluralNoun?: string): string {
  const v = Number.isFinite(n) ? n : 0;
  return `${NUM.format(v)} ${v === 1 ? noun : (pluralNoun ?? `${noun}s`)}`;
}

/** GBP via Intl en-GB: whole pounds without pence ("£1,050"), otherwise two places ("£412.50"). */
export function gbp(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return (Number.isInteger(v) ? GBP_WHOLE : GBP_PENCE).format(v === 0 ? 0 : v);
}

/**
 * 'up 3 on the week before' | 'down 2 on the week before' | 'the same as the week before' | 'no comparison yet'.
 * No comparison when the week before is null, 0 or not a number (never NaN). `format` words the difference
 * (default: an en-GB number; pass `gbp` for money).
 */
export function deltaPhrase(cur: number, prev: number | null | undefined, format: (n: number) => string = (n) => NUM.format(n)): string {
  if (prev == null || prev === 0 || !Number.isFinite(prev) || !Number.isFinite(cur)) return 'no comparison yet';
  const diff = Math.round((cur - prev) * 100) / 100;
  if (diff === 0) return 'the same as the week before';
  return `${diff > 0 ? 'up' : 'down'} ${format(Math.abs(diff))} on the week before`;
}

/** "Your week in review · w/c 12 Oct". */
export function digestTitle(weekStart: string): string {
  return `Your week in review · ${weekLabel(weekStart)}`;
}

// ─────────────────────────── Facts ───────────────────────────

/** Stops and sales for the week and the week before, plus periodDeltas().conversion (relative; null = no comparison). */
export interface DigestFunnel {
  current: { stops: number; sales: number };
  /** Null when there is nothing to compare with (e.g. the person's first week). */
  previous: { stops: number; sales: number } | null;
  conversionChange: number | null;
}

/** One row of a leaderboard the caller can already see (rankedBoard). `movement` = previous rank − rank; null = new. */
export interface DigestBoardRow {
  userId: number;
  userName: string;
  rank: number;
  movement: number | null;
  sales: number;
}

/** The caller's own pay for the week: the stored payroll run, or (no run yet) the weekPayFor estimate. */
export interface DigestPay {
  gross: number;
  /** The Friday after the week (paydayForWeek / the run's due date). */
  payday: string;
  status: 'pending' | 'paid' | 'late' | 'failed' | 'estimate';
  paidDate: string | null;
}

export interface RepDigestFacts {
  funnel: DigestFunnel;
  /** The rep's own team board (what GET /leaderboard shows them); null without a team. */
  board: { teamName: string; rows: DigestBoardRow[]; meId: number } | null;
  /** The plan's bonus and the week's sales; null when the plan has no bonus. `reached` comes from the stored run when there is one. */
  bonus: { threshold: number; amount: number; sales: number; reached: boolean } | null;
  /** coachingInsights on the week's funnel: the first warning (weakest stage), else the next tip. */
  tip: string | null;
  /** Private. Null = nothing to pay for the week. */
  pay: DigestPay | null;
}

/** Team events in the week after the digest week: forecasts for the ones still to come, actuals for completed ones. */
export interface DigestNextWeek {
  weekStart: string;
  /** Scheduled / live events dated today or later. */
  upcoming: number;
  /** Of `upcoming`, how many have an eventForecast; expected / target sums are over these only. */
  forecasted: number;
  /** Σ expectedSales of the forecasted events (unrounded). */
  expectedSales: number;
  /** Σ targetSales of the forecasted events, or of every upcoming event when none has a forecast. */
  targetSales: number;
  /** Completed events in that week (when the week has already started or passed). */
  completed: number;
  completedSales: number;
  completedTarget: number;
}

export interface LeaderDigestFacts {
  teamName: string;
  funnel: DigestFunnel;
  /** The leader's team board for the week (rankedBoard with teamId). */
  board: DigestBoardRow[];
  /** Recorded check-ins of the team's gauge rows in the week (punctualitySummary). */
  late: { late: number; recorded: number };
  nextWeek: DigestNextWeek | null;
  /** Private: the size of the leader's check-in list. `userIds` only keeps those people out of named lines. */
  checkIns: { count: number; userIds: number[] } | null;
}

export interface AdminDigestFacts {
  companyName: string;
  funnel: DigestFunnel;
  /** Σ g.sales × payout (GAUGE_PAYOUT_SQL), rounded to pence — the finance summary's revenue for the week. */
  revenue: { current: number; previous: number | null };
  /** Sales per campaign this week and the week before (campaigns with gauges in either week). */
  campaigns: { name: string; current: number; previous: number }[];
  /** recruitmentSummary(monday, sunday). */
  recruitment: { applied: number; hired: number };
  /**
   * Private. Runs for the week (due the Friday after) and the failed runs still to send again in the to-pay window
   * (the Runs to pay card's and the bell's: week_start in the last 12 weeks). `paydayPassed`: the payday
   * is before today, so unpaid runs read "still to pay" instead of "due".
   */
  payroll: { payday: string; runs: number; gross: number; unpaidRuns: number; unpaidGross: number; failedRuns: number; failedGross: number; paydayPassed?: boolean };
}

export interface RecruiterDigestFacts {
  applied: { current: number; previous: number | null };
  interviews: { current: number; previous: number | null };
  hired: { current: number; previous: number | null };
  /** Open candidates past their next action now (recruitmentSummary.overdueActions, the "Overdue actions" tile). */
  overdueActions: number;
  /** Interviews that need their outcome recorded now (shared outcomesToRecord for this recruiter). */
  outcomesToRecord: number;
  /** Candidates in the open pipeline now. */
  openPipeline: number;
}

/** The figures one digest is built from; only the caller's role's section is read. */
export interface DigestFacts {
  weekStart: string;
  weekEnd: string;
  rep?: RepDigestFacts;
  leader?: LeaderDigestFacts;
  admin?: AdminDigestFacts;
  recruiter?: RecruiterDigestFacts;
}

// ─────────────────────────── Wording helpers ───────────────────────────

/** "w/c 12 Oct" */
function weekLabel(monday: string): string {
  const d = new Date(isoToUTC(monday));
  return `w/c ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** "Fri 23 Oct" */
function dayLabel(iso: string): string {
  const d = new Date(isoToUTC(iso));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st … */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Strip what WhatsApp, Markdown or HTML would read as formatting from a name or a sentence. */
function plain(s: string): string {
  return s.replace(/[<>*#_~`]/g, '').replace(/\s+/g, ' ').trim();
}

/** Conversion as a percentage rounded to one decimal place (0 with no stops). */
function conv1(sales: number, stops: number): number {
  return stops > 0 ? Math.round((sales / stops) * 1000) / 10 : 0;
}

function pct1(sales: number, stops: number): string {
  return `${conv1(sales, stops).toFixed(1)}%`;
}

/** "up from 1.9% the week before" | "down from 2.6% the week before" | "the same as the week before" | "no comparison yet". */
function conversionPhrase(f: DigestFunnel): string {
  const prev = f.previous;
  if (!prev || f.conversionChange === null || !Number.isFinite(f.conversionChange) || prev.stops <= 0 || f.current.stops <= 0) return 'no comparison yet';
  const now = pct1(f.current.sales, f.current.stops);
  const before = pct1(prev.sales, prev.stops);
  if (now === before || f.conversionChange === 0) return 'the same as the week before';
  return `${f.conversionChange > 0 ? 'up' : 'down'} from ${before} the week before`;
}

/**
 * One lever when sales fell but conversion held or rose: volume. "Conversion held, so stops are the lever: about 43
 * stops make a sale." Null otherwise (a conversion dip is the coaching tip's job, not a second lever here).
 */
function volumeLever(f: DigestFunnel, subject: 'your' | 'the team'): string | null {
  const prev = f.previous;
  if (!prev || prev.sales <= 0 || f.current.sales >= prev.sales || f.current.sales <= 0 || f.conversionChange === null) return null;
  if (conv1(f.current.sales, f.current.stops) < conv1(prev.sales, prev.stops) && f.conversionChange < 0) return null;
  const perSale = Math.ceil(f.current.stops / f.current.sales);
  const whose = subject === 'your' ? 'Your' : "The team's";
  return `${whose} conversion is holding, so the volume is the lever: about ${plural(perSale, 'stop')} make a sale.`;
}

function rankPhrase(movement: number | null): string {
  if (movement === null) return 'not ranked the week before';
  if (movement === 0) return 'the same place as the week before';
  return `${movement > 0 ? 'up' : 'down'} ${plural(Math.abs(movement), 'place')} on the week before`;
}

function bullet(text: string, isPrivate = false): DigestBullet {
  return { text: plain(text), private: isPrivate };
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "Next week (w/c 19 Oct): 6 events, expect about 78 sales (estimate 64–92) against targets of 90." */
function nextWeekLine(n: DigestNextWeek): string {
  const label = `Next week (${weekLabel(n.weekStart)})`;
  if (n.upcoming > 0) {
    const count = n.completed > 0 ? `${plural(n.upcoming, 'event')} still to come` : plural(n.upcoming, 'event');
    if (n.forecasted === 0) return `${label}: ${count} with targets of ${plural(n.targetSales, 'sale')}.`;
    const e = Math.max(0, n.expectedSales);
    const band = EVENT_FORECAST_RULES.z * Math.sqrt(e);
    const range = `estimate ${NUM.format(Math.max(0, Math.round(e - band)))}–${NUM.format(Math.round(e + band))}`;
    const scope = n.forecasted < n.upcoming ? `; the ${n.forecasted} with a forecast expect` : ', expect';
    return `${label}: ${count}${scope} about ${plural(Math.round(e), 'sale')} (${range}) against targets of ${NUM.format(n.targetSales)}.`;
  }
  if (n.completed > 0) {
    return `The week after (${weekLabel(n.weekStart)}): ${plural(n.completed, 'event')} made ${plural(n.completedSales, 'sale')} against targets of ${NUM.format(n.completedTarget)}.`;
  }
  return `${label}: no events booked yet.`;
}

function payLine(pay: DigestPay | null, weekStart: string): string {
  if (!pay) return `No pay for ${weekLabel(weekStart)}.`;
  const amount = gbp(pay.gross);
  if (pay.status === 'estimate') return `Your pay for the week: about ${amount} gross (an estimate until the payroll run is made; paid ${dayLabel(pay.payday)}).`;
  if (pay.status === 'paid' || pay.status === 'late') return `Your pay for the week: ${amount} gross, paid ${dayLabel(pay.paidDate ?? pay.payday)}.`;
  if (pay.status === 'failed') return `Your pay for the week: ${amount} gross, due ${dayLabel(pay.payday)} — the first transfer did not go through and will be sent again.`;
  return `Your pay for the week: ${amount} gross, due ${dayLabel(pay.payday)}.`;
}

// ─────────────────────────── Per role ───────────────────────────

function repBullets(f: RepDigestFacts, weekStart: string): DigestBullet[] {
  const out: DigestBullet[] = [];
  const { current: cur, previous: prev } = f.funnel;
  const worked = cur.stops > 0 || cur.sales > 0;

  // 1–2. Sales, stops and conversion vs the week before
  if (worked) {
    out.push(bullet(`You made ${plural(cur.sales, 'sale')} — ${deltaPhrase(cur.sales, prev?.sales)}.`));
    const lever = volumeLever(f.funnel, 'your');
    out.push(bullet(`${plural(cur.stops, 'stop')} (${deltaPhrase(cur.stops, prev?.stops)}) at ${pct1(cur.sales, cur.stops)} conversion — ${conversionPhrase(f.funnel)}.${lever ? ` ${lever}` : ''}`));
  } else {
    out.push(bullet(`No gauges logged this week — 0 sales.`));
    out.push(
      bullet(
        prev && (prev.stops > 0 || prev.sales > 0)
          ? `The week before: ${plural(prev.sales, 'sale')} from ${plural(prev.stops, 'stop')}.`
          : 'Nothing logged the week before either, so there is no comparison yet.',
      ),
    );
  }

  // 3. Team rank and movement (the board the rep already sees)
  if (f.board) {
    const team = f.board.teamName;
    const me = f.board.rows.find((r) => r.userId === f.board!.meId);
    if (me) {
      const joint = f.board.rows.filter((r) => r.rank === me.rank).length > 1 ? 'joint ' : '';
      out.push(bullet(`You finished ${joint}${ordinal(me.rank)} of ${f.board.rows.length} on ${team} — ${rankPhrase(me.movement)}.`));
    } else {
      out.push(bullet(`You are not on the ${team} board this week — it starts with your first logged day.`));
    }
  } else {
    out.push(bullet('You are not on a team board yet, so there is no rank this week.'));
  }

  // 4. Bonus outcome (a plan rule, not pay: the threshold and amount are the same for everyone on the plan)
  if (f.bonus && f.bonus.threshold > 0 && worked) {
    const { threshold, amount, sales, reached } = f.bonus;
    const prize = gbp(amount);
    if (reached || sales >= threshold) out.push(bullet(`You reached the ${prize} bonus — ${plural(sales, 'sale')} against the ${NUM.format(threshold)} needed.`));
    else if (threshold - sales === 1) out.push(bullet(`You finished one sale short of the ${prize} bonus.`));
    else out.push(bullet(`You finished ${plural(threshold - sales, 'sale')} short of the ${prize} bonus (${NUM.format(threshold)} needed).`));
  }

  // 5. The weakest-stage tip
  if (f.tip) out.push(bullet(`Tip: ${f.tip}`));

  // 6. Pay for the week (private)
  out.push(bullet(payLine(f.pay, weekStart), true));
  return out;
}

function leaderBullets(f: LeaderDigestFacts): DigestBullet[] {
  const out: DigestBullet[] = [];
  const team = f.teamName;
  const { current: cur, previous: prev } = f.funnel;
  const hidden = new Set(f.checkIns?.userIds ?? []);

  // 1–2. Team sales and conversion vs the week before
  out.push(bullet(`${team} made ${plural(cur.sales, 'sale')} — ${deltaPhrase(cur.sales, prev?.sales)}.`));
  const lever = volumeLever(f.funnel, 'the team');
  out.push(bullet(`Team conversion ${pct1(cur.sales, cur.stops)} from ${plural(cur.stops, 'stop')} — ${conversionPhrase(f.funnel)}.${lever ? ` ${lever}` : ''}`));

  // 3. Top seller(s); left out when anyone sharing the top spot is on the private check-in list
  const top = f.board.filter((r) => r.rank === 1 && r.sales > 0);
  if (top.length && top.every((r) => !hidden.has(r.userId))) {
    const sellers = top.map((r) => plain(r.userName));
    out.push(
      bullet(
        top.length === 1
          ? `Top seller: ${sellers[0]} with ${plural(top[0]!.sales, 'sale')}.`
          : `Joint top sellers: ${names(sellers)} with ${plural(top[0]!.sales, 'sale')} each.`,
      ),
    );
  }

  // 4. Biggest movers up and down (new entrants ignored; ties: better rank, then name). A mover on the check-in list
  //    is left out, never swapped for the next one, so the line stays true.
  const movers = f.board.filter((r) => r.movement !== null && r.movement !== 0);
  const order = (a: DigestBoardRow, b: DigestBoardRow) => Math.abs(b.movement!) - Math.abs(a.movement!) || a.rank - b.rank || a.userName.localeCompare(b.userName);
  const up = movers.filter((r) => r.movement! > 0).sort(order)[0];
  const down = movers.filter((r) => r.movement! < 0).sort(order)[0];
  const parts: string[] = [];
  if (up && !hidden.has(up.userId)) parts.push(`biggest move up: ${plain(up.userName)}, ${plural(up.movement!, 'place')} to ${ordinal(up.rank)}`);
  if (down && !hidden.has(down.userId)) parts.push(`biggest move down: ${plain(down.userName)}, ${plural(-down.movement!, 'place')} to ${ordinal(down.rank)}`);
  if (parts.length) {
    const text = parts.join('; ');
    out.push(bullet(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`));
  }

  // 5. Late check-ins (count only)
  const { late, recorded } = f.late;
  if (recorded === 0) out.push(bullet('No check-in times were recorded this week.'));
  else if (late === 0) out.push(bullet(`All ${plural(recorded, 'recorded check-in')} were on time.`));
  else out.push(bullet(`${NUM.format(late)} of ${plural(recorded, 'recorded check-in')} ${late === 1 ? 'was' : 'were'} late (more than ${LATE_GRACE_MINUTES} minutes after the start).`));

  // 6. Next week's events
  if (f.nextWeek) out.push(bullet(nextWeekLine(f.nextWeek)));

  // 7. The check-in list, as a count only (private)
  if (f.checkIns) {
    const n = f.checkIns.count;
    out.push(bullet(n === 0 ? 'Nobody is on your check-in list this week.' : `${plural(n, 'person', 'people')} on your check-in list — the dashboard shows who.`, true));
  }
  return out;
}

function adminBullets(f: AdminDigestFacts, weekStart: string): DigestBullet[] {
  const out: DigestBullet[] = [];
  const { current: cur, previous: prev } = f.funnel;

  // 1–2. Company sales and revenue vs the week before
  out.push(bullet(`${f.companyName} made ${plural(cur.sales, 'sale')} — ${deltaPhrase(cur.sales, prev?.sales)}.`));
  out.push(bullet(`Revenue ${gbp(f.revenue.current)} — ${deltaPhrase(f.revenue.current, f.revenue.previous, gbp)}.`));

  // 3–4. The campaign with the biggest rise and the one with the biggest fall (ties: by name)
  const moves = f.campaigns.map((c) => ({ ...c, name: plain(c.name), diff: c.current - c.previous })).filter((c) => c.diff !== 0);
  const order = (a: { diff: number; name: string }, b: { diff: number; name: string }) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name);
  const rise = moves.filter((c) => c.diff > 0).sort(order)[0];
  const fall = moves.filter((c) => c.diff < 0).sort(order)[0];
  if (rise) out.push(bullet(`Biggest rise: ${rise.name}, up ${plural(rise.diff, 'sale')} to ${NUM.format(rise.current)}.`));
  if (fall) out.push(bullet(`Biggest fall: ${fall.name}, down ${plural(-fall.diff, 'sale')} to ${NUM.format(fall.current)}.`));
  if (!rise && !fall) out.push(bullet('Every campaign sold the same as the week before.'));

  // 5. Recruitment
  out.push(bullet(`Recruitment: ${plural(f.recruitment.hired, 'hire')} and ${plural(f.recruitment.applied, 'application')}.`));

  // 6–7. Payroll (private)
  const p = f.payroll;
  if (p.runs === 0) out.push(bullet(`No payroll runs for ${weekLabel(weekStart)} yet.`, true));
  else if (p.unpaidRuns === 0) out.push(bullet(`Payroll for ${weekLabel(weekStart)}: ${gbp(p.gross)} across ${plural(p.runs, 'run')}, all paid.`, true));
  else {
    const paid = p.runs - p.unpaidRuns;
    if (p.paydayPassed) {
      out.push(bullet(`Payroll for ${weekLabel(weekStart)}: ${gbp(p.unpaidGross)} across ${plural(p.unpaidRuns, 'run')} still to pay (due ${dayLabel(p.payday)}${paid > 0 ? `; ${NUM.format(paid)} already paid` : ''}).`, true));
    } else {
      out.push(bullet(`Payroll due ${dayLabel(p.payday)}: ${gbp(p.unpaidGross)} across ${plural(p.unpaidRuns, 'run')}${paid > 0 ? ` (${NUM.format(paid)} already paid)` : ''}.`, true));
    }
  }
  if (p.failedRuns > 0) out.push(bullet(`${plural(p.failedRuns, 'failed transfer')} to send again, ${gbp(p.failedGross)} in all.`, true));
  return out;
}

function recruiterBullets(f: RecruiterDigestFacts): DigestBullet[] {
  const out: DigestBullet[] = [];
  out.push(bullet(`${plural(f.applied.current, 'application')} — ${deltaPhrase(f.applied.current, f.applied.previous)}.`));
  out.push(bullet(`${plural(f.interviews.current, 'interview')} — ${deltaPhrase(f.interviews.current, f.interviews.previous)}.`));
  out.push(bullet(`${plural(f.hired.current, 'hire')} — ${deltaPhrase(f.hired.current, f.hired.previous)}.`));
  out.push(
    bullet(
      f.overdueActions === 0
        ? 'No open candidate is past their next action — every one has a next step in date.'
        : `${plural(f.overdueActions, 'open candidate')} ${f.overdueActions === 1 ? 'is' : 'are'} past their next action — clearing the oldest first keeps them warm.`,
    ),
  );
  out.push(
    bullet(
      f.outcomesToRecord === 0
        ? 'No interview outcomes are waiting to be recorded.'
        : `${plural(f.outcomesToRecord, 'interview outcome')} to record now.`,
    ),
  );
  out.push(bullet(`${plural(f.openPipeline, 'candidate')} in the open pipeline.`));
  return out;
}

/** 5–8 bullets for the role (none when the role's facts are missing). Private bullets come last. */
export function buildDigest(role: Role, facts: DigestFacts): DigestBullet[] {
  let out: DigestBullet[] = [];
  if (role === 'rep' && facts.rep) out = repBullets(facts.rep, facts.weekStart);
  else if (role === 'leader' && facts.leader) out = leaderBullets(facts.leader);
  else if (role === 'admin' && facts.admin) out = adminBullets(facts.admin, facts.weekStart);
  else if (role === 'recruiter' && facts.recruiter) out = recruiterBullets(facts.recruiter);
  // shareable first, private last, each group in its written order; never more than 8
  return [...out.filter((b) => !b.private), ...out.filter((b) => b.private)].slice(0, 8);
}

/** title + newline + '• ' lines for the shareable bullets only. No markdown or HTML; '' when nothing is shareable. */
export function digestText(d: Pick<WeekDigest, 'title' | 'bullets'>): string {
  const lines = d.bullets.filter((b) => !b.private).map((b) => `• ${plain(b.text)}`);
  return lines.length ? [plain(d.title), ...lines].join('\n') : '';
}

/** The week after `weekStart` (for the "Next week" line). */
export function nextWeekStart(weekStart: string): string {
  return addDays(weekStart, 7);
}
