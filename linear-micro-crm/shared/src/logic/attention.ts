/**
 * The role-scoped "Needs attention" feed — OWNED BY p5-needs-attention-feed.
 *
 * Pure and deterministic: the same input and clock always give the same items, keys and sentences. Items are sorted
 * danger → warning → info, then newest first (`at`), then by key; at most ATTENTION_MAX_ITEMS. Keys are derived from
 * the thing they are about (`gauges:event:42:user:10`), so an item that has been dealt with simply stops appearing
 * and the client's per-device seen / toasted sets stay meaningful across reloads.
 *
 * The input is already scoped by the route (GET /me/attention): a rep only ever passes their own rows, their own
 * team's events and their own runs. The rules below narrow further by role and never widen.
 * Copy follows docs/LOGIC.md §14.0 (British English, GBP, one lever per warning, kind about people).
 */
import type {
  AttentionItem,
  AttentionSeverity,
  CandidateStage,
  CandidateWithMeta,
  GaugeEntry,
  Interview,
  PayPlan,
  PayrollRunWithUser,
  Role,
  SalesEventWithMeta,
  User,
} from '../types.ts';
import { addDays, daysBetween, dayOfWeek, isValidISODate, startOfWeekISO } from './dates.ts';
import { estimateWeekPay, paydayForWeek } from './finance.ts';
import { isOverdue } from './recruitment.ts';

export const ATTENTION_MAX_ITEMS = 20;

/** Every threshold the rules use, in one place (documented in docs/smart/p5-needs-attention-feed.md). */
export const ATTENTION_RULES = {
  /** Days back the input covers (events and gauge rows dated ≥ today − 3). */
  lookbackDays: 3,
  /** Own unlogged event days: today − 2 … today (deliberately the spec's short window, not the whole unpaid week). */
  ownGapDays: 2,
  /** Team gaps: the event ended at least this long ago … */
  gapMinMinutes: 120,
  /** … and at most this long ago. */
  gapMaxMinutes: 48 * 60,
  /** Events with no rows at all: dated today − 2 … today, ended ≥ gapMinMinutes ago. */
  emptyDays: 2,
  /** Live events are "behind target" from this time … */
  behindFrom: '13:00',
  /** … when sales so far are below this share of the target. */
  behindShare: 0.5,
  /** Unusual rows: dated today − 2 … today. */
  oddDays: 2,
  /** Stops with nobody at the table. */
  oddStopsNoTable: 30,
  /** Stops with a very high conversion … */
  oddStopsHighConversion: 50,
  /** … above this sales ÷ stops. */
  oddConversion: 0.2,
  /** Interviews still "pending" this long after their start need an outcome. */
  interviewOutcomeAfterMinutes: 120,
  /** "My interviews in the next 24 h". */
  interviewSoonMinutes: 24 * 60,
  /** Runs count as "just paid" while paid_date ≥ today − 6 (one pay cycle). */
  paidRecentDays: 6,
  /** GET /finance/payroll's default window: week_start between mondayOf(today) − 12 weeks and today. */
  payrollWindowWeeks: 12,
  /** Own unpaid runs older than this are left to the Finance page. */
  ownRunsWeeks: 52,
  /** Pay-cost framing: "usually attends" = logged on ≥ this share of the team's event days … */
  usualAttendanceShare: 0.5,
  /** … with at least this many team event days in the look-back. */
  usualAttendanceMinDays: 3,
  /** The look-back for "usually attends" (days before the feed's own window). */
  usualAttendanceDays: 28,
  /** Event notes are cut to this many characters. */
  notesMax: 140,
  /** Names listed in a gap or an overdue summary. */
  gapNames: 5,
  overdueNames: 3,
  soonNames: 3,
} as const;

/** The clock the rules run against (business zone, Europe/London). */
export interface AttentionNow {
  today: string;
  /** "HH:MM" */
  nowHHMM: string;
  nowISO: string;
}

/** An interview with the candidate fields the rules need (the route joins them in its one interview query). */
export interface AttentionInterview extends Interview {
  candidateName: string;
  candidateFirstName: string;
  candidateOwnerId: number | null;
  candidateStage: CandidateStage;
}

/** How often the caller logged on their own team's event days before the feed's window (pay-cost framing). */
export interface AttentionAttendance {
  /** Distinct dates with a completed own-team event in the look-back. */
  teamDays: number;
  /** How many of those dates the caller has a gauge row on. */
  workedDays: number;
}

/** Everything the rules read, already scoped to what the caller may see (the route never widens it). */
export interface AttentionInput {
  me: { id: number; role: Role; teamId: number | null; firstName: string; twoFactorEnabled: boolean; startDate?: string };
  /** The caller's own pay plan (for "that day's £60 base plus commission"); null when unknown. */
  plan: PayPlan | null;
  /** Events dated today − 3 … tomorrow that the caller may see (rep / leader: own team; admin: all). */
  events: ReadonlyArray<SalesEventWithMeta>;
  /** Gauge rows on those dates for the people in scope (numbers only; rep: own; leader: own team; admin: all). */
  entries: ReadonlyArray<Pick<GaugeEntry, 'id' | 'eventId' | 'userId' | 'date' | 'stops' | 'table' | 'sales' | 'submittedAt'>>;
  /** Active members of the teams in scope (leader: own team; admin: all; rep: themself). */
  members: ReadonlyArray<Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'teamId' | 'startDate' | 'status'>>;
  /** Own runs (unpaid, or paid in the last 7 days); admin also every pending / failed run in the to-pay window. */
  runs: ReadonlyArray<PayrollRunWithUser>;
  /** Open candidates in recruitment scope (recruiter: own and unowned; leader: own; admin: all). */
  candidates: ReadonlyArray<CandidateWithMeta>;
  /** Interviews within ±2 days in recruitment scope (interviewer or candidate owner; admin: all). */
  interviews: ReadonlyArray<AttentionInterview>;
  /** Rep / leader only: how often the caller usually logs on their team's event days; null when unknown. */
  attendance?: AttentionAttendance | null;
}

// ───────────────────────────── formatting (en-GB) ─────────────────────────────

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const gbpWhole = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const gbpPence = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "£24,540" for whole pounds, "£412.50" otherwise. */
function money(n: number): string {
  const v = Math.round(n * 100) / 100;
  return (Number.isInteger(v) ? gbpWhole : gbpPence).format(v === 0 ? 0 : v);
}

/** "Thu 15 Oct" */
function shortDate(iso: string): string {
  return `${DOW_SHORT[dayOfWeek(iso)]} ${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** "23 Oct" */
function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** "w/c 5 Oct" */
function weekLabel(monday: string): string {
  return `w/c ${Number(monday.slice(8, 10))} ${MONTHS[Number(monday.slice(5, 7)) - 1]}`;
}

const LONDON_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Europe/London wall clock of an instant: { date: 'YYYY-MM-DD', time: 'HH:MM' }. */
function londonWallClock(ms: number): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of LONDON_PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** "Tue 10:00" (or "10:00" when it is today, "tomorrow 10:00" for tomorrow). */
function interviewWhen(ms: number, today: string, relative = false): string {
  const { date, time } = londonWallClock(ms);
  if (relative && date === today) return `today ${time}`;
  if (relative && date === addDays(today, 1)) return `tomorrow ${time}`;
  return `${DOW_SHORT[dayOfWeek(date)]} ${time}`;
}

/** "Jordan", "Jordan and Aisha", "Jordan, Aisha and Sam", "Jordan, Aisha, Sam and 2 more". */
function nameList(names: string[], max: number): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const eventLabel = (e: Pick<SalesEventWithMeta, 'campaignCode' | 'venue'>) => `${e.campaignCode} — ${e.venue}`;

/** Minutes from a naive wall-clock moment (date + HH:MM) to another; DST is ignored (both are London wall time). */
function minutesBetween(fromDate: string, fromHHMM: string, toDate: string, toHHMM: string): number {
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return daysBetween(fromDate, toDate) * 1440 + mins(toHHMM) - mins(fromHHMM);
}

/** Minutes since the event's end time (negative while it is still running). */
function minutesSinceEnd(e: Pick<SalesEventWithMeta, 'date' | 'endTime'>, now: AttentionNow): number {
  return minutesBetween(e.date, e.endTime, now.today, now.nowHHMM);
}

/** Completed, or scheduled / live with its end time passed by the clock. Cancelled events are never over. */
function isOver(e: SalesEventWithMeta, now: AttentionNow): boolean {
  if (e.status === 'cancelled') return false;
  if (e.status === 'completed') return true;
  return minutesSinceEnd(e, now) >= 0;
}

/** Live by the clock: started, not ended, not cancelled or completed. */
function isRunning(e: SalesEventWithMeta, now: AttentionNow): boolean {
  if (e.status === 'cancelled' || e.status === 'completed' || e.date !== now.today) return false;
  return e.startTime <= now.nowHHMM && now.nowHHMM < e.endTime;
}

/** A date-only follow-up is overdue the day after; a timestamp once it has passed (business date for date-only). */
function followUpOverdue(nextActionAt: string | null, now: AttentionNow): boolean {
  if (!nextActionAt) return false;
  if (isValidISODate(nextActionAt)) return now.today > nextActionAt;
  return isOverdue(nextActionAt, now.nowISO);
}

const INTERVIEW_LABELS: Record<Interview['type'], string> = {
  phone: 'phone interview',
  first: 'first interview',
  observation: 'observation day',
  final: 'final interview',
};

const TERMINAL = new Set<CandidateStage>(['hired', 'rejected', 'withdrawn']);

const SEVERITY_RANK: Record<AttentionSeverity, number> = { danger: 0, warning: 1, info: 2 };

/** Sort danger → warning → info, then newest `at` first (items without `at` last), then key. */
export function sortAttentionItems(items: ReadonlyArray<AttentionItem>): AttentionItem[] {
  return [...items].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s) return s;
    const at = (b.at ?? '').localeCompare(a.at ?? '');
    if (at) return at;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** The to-pay window GET /finance/payroll uses by default: week_start between mondayOf(today) − 12 weeks and today. */
export function attentionPayrollWindow(today: string): { from: string; to: string } {
  return { from: addDays(startOfWeekISO(today), -7 * ATTENTION_RULES.payrollWindowWeeks), to: today };
}

/** True when the attendance history says the caller usually works their team's event days. */
export function attentionUsuallyAttends(a: AttentionAttendance | null | undefined): boolean {
  if (!a || a.teamDays < ATTENTION_RULES.usualAttendanceMinDays) return false;
  return a.workedDays / a.teamDays >= ATTENTION_RULES.usualAttendanceShare;
}

// ───────────────────────────── the rules ─────────────────────────────

type Member = AttentionInput['members'][number];

function ownGaugeItems(input: AttentionInput, now: AttentionNow, out: AttentionItem[]): void {
  const { me } = input;
  if ((me.role !== 'rep' && me.role !== 'leader') || me.teamId === null) return;
  const myDates = new Set(input.entries.filter((g) => g.userId === me.id).map((g) => g.date));
  const myStart = me.startDate ?? input.members.find((m) => m.id === me.id)?.startDate ?? null;
  // a week whose run has been paid cannot be logged any more (the server answers 409): never ask for it
  const paidWeeks = new Set(input.runs.filter((r) => r.userId === me.id && (r.status === 'paid' || r.status === 'late')).map((r) => r.weekStart));
  const firm = attentionUsuallyAttends(input.attendance);
  const base = input.plan ? estimateWeekPay(input.plan, { daysWorked: 1, sales: 0, teamSales: 0 }).basePay : 0;
  const withCommission = (input.plan?.commissionPerSale ?? 0) > 0;
  const from = addDays(now.today, -ATTENTION_RULES.ownGapDays);
  // one item per unlogged DATE: a day pays one base however many team events ran on it, so two events on the same
  // day must not each claim "that day's £60". The item is keyed on the day's first event (start time, then id) and
  // names the others.
  const byDate = new Map<string, SalesEventWithMeta[]>();
  for (const e of input.events) {
    if (e.teamId !== me.teamId || e.date < from || e.date > now.today || !isOver(e, now)) continue;
    if (myDates.has(e.date) || (myStart !== null && myStart > e.date) || paidWeeks.has(startOfWeekISO(e.date))) continue;
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }
  for (const list of byDate.values()) {
    const [e, ...rest] = list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id - b.id) as [SalesEventWithMeta, ...SalesEventWithMeta[]];
    const day = e.date === now.today ? 'Today' : DOW_LONG[dayOfWeek(e.date)]!;
    const pay = `that day’s ${money(base)} base${withCommission ? ' plus commission' : ''}`;
    // name the payday: on a Thursday "Friday's pay" would read as tomorrow, but the week is paid the Friday after it ends
    const friday = `Friday’s pay (${dayMonth(paydayForWeek(startOfWeekISO(e.date)))})`;
    // "If you worked it", or with more events that day "If you worked it or Volt — MediaCity" / "it, A or B"
    const labels = rest.map(eventLabel);
    const orOthers = labels.length > 1 ? `, ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels.length ? ` or ${labels[0]}` : '';
    const ifWorked = `If you worked it${orOthers}`;
    let body: string;
    if (base > 0) {
      body = firm
        ? `${day} not logged yet: ${pay} is missing from ${friday}. Log it before the week is paid.`
        : `${ifWorked}: ${pay} is not in ${friday} until it is logged.`;
    } else {
      body = firm ? `${day} is not logged yet. Log it before the week is paid.` : `${ifWorked}, log it so the day counts.`;
    }
    if (firm && labels.length) body += ` Your team also ran ${nameList(labels, 2)} that day.`;
    out.push({
      key: `gauges:event:${e.id}:user:${me.id}`,
      kind: 'gauges',
      severity: 'warning',
      title: `Log your gauges for ${eventLabel(e)} (${shortDate(e.date)})`,
      body,
      href: `/gauges?log=1&eventId=${e.id}`,
      actionLabel: 'Log gauges',
      at: `${e.date}T${e.endTime}`,
    });
  }
}

function tomorrowItems(input: AttentionInput, now: AttentionNow, out: AttentionItem[]): void {
  const { me } = input;
  if ((me.role !== 'rep' && me.role !== 'leader') || me.teamId === null) return;
  const tomorrow = addDays(now.today, 1);
  for (const e of input.events) {
    if (e.teamId !== me.teamId || e.date !== tomorrow || e.status === 'cancelled') continue;
    const notes = e.notes ? ` · ${truncate(e.notes, ATTENTION_RULES.notesMax)}` : '';
    out.push({
      key: `events:tomorrow:${e.id}`,
      kind: 'events',
      severity: 'info',
      title: `Tomorrow: ${eventLabel(e)} at ${e.startTime}`,
      body: `${e.city} · ${e.startTime}–${e.endTime}${notes}`, // the venue is already in the title
      href: `/events/${e.id}`,
      actionLabel: 'View event',
      at: `${e.date}T${e.startTime}`,
    });
  }
}

function payItems(input: AttentionInput, now: AttentionNow, out: AttentionItem[]): void {
  const { me } = input;
  const tomorrow = addDays(now.today, 1);
  const paidSince = addDays(now.today, -ATTENTION_RULES.paidRecentDays);
  // Runs to pay (and the admin's payroll:to-pay item) only cover the 12-week window: only claim the office sees a run
  // that is in it, and ask about an older one
  const officeFrom = attentionPayrollWindow(now.today).from;
  for (const r of input.runs) {
    if (r.userId !== me.id) continue;
    const week = weekLabel(r.weekStart);
    const unpaid = r.status === 'pending' || r.status === 'failed';
    if (unpaid && now.today > r.dueDate) {
      const days = daysBetween(r.dueDate, now.today);
      out.push({
        key: `pay:overdue:${r.id}`,
        kind: 'pay',
        severity: 'danger',
        title: `Your pay for ${week} is ${plural(days, 'day')} overdue`,
        body: `${money(r.gross)} (${r.reference}) was due ${shortDate(r.dueDate)}.${
          me.role === 'admin' ? '' : r.weekStart >= officeFrom ? ' The office sees this too.' : ' It is older than the 12 weeks the office’s pay list shows, so please mention it to them.'
        }`,
        href: '/finance?tab=me',
        actionLabel: 'View my pay',
        at: r.dueDate,
      });
    } else if (unpaid && r.dueDate === tomorrow) {
      out.push({
        key: `pay:due-tomorrow:${r.id}`,
        kind: 'pay',
        severity: 'info',
        title: `Payday tomorrow: ${money(r.gross)}`,
        body: `Your pay for ${week} (${r.reference}) is due ${shortDate(r.dueDate)}.`,
        href: '/finance?tab=me',
        actionLabel: 'View my pay',
        at: r.dueDate,
      });
    } else if ((r.status === 'paid' || r.status === 'late') && r.paidDate && r.paidDate.slice(0, 10) >= paidSince && r.paidDate.slice(0, 10) <= now.today) {
      out.push({
        key: `pay:paid:${r.id}`,
        kind: 'pay',
        severity: 'info',
        title: `You’ve been paid ${money(r.gross)} for ${week}`,
        body: `Paid ${shortDate(r.paidDate.slice(0, 10))} · ${r.reference}`,
        href: '/finance?tab=me',
        actionLabel: 'View my pay',
        at: r.paidDate,
      });
    }
  }
}

/** Leader: own team only. Admin: every team. */
function teamScope(input: AttentionInput): ((teamId: number | null) => boolean) | null {
  const { me } = input;
  if (me.role === 'admin') return () => true;
  if (me.role === 'leader' && me.teamId !== null) return (teamId) => teamId === me.teamId;
  return null;
}

function teamEventItems(input: AttentionInput, now: AttentionNow, out: AttentionItem[]): void {
  const inScope = teamScope(input);
  if (!inScope) return;
  const { me } = input;
  const rowsOn = new Set(input.entries.map((g) => `${g.userId}|${g.date}`));
  const rowsPerEvent = new Map<number, number>();
  for (const g of input.entries) rowsPerEvent.set(g.eventId, (rowsPerEvent.get(g.eventId) ?? 0) + 1);
  const emptyFrom = addDays(now.today, -ATTENTION_RULES.emptyDays);
  const byName = (a: Member, b: Member) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName) || a.id - b.id;

  for (const e of input.events) {
    if (!inScope(e.teamId) || e.status === 'cancelled') continue;
    const hasRows = e.repCount > 0 || (rowsPerEvent.get(e.id) ?? 0) > 0;
    const since = minutesSinceEnd(e, now);

    // gauges:gap — ended 2 h … 48 h ago, someone logged, active members who had started have no row that day.
    // The count covers the whole team (so a leader and the admin read the same "1 of 7"); the viewer is never
    // chased by name (they have their own gauges:event item) and a gap that is only the viewer is no gap item.
    if (isOver(e, now) && hasRows && since >= ATTENTION_RULES.gapMinMinutes && since <= ATTENTION_RULES.gapMaxMinutes) {
      const expected = input.members
        .filter((m) => m.teamId === e.teamId && m.status === 'active' && (m.role === 'rep' || m.role === 'leader') && m.startDate <= e.date)
        .sort(byName);
      const missing = expected.filter((m) => !rowsOn.has(`${m.id}|${e.date}`));
      const others = missing.filter((m) => m.id !== me.id);
      const meMissing = others.length < missing.length;
      if (others.length) {
        const one = others.length === 1 ? others[0]! : null;
        const names = nameList([...(meMissing ? ['you'] : []), ...others.map((m) => m.firstName)], ATTENTION_RULES.gapNames);
        out.push({
          key: `gauges:gap:${e.id}`,
          kind: 'gauges',
          severity: 'warning',
          title: `${missing.length} of ${expected.length} ${missing.length === 1 ? 'has' : 'have'} not logged ${eventLabel(e)}`,
          body:
            one && !meMissing
              ? `${one.firstName} has no gauges for ${shortDate(e.date)} yet: a quick message usually sorts it.`
              : `Still to log for ${shortDate(e.date)}: ${names}. A quick message to the team usually sorts it.`,
          href: one ? `/gauges?log=1&eventId=${e.id}&userId=${one.id}` : `/events/${e.id}`,
          actionLabel: one ? `Log for ${one.firstName}` : 'View event',
          at: `${e.date}T${e.endTime}`,
          count: missing.length, // a gap that grows is new again on the client (lib/attentionSeen)
        });
      }
    }

    // events:empty — over (≥ 2 h ago or on an earlier day) in the last 2 days with no rows at all
    if (isOver(e, now) && !hasRows && e.date >= emptyFrom && e.date <= now.today && (e.date < now.today || since >= ATTENTION_RULES.gapMinMinutes)) {
      out.push({
        key: `events:empty:${e.id}`,
        kind: 'events',
        severity: 'warning',
        title: `No gauges for ${eventLabel(e)} (${shortDate(e.date)})`,
        body: `${e.teamName} has nothing logged for it: did it run? Log it or mark it cancelled.`,
        href: `/events/${e.id}`,
        actionLabel: 'View event',
        at: `${e.date}T${e.endTime}`,
      });
    }

    // events:behind — live after 13:00 with sales under half the target
    if (isRunning(e, now) && now.nowHHMM >= ATTENTION_RULES.behindFrom && e.targetSales > 0 && e.totals.sales < ATTENTION_RULES.behindShare * e.targetSales) {
      const left = minutesBetween(now.today, now.nowHHMM, e.date, e.endTime);
      const h = Math.floor(left / 60);
      const m = left % 60;
      const remaining = h > 0 ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
      out.push({
        key: `events:behind:${e.id}`,
        kind: 'events',
        severity: 'info',
        title: `${eventLabel(e)} is behind target`,
        body: `${e.totals.sales} of ${e.targetSales} sales so far with ${remaining} to go. More stops in that time is the lever.`,
        href: `/events/${e.id}`,
        actionLabel: 'View event',
        at: `${e.date}T${e.startTime}`,
      });
    }
  }

  // gauges:odd — rows from the last 3 days that look mistyped
  const members = new Map(input.members.map((m) => [m.id, m]));
  const oddFrom = addDays(now.today, -ATTENTION_RULES.oddDays);
  const teamOf = new Map(input.events.map((e) => [e.id, e.teamId]));
  for (const g of input.entries) {
    if (g.date < oddFrom || g.date > now.today) continue;
    const who = members.get(g.userId);
    const mine = g.userId === me.id;
    if (!who && !mine) continue;
    if (!inScope(who?.teamId ?? teamOf.get(g.eventId) ?? null) && !mine) continue;
    const noTable = g.stops >= ATTENTION_RULES.oddStopsNoTable && g.table === 0;
    const highConversion = g.stops >= ATTENTION_RULES.oddStopsHighConversion && g.sales / g.stops > ATTENTION_RULES.oddConversion;
    if (!noTable && !highConversion) continue;
    const whose = mine ? 'your' : `${who!.firstName}’s`;
    const pct = ((g.sales / g.stops) * 100).toFixed(1);
    out.push({
      key: `gauges:odd:${g.id}`,
      kind: 'gauges',
      severity: 'info',
      title: `Check ${whose} gauges for ${shortDate(g.date)}`,
      body: noTable
        ? `${g.stops} stops with nobody at the table looks unusual. Worth a quick look that each number is in the right box.`
        : `${g.sales} sales from ${g.stops} stops (${pct}%) is unusually high. Worth a quick look that each number is in the right box.`,
      href: `/gauges?log=1&eventId=${g.eventId}&userId=${g.userId}`,
      actionLabel: 'Check the numbers',
      at: g.submittedAt,
    });
  }
}

function recruitmentItems(input: AttentionInput, now: AttentionNow, out: AttentionItem[]): void {
  const { me } = input;
  if (me.role === 'rep') return;
  const nowMs = Date.parse(now.nowISO);

  // recruitment:overdue — one summary item
  const overdue = input.candidates
    .filter((c) => !TERMINAL.has(c.stage) && followUpOverdue(c.nextActionAt, now))
    .sort((a, b) => (a.nextActionAt ?? '').localeCompare(b.nextActionAt ?? '') || a.lastName.localeCompare(b.lastName) || a.id - b.id);
  if (overdue.length) {
    const names = nameList(overdue.map((c) => `${c.firstName} ${c.lastName}`), ATTENTION_RULES.overdueNames);
    out.push({
      key: 'recruitment:overdue',
      kind: 'recruitment',
      severity: 'warning',
      title: overdue.length === 1 ? '1 recruitment follow-up is overdue' : `${overdue.length} recruitment follow-ups are overdue`,
      body: `${names} ${overdue.length === 1 ? 'is' : 'are'} waiting on a next step. Book it or move them on.`,
      href: '/recruitment',
      actionLabel: 'Open recruitment',
      at: overdue[overdue.length - 1]!.nextActionAt ?? undefined,
      count: overdue.length,
    });
  }

  const involved = (i: AttentionInterview) => me.role === 'admin' || i.interviewerId === me.id || i.candidateOwnerId === me.id;
  const mine = (i: AttentionInterview) => i.interviewerId === me.id || (i.interviewerId === null && i.candidateOwnerId === me.id);
  const open = input.interviews.filter((i) => i.outcome === 'pending' && !TERMINAL.has(i.candidateStage) && Number.isFinite(Date.parse(i.scheduledAt)));

  // recruitment:interview — pending ≥ 2 h after its start
  for (const i of open) {
    const t = Date.parse(i.scheduledAt);
    if (!involved(i) || nowMs - t < ATTENTION_RULES.interviewOutcomeAfterMinutes * 60_000) continue;
    out.push({
      key: `recruitment:interview:${i.id}`,
      kind: 'recruitment',
      severity: 'warning',
      title: `Record the outcome of ${i.candidateName}’s ${INTERVIEW_LABELS[i.type]} (${interviewWhen(t, now.today)})`,
      body: `Passed, failed or no-show: recording it lets ${i.candidateFirstName}’s next step be booked.`,
      href: `/recruitment/${i.candidateId}`,
      actionLabel: 'Record outcome',
      at: i.scheduledAt,
    });
  }

  // recruitment:today — my interviews in the next 24 h, one summary item
  const soon = open
    .filter((i) => mine(i))
    .map((i) => ({ i, t: Date.parse(i.scheduledAt) }))
    .filter(({ t }) => t > nowMs && t - nowMs <= ATTENTION_RULES.interviewSoonMinutes * 60_000)
    .sort((a, b) => a.t - b.t || a.i.id - b.i.id);
  if (soon.length) {
    const first = soon[0]!;
    const parts = soon.map(({ i, t }) => `${i.candidateName} (${INTERVIEW_LABELS[i.type]}, ${interviewWhen(t, now.today, true)})`);
    out.push({
      key: 'recruitment:today',
      kind: 'recruitment',
      severity: 'info',
      title: soon.length === 1 ? '1 interview in the next 24 hours' : `${soon.length} interviews in the next 24 hours`,
      body: nameList(parts, ATTENTION_RULES.soonNames),
      href: soon.length === 1 ? `/recruitment/${first.i.candidateId}` : '/recruitment',
      actionLabel: soon.length === 1 ? 'View candidate' : 'Open recruitment',
      at: first.i.scheduledAt,
      count: soon.length,
    });
  }
}

function adminItems(input: AttentionInput, now: AttentionNow, out: AttentionItem[]): void {
  const { me } = input;
  if (me.role !== 'admin') return;
  const { from, to } = attentionPayrollWindow(now.today);
  const toPay = input.runs.filter((r) => (r.status === 'pending' || r.status === 'failed') && r.weekStart >= from && r.weekStart <= to);
  if (toPay.length) {
    const total = toPay.reduce((a, r) => a + r.gross, 0);
    const failed = toPay.filter((r) => r.status === 'failed').length;
    const overdue = toPay.filter((r) => now.today > r.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const next = [...toPay].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]!;
    out.push({
      key: 'payroll:to-pay',
      kind: 'payroll',
      severity: overdue.length ? 'danger' : 'warning',
      title: `${plural(toPay.length, 'run')} to pay · ${money(total)}${failed ? ` · ${plural(failed, 'failed transfer')}` : ''}`,
      body:
        overdue.length === 1
          ? `1 is overdue: it was due ${shortDate(overdue[0]!.dueDate)}. Paying it first is the lever.`
          : overdue.length > 1
            ? `${overdue.length} are overdue: the oldest was due ${shortDate(overdue[0]!.dueDate)}. Paying those first is the lever.`
            : `The next ${toPay.filter((r) => r.dueDate === next.dueDate).length === 1 ? 'one is' : 'ones are'} due ${shortDate(next.dueDate)}.`,
      href: '/finance?tab=company#runs',
      actionLabel: 'Open Runs to pay',
      at: next.dueDate,
      count: toPay.length,
    });
    const dueToday = toPay.filter((r) => r.dueDate === now.today);
    if (dayOfWeek(now.today) === 5 && dueToday.length) {
      out.push({
        key: `payroll:due-today:${now.today}`,
        kind: 'payroll',
        severity: 'warning',
        title: `Payday today: ${plural(dueToday.length, 'run')} due · ${money(dueToday.reduce((a, r) => a + r.gross, 0))}`,
        body: 'Mark each run paid once its transfer has gone, so nobody sees their pay as late.',
        href: '/finance?tab=company#runs',
        actionLabel: 'Open Runs to pay',
        at: now.today,
      });
    }
  }
  if (!me.twoFactorEnabled) {
    out.push({
      key: 'security:2fa',
      kind: 'security',
      severity: 'info',
      title: 'Turn on two-step verification',
      body: 'Your account can pay wages and see everyone’s pay. A code from an authenticator app keeps it yours.',
      href: '/settings',
      actionLabel: 'Open settings',
    });
  }
}

export function attentionItems(input: AttentionInput, now: AttentionNow): AttentionItem[] {
  const out: AttentionItem[] = [];
  ownGaugeItems(input, now, out);
  tomorrowItems(input, now, out);
  payItems(input, now, out);
  teamEventItems(input, now, out);
  recruitmentItems(input, now, out);
  adminItems(input, now, out);
  // one item per key (a defensive guard: the rules never emit a key twice for the same thing)
  const seen = new Set<string>();
  const unique = out.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  return sortAttentionItems(unique).slice(0, ATTENTION_MAX_ITEMS);
}
