/**
 * Deterministic demo data for Linear Hub: 26 weeks of history up to the real current date plus three
 * weeks of scheduled events. Run directly (`npm run seed -w server`) to delete and rebuild the DB file.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARK_RATIOS,
  calculatePayroll,
  paydayForWeek,
  validateGaugeFunnel,
  type CandidateSource,
  type CandidateStage,
  type EventStatus,
  type EventType,
  type GaugeTotals,
  type PayPlan,
  type PayrollStatus,
  type Position,
  type Role,
  type UserStatus,
} from '@lm/shared';
import { openDb, run, transaction, type Db } from './connection.ts';
import { createSchema } from './schema.ts';
import { Rng } from '../lib/prng.ts';
import { RECRUITER_HIRES_SQL } from '../lib/pay.ts';
import * as D from '../lib/dates.ts';
import * as S from './seed-data.ts';

export const DEFAULT_DB_PATH = path.resolve(import.meta.dirname, '../../data/linear.sqlite');

export interface SeedStats {
  teams: number;
  users: number;
  campaigns: number;
  events: number;
  gauges: number;
  payrollRuns: number;
  expenses: number;
  candidates: number;
  stageChanges: number;
  interviews: number;
  announcements: number;
}

interface SeededUser {
  id: number;
  employeeId: string;
  firstName: string;
  lastName: string;
  role: Role;
  position: Position;
  teamId: number | null;
  payPlanId: number;
  startDate: string;
  status: UserStatus;
  /** First date they no longer attend (left / on leave), or null. */
  stoppedOn: string | null;
  skill: number;
  skillEnd: number;
  attendance: number;
}

interface SeededEvent {
  id: number;
  teamId: number;
  campaignId: number;
  type: EventType;
  date: string;
  startTime: string;
  endTime: string;
  status: EventStatus;
}

interface WeekAgg {
  days: Set<string>;
  sales: number;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const ts = (date: string, hour: number, minute = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString();
const addMs = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;

export function seed(db: Db, today: string = D.todayISO()): SeedStats {
  const rng = new Rng(20240227);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const stats: SeedStats = {
    teams: 0, users: 0, campaigns: 0, events: 0, gauges: 0, payrollRuns: 0, expenses: 0,
    candidates: 0, stageChanges: 0, interviews: 0, announcements: 0,
  };

  const thisMonday = D.mondayOf(today);
  const firstMonday = D.addDays(thisMonday, -26 * 7);
  const lastEventDate = D.addDays(today, 21);
  const weekIndex = (date: string) => Math.floor(D.diffDays(firstMonday, date) / 7);

  transaction(db, () => {
    // ── Teams ────────────────────────────────────────────────────────────────
    const teamIds = new Map<string, number>();
    for (const t of S.TEAMS) {
      const r = run(db, `INSERT INTO teams (name, leader_id, color) VALUES (?, NULL, ?)`, [t.name, t.color]);
      teamIds.set(t.name, r.lastInsertRowid);
    }
    stats.teams = teamIds.size;

    // ── Pay plans ────────────────────────────────────────────────────────────
    const plans = new Map<Position, PayPlan>();
    for (const p of S.PAY_PLANS) {
      const r = run(
        db,
        `INSERT INTO pay_plans (name, position, base_per_day, commission_per_sale, bonus_threshold, bonus_amount, override_per_team_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.name, p.position, p.basePerDay, p.commissionPerSale, p.bonusThreshold, p.bonusAmount, p.overridePerTeamSale],
      );
      plans.set(p.position, { id: r.lastInsertRowid, ...p });
    }

    // ── Campaigns ────────────────────────────────────────────────────────────
    const campaigns = new Map<string, S.CampaignSeed & { id: number }>();
    for (const c of S.CAMPAIGNS) {
      const r = run(
        db,
        `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [c.name, c.code, c.sector, c.type, c.payoutPerSale, c.repCommissionPerSale, c.color, c.startDate, c.description],
      );
      campaigns.set(c.code, { ...c, id: r.lastInsertRowid });
    }
    stats.campaigns = campaigns.size;

    // ── Users ────────────────────────────────────────────────────────────────
    const users: SeededUser[] = [];
    const insertUser = db.prepare(
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const sortedSeeds = [...S.USERS].sort((a, b) => a.no - b.no);
    for (const u of sortedSeeds) {
      const startDate = typeof u.start === 'string' ? u.start : D.addDays(thisMonday, -u.start.weeksAgo * 7);
      const employeeId = `LM-${String(u.no).padStart(4, '0')}`;
      const email = u.email ?? `${u.firstName}.${u.lastName}@linear-mcr.co.uk`.toLowerCase();
      const teamId = u.team ? teamIds.get(u.team)! : null;
      const plan = plans.get(u.position)!;
      const phone = `07700 900${String(u.no).padStart(3, '0')}`;
      const color = S.AVATAR_PALETTE[(u.no - 1) % S.AVATAR_PALETTE.length]!;
      const r = insertUser.run(employeeId, email, u.firstName, u.lastName, u.role, u.position, teamId, plan.id, startDate, u.status, phone, color, u.city);
      const id = Number(r.lastInsertRowid);
      const stoppedOn = u.stoppedWeeksAgo ? D.addDays(thisMonday, -u.stoppedWeeksAgo * 7) : null;
      users.push({
        id, employeeId, firstName: u.firstName, lastName: u.lastName, role: u.role, position: u.position, teamId,
        payPlanId: plan.id, startDate, status: u.status, stoppedOn, skill: u.skill, skillEnd: u.skillEnd ?? u.skill,
        attendance: u.attendance ?? (u.role === 'leader' ? 0.92 : 0.85),
      });
      if (u.leadsTeam && teamId) run(db, `UPDATE teams SET leader_id = ? WHERE id = ?`, [id, teamId]);
    }
    stats.users = users.length;
    const byId = new Map(users.map((u) => [u.id, u]));
    const priya = users.find((u) => u.role === 'recruiter')!;
    const danil = users.find((u) => u.position === 'owner')!;
    const amelia = users.find((u) => u.employeeId === 'LM-0002')!;
    const jordan = users.find((u) => u.employeeId === 'LM-0010')!;
    const leaders = users.filter((u) => u.role === 'leader' && u.status === 'active');
    const teamLeaderOf = new Map<number, SeededUser>();
    for (const l of leaders) if (l.teamId && !teamLeaderOf.has(l.teamId)) teamLeaderOf.set(l.teamId, l);
    const teamSize = new Map<number, number>();
    for (const u of users) if (u.teamId) teamSize.set(u.teamId, (teamSize.get(u.teamId) ?? 0) + 1);

    const employedOn = (u: SeededUser, date: string) => u.startDate <= date && (!u.stoppedOn || date < u.stoppedOn);

    // ── Events ───────────────────────────────────────────────────────────────
    const events: SeededEvent[] = [];
    const insertEvent = db.prepare(
      `INSERT INTO events (campaign_id, team_id, name, venue, city, type, date, start_time, end_time, status, target_sales, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const northernLightsId = teamIds.get('Northern Lights')!;
    const nowHHMM = D.nowHHMM(new Date(nowMs)); // seed-time clock: today's events are only "live" once they have started
    const venueTaken = new Set<string>(); // `${date}|${venue}` — one crew per venue per day
    /** A start time at least 90 minutes ago (on the half hour, not before 07:00) so the demo accounts have live data today. */
    const demoStartTime = (): string => {
      const mins = Math.max(7 * 60, Math.floor((Number(nowHHMM.slice(0, 2)) * 60 + Number(nowHHMM.slice(3, 5)) - 90) / 30) * 30);
      return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    };
    for (let monday = firstMonday; monday <= lastEventDate; monday = D.addDays(monday, 7)) {
      for (const teamSeed of S.TEAMS) {
        const teamId = teamIds.get(teamSeed.name)!;
        for (let dow = 0; dow < 6; dow++) {
          const date = D.addDays(monday, dow);
          if (date > lastEventDate) break;
          const guaranteed = teamId === northernLightsId && monday === thisMonday && date <= today;
          if (!guaranteed && rng.chance(0.15)) continue;
          // Volt Energy is B2B at business parks: weekdays only
          const mix = dow === 5 ? teamSeed.campaignMix.filter(([c]) => c !== 'VLT') : teamSeed.campaignMix;
          const code = rng.weighted(mix);
          const campaign = campaigns.get(code)!;
          let type = rng.weighted(campaign.eventTypes);
          if (dow === 5 && code === 'CHN' && rng.chance(0.5)) type = 'event';
          let venue = rng.pick(S.VENUES[type]);
          for (let tries = 0; venueTaken.has(`${date}|${venue.venue}`) && tries < 8; tries++) venue = rng.pick(S.VENUES[type]);
          if (venueTaken.has(`${date}|${venue.venue}`) && !guaranteed) continue; // every venue busy that day: no event
          venueTaken.add(`${date}|${venue.venue}`);
          let [startTime, endTime] = rng.pick(S.EVENT_TIMES[type]);
          if (guaranteed && date === today && startTime > nowHHMM) startTime = demoStartTime();
          const size = teamSize.get(teamId) ?? 6;
          const targetSales = clamp(Math.round(rng.gauss(size * 2.2, 2)), 8, 20);
          const started = date < today || (date === today && startTime <= nowHHMM);
          let status: EventStatus = date < today ? 'completed' : started ? 'live' : 'scheduled';
          if (!guaranteed && rng.chance(0.03)) status = 'cancelled';
          const name = `${campaign.name} — ${venue.venue}`;
          const notes = rng.chance(0.15)
            ? rng.pick([
                'Meet at the main entrance 15 minutes before start.',
                'Bring spare tablets and chargers.',
                'Site manager: ask for the duty supervisor on arrival.',
                'Parking at the multi-storey; claim back on expenses.',
                'New patch — leaflets dropped last week.',
              ])
            : null;
          const r = insertEvent.run(campaign.id, teamId, name, venue.venue, venue.city, type, date, startTime, endTime, status, targetSales, notes);
          events.push({ id: Number(r.lastInsertRowid), teamId, campaignId: campaign.id, type, date, startTime, endTime, status });
        }
      }
    }
    stats.events = events.length;

    // ── Gauges ───────────────────────────────────────────────────────────────
    const insertGauge = db.prepare(
      `INSERT INTO gauge_entries (event_id, user_id, date, stops, table_count, presentations, closes, taps, sales, checked_in_at, notes, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const userWeek = new Map<string, WeekAgg>(); // `${userId}|${monday}`
    const eventSales = new Map<number, Map<number, number>>(); // eventId → userId → sales
    const salesByEventUser = (eventId: number) => {
      let m = eventSales.get(eventId);
      if (!m) eventSales.set(eventId, (m = new Map()));
      return m;
    };
    const attendedEvents = new Map<string, number[]>(); // `${userId}|${monday}` → eventIds (for no-team seniors)

    const skillAt = (u: SeededUser, date: string) => {
      const t = clamp(weekIndex(date) / 26, 0, 1);
      return u.skill + (u.skillEnd - u.skill) * t;
    };
    const baseStops: Record<Position, number> = {
      trainee: 50, field_rep: 68, team_leader: 75, crew_leader: 80, assistant_owner: 75, owner: 70, recruiter: 0,
    };

    function genGauges(u: SeededUser, ev: SeededEvent): GaugeTotals {
      const skill = skillAt(u, ev.date);
      let stops = rng.gauss(baseStops[u.position], 11);
      if (ev.type === 'b2b') stops *= 0.6;
      else if (ev.type === 'residential') stops *= 0.8;
      else if (ev.type === 'event') stops *= 1.15;
      if (ev.status === 'live') stops *= 0.55;
      stops = Math.round(clamp(stops, 12, 120));
      const f = Math.pow(skill, 0.45);
      const noise = () => rng.float(0.9, 1.1);
      const r1 = clamp(BENCHMARK_RATIOS.stopToTable * f * noise() * (ev.type === 'b2b' ? 1.25 : 1), 0.05, 0.9);
      const r2 = clamp(BENCHMARK_RATIOS.tableToPresentation * f * noise(), 0.1, 0.95);
      const r3 = clamp(BENCHMARK_RATIOS.presentationToClose * f * noise(), 0.1, 0.9);
      const r4 = clamp(BENCHMARK_RATIOS.closeToTap * f * noise(), 0.2, 0.95);
      const r5 = clamp(BENCHMARK_RATIOS.tapToSale * Math.pow(skill, 0.2) * noise(), 0.5, 0.98);
      const table = rng.binomial(stops, r1);
      const presentations = rng.binomial(table, r2);
      const closes = rng.binomial(presentations, r3);
      const taps = rng.binomial(closes, r4);
      const sales = rng.binomial(taps, r5);
      const totals = { stops, table, presentations, closes, taps, sales };
      const warnings = validateGaugeFunnel(totals);
      if (warnings.length) throw new Error(`seed produced an invalid funnel: ${warnings.join('; ')}`);
      return totals;
    }

    const seniorDays = new Set<string>(); // `${userId}|${date}` — the owner / assistant owner work one site a day
    for (const ev of events) {
      if (ev.status !== 'completed' && ev.status !== 'live') continue;
      const monday = D.mondayOf(ev.date);
      for (const u of users) {
        if (u.attendance === 0 || !employedOn(u, ev.date)) continue;
        let p = u.attendance;
        if (u.teamId !== null) {
          if (u.teamId !== ev.teamId) continue;
          if (monday === thisMonday && (u.id === jordan.id || u.id === amelia.id)) p = 1;
        } else if (seniorDays.has(`${u.id}|${ev.date}`)) continue;
        if (!rng.chance(p)) continue;
        if (u.teamId === null) seniorDays.add(`${u.id}|${ev.date}`);
        const g = genGauges(u, ev);
        if (u.id === jordan.id && monday === thisMonday && g.sales === 0) {
          // the demo rep never has a zero-sales day this week: lift the funnel to one sale, keeping it monotone
          g.sales = 1;
          g.taps = Math.max(g.taps, 1);
          g.closes = Math.max(g.closes, 1);
          g.presentations = Math.max(g.presentations, 1);
          g.table = Math.max(g.table, 1);
          g.stops = Math.max(g.stops, 1);
        }
        const [sh, sm] = ev.startTime.split(':').map(Number);
        const [eh, em] = ev.endTime.split(':').map(Number);
        const start = new Date(`${ev.date}T${ev.startTime}:00`).getTime();
        let checkedInAt: string | null = null;
        if (!rng.chance(0.08)) {
          // the demo leader and rep are punctual (always this week, 96% otherwise); everyone else is late 15% of the time
          const onTimeP = u.id === amelia.id || u.id === jordan.id ? (monday === thisMonday ? 1 : 0.96) : 0.85;
          const offsetMin = rng.chance(onTimeP) ? rng.float(-25, 4) : rng.float(6, 45);
          checkedInAt = D.toLocalISO(new Date(Math.min(start + offsetMin * 60_000, nowMs))); // never in the future
        }
        const submittedAt = ev.status === 'live'
          ? new Date(Math.min(nowMs, start + rng.float(2, 5) * HOUR)).toISOString()
          : addMs(ts(ev.date, eh!, em!), rng.float(10, 75) * 60_000);
        void sh; void sm;
        const notes = rng.chance(0.1) ? rng.pick(S.GAUGE_NOTES) : null;
        insertGauge.run(ev.id, u.id, ev.date, g.stops, g.table, g.presentations, g.closes, g.taps, g.sales, checkedInAt, notes, submittedAt);
        stats.gauges++;
        const key = `${u.id}|${monday}`;
        const agg = userWeek.get(key) ?? { days: new Set<string>(), sales: 0 };
        agg.days.add(ev.date);
        agg.sales += g.sales;
        userWeek.set(key, agg);
        salesByEventUser(ev.id).set(u.id, g.sales);
        if (u.teamId === null) {
          const list = attendedEvents.get(key) ?? [];
          list.push(ev.id);
          attendedEvents.set(key, list);
        }
      }
    }

    // ── Expenses ─────────────────────────────────────────────────────────────
    const insertExpense = db.prepare(
      `INSERT INTO expenses (date, category, amount, description, campaign_id, event_id) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const expense = (date: string, category: string, amount: number, description: string, campaignId: number | null = null, eventId: number | null = null) => {
      if (date < firstMonday || date > today) return;
      insertExpense.run(date, category, Math.round(amount * 100) / 100, description, campaignId, eventId);
      stats.expenses++;
    };
    const venueFee: Partial<Record<EventType, [number, number]>> = { retail: [150, 300], private_site: [60, 180], event: [120, 300] };
    for (const ev of events) {
      if (ev.status === 'cancelled' || ev.date > today) continue;
      const range = venueFee[ev.type];
      if (!range) continue;
      const row = db.prepare(`SELECT venue FROM events WHERE id = ?`).get(ev.id) as { venue: string };
      expense(ev.date, 'venue', Math.round(rng.float(range[0], range[1]) / 5) * 5, `Venue fee — ${row.venue}`, ev.campaignId, ev.id);
    }
    for (let monday = firstMonday; monday <= today; monday = D.addDays(monday, 7)) {
      for (const t of S.TEAMS) {
        const date = D.addDays(monday, 4) <= today ? D.addDays(monday, 4) : today;
        expense(date, 'travel', rng.float(40, 180), `Team travel & parking — ${t.name}`);
      }
    }
    for (let m = D.startOfMonth(firstMonday); m <= today; m = D.startOfMonth(D.addDays(D.addDays(m, 31), 0))) {
      expense(m, 'office', 2400, 'Office rent — 1 North Parade, Parsonage Gardens');
      expense(D.addDays(m, 3), 'office', 180, 'Utilities & office broadband');
      expense(D.addDays(m, 1), 'software', 149, 'Linear Hub hosting & CRM');
      expense(D.addDays(m, 1), 'software', 320, 'Mobile phones & data plans');
      expense(D.addDays(m, 5), 'software', 45, 'Design & marketing tools');
      expense(D.addDays(m, 2), 'recruitment', 299, 'Indeed sponsored job adverts');
      if (rng.chance(0.4)) expense(D.addDays(m, rng.int(6, 25)), 'recruitment', 750, 'Agency placement fee');
      if (rng.chance(0.5)) expense(D.addDays(m, rng.int(6, 25)), 'marketing', rng.float(150, 320), 'Social media advertising');
    }
    expense(D.addDays(firstMonday, 9), 'marketing', 480, 'Printed leaflets & pull-up banners');
    expense(D.addDays(firstMonday, 44), 'marketing', 420, 'Branded uniforms & lanyards');
    expense(D.addDays(firstMonday, 95), 'recruitment', 250, 'University careers fair stand');
    expense(D.addDays(firstMonday, 130), 'marketing', 600, 'Breast Cancer Now awareness-month materials', campaigns.get('BCN')!.id);
    expense(D.addDays(firstMonday, 60), 'other', 95, 'First-aid kits & PPE');
    expense(D.addDays(firstMonday, 150), 'other', 210, 'Team social — summer BBQ');

    // ── Recruitment ──────────────────────────────────────────────────────────
    interface Change { from: CandidateStage | null; to: CandidateStage; at: number }
    interface InterviewPlan { type: 'phone' | 'first' | 'observation' | 'final'; at: number; interviewerId: number | null; outcome: 'pending' | 'passed' | 'failed' | 'no_show'; notes: string | null }
    interface Plan {
      firstName: string; lastName: string; email: string; phone: string; city: string; source: CandidateSource;
      positionApplied: Position; ownerId: number; referredById: number | null; changes: Change[]; hiredUserId: number | null;
    }
    const insertCandidate = db.prepare(
      `INSERT INTO candidates (first_name, last_name, email, phone, city, source, stage, position_applied, applied_at, stage_updated_at, owner_id, referred_by_id, rating, notes, next_action, next_action_at, hired_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChange = db.prepare(
      `INSERT INTO stage_changes (candidate_id, from_stage, to_stage, changed_at, changed_by_id, note) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertInterview = db.prepare(
      `INSERT INTO interviews (candidate_id, type, scheduled_at, interviewer_id, outcome, notes) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const usedEmails = new Set<string>();
    const activeReps = users.filter((u) => u.status === 'active' && u.role !== 'recruiter');
    const nextStageOf: Partial<Record<CandidateStage, CandidateStage>> = {
      applied: 'screening', screening: 'interview', interview: 'observation', observation: 'offer', offer: 'hired',
    };
    const advanceP: Partial<Record<CandidateStage, number>> = { applied: 0.55, screening: 0.64, interview: 0.63, observation: 0.68 };
    const interviewTypeFor: Partial<Record<CandidateStage, InterviewPlan['type']>> = {
      screening: 'phone', interview: 'first', observation: 'observation', offer: 'final',
    };

    const randomPerson = () => {
      for (;;) {
        const firstName = rng.pick(S.CANDIDATE_FIRST_NAMES);
        const lastName = rng.pick(S.CANDIDATE_LAST_NAMES);
        const email = `${firstName}.${lastName.replace(/'/g, '')}${rng.int(1, 99)}@${rng.pick(S.EMAIL_DOMAINS)}`.toLowerCase();
        if (usedEmails.has(email)) continue;
        usedEmails.add(email);
        return { firstName, lastName, email };
      }
    };
    const pickSource = (): CandidateSource =>
      rng.weighted<CandidateSource>([
        ['indeed', 40], ['website', 15], ['referral', 15], ['linkedin', 12], ['university', 8], ['walk_in', 5], ['agency', 5],
      ]);
    const pickOwner = () => (rng.chance(0.75) ? priya.id : rng.pick(leaders).id);
    const stageDelay = () => (rng.chance(0.22) ? rng.int(10, 30) : rng.int(2, 9)) * DAY + rng.float(-4, 6) * HOUR;

    const plansToInsert: Plan[] = [];

    // Hires linked to users who started inside the window
    for (const u of users) {
      if (u.startDate < firstMonday || u.startDate > today) continue;
      const hiredAt = new Date(ts(D.addDays(u.startDate, -rng.int(3, 10)), rng.int(10, 16))).getTime();
      const offerAt = hiredAt - rng.int(1, 4) * DAY;
      const observationAt = offerAt - rng.int(2, 6) * DAY;
      const interviewAt = observationAt - rng.int(2, 7) * DAY;
      const screeningAt = interviewAt - rng.int(1, 5) * DAY;
      const appliedAt = screeningAt - rng.int(1, 6) * DAY;
      const source = pickSource();
      plansToInsert.push({
        firstName: u.firstName, lastName: u.lastName,
        email: `${u.firstName}.${u.lastName}${rng.int(1, 99)}@${rng.pick(S.EMAIL_DOMAINS)}`.toLowerCase(),
        phone: `07700 9${String(rng.int(0, 99999)).padStart(5, '0')}`, city: byId.get(u.id)!.startDate ? (S.USERS.find((s) => `LM-${String(s.no).padStart(4, '0')}` === u.employeeId)?.city ?? 'Manchester') : 'Manchester',
        source, positionApplied: u.position === 'trainee' ? 'trainee' : u.position,
        ownerId: u.teamId && rng.chance(0.3) ? (teamLeaderOf.get(u.teamId)?.id ?? priya.id) : priya.id,
        referredById: source === 'referral' ? rng.pick(activeReps).id : null,
        changes: [
          { from: null, to: 'applied', at: appliedAt },
          { from: 'applied', to: 'screening', at: screeningAt },
          { from: 'screening', to: 'interview', at: interviewAt },
          { from: 'interview', to: 'observation', at: observationAt },
          { from: 'observation', to: 'offer', at: offerAt },
          { from: 'offer', to: 'hired', at: hiredAt },
        ],
        hiredUserId: u.id,
      });
    }

    // Everyone else: 3–5 applications per week
    for (let monday = firstMonday; monday <= today; monday = D.addDays(monday, 7)) {
      const n = rng.pick([3, 3, 4, 4, 5]);
      for (let i = 0; i < n; i++) {
        const date = D.addDays(monday, rng.int(0, 5));
        if (date > today) continue;
        const appliedAt = new Date(ts(date, rng.int(8, 20), rng.int(0, 59))).getTime();
        const changes: Change[] = [{ from: null, to: 'applied', at: appliedAt }];
        let stage: CandidateStage = 'applied';
        let t = appliedAt;
        for (;;) {
          const next = t + stageDelay();
          if (next > nowMs) break;
          if (stage === 'offer') {
            const r = rng.next();
            if (r < 0.5) changes.push({ from: stage, to: 'withdrawn', at: next });
            else if (r < 0.65) changes.push({ from: stage, to: 'rejected', at: next });
            break;
          }
          if (rng.chance(advanceP[stage] ?? 0)) {
            const to: CandidateStage = nextStageOf[stage]!;
            changes.push({ from: stage, to, at: next });
            stage = to;
            t = next;
          } else {
            changes.push({ from: stage, to: rng.chance(0.7) ? 'rejected' : 'withdrawn', at: next });
            break;
          }
        }
        // nobody sits at Offer for more than three weeks: a stale offer is withdrawn or declined (a real hire needs a real user)
        if (stage === 'offer' && changes[changes.length - 1]!.to === 'offer' && nowMs - t > 21 * DAY) {
          changes.push({ from: 'offer', to: rng.chance(0.6) ? 'withdrawn' : 'rejected', at: t + rng.int(7, 20) * DAY + rng.int(0, 8) * HOUR });
        }
        const person = randomPerson();
        const source = pickSource();
        plansToInsert.push({
          ...person,
          phone: `07700 9${String(rng.int(0, 99999)).padStart(5, '0')}`,
          city: rng.pick(S.CANDIDATE_CITIES),
          source,
          positionApplied: rng.weighted<Position>([['trainee', 80], ['field_rep', 17], ['team_leader', 3]]),
          ownerId: pickOwner(),
          referredById: source === 'referral' ? rng.pick(activeReps).id : null,
          changes,
          hiredUserId: null,
        });
      }
    }

    plansToInsert.sort((a, b) => a.changes[0]!.at - b.changes[0]!.at);

    for (const p of plansToInsert) {
      const last = p.changes[p.changes.length - 1]!;
      const stage = last.to;
      const isTerminal = stage === 'hired' || stage === 'rejected' || stage === 'withdrawn';
      const reachedStages = new Set(p.changes.map((c) => c.to));
      let rating: number | null = null;
      if (stage === 'hired') rating = rng.int(4, 5);
      else if (reachedStages.has('observation') || reachedStages.has('offer')) rating = rng.int(3, 5);
      else if (reachedStages.has('interview')) rating = rng.int(2, 5);
      else if (reachedStages.has('screening') && stage === 'rejected' && rng.chance(0.4)) rating = rng.int(1, 2);
      const stageUpdatedAt = new Date(last.at).toISOString();
      const nextAction = isTerminal ? null : S.NEXT_ACTIONS[stage] ?? null;
      const nextActionAt = isTerminal ? null : new Date(last.at + rng.int(1, 5) * DAY + rng.int(0, 8) * HOUR).toISOString();
      const notes = rng.chance(0.35) ? rng.pick(S.CANDIDATE_NOTES) : null;
      const r = insertCandidate.run(
        p.firstName, p.lastName, p.email, p.phone, p.city, p.source, stage, p.positionApplied,
        new Date(p.changes[0]!.at).toISOString(), stageUpdatedAt, p.ownerId, p.referredById, rating, notes, nextAction, nextActionAt, p.hiredUserId,
      );
      const candidateId = Number(r.lastInsertRowid);
      stats.candidates++;

      for (let i = 0; i < p.changes.length; i++) {
        const c = p.changes[i]!;
        const changedBy = c.to === 'observation' ? rng.pick(leaders).id : p.ownerId;
        const noteOptions = S.STAGE_NOTES[c.to];
        const note = noteOptions && rng.chance(0.7) ? rng.pick(noteOptions) : null;
        insertChange.run(candidateId, c.from, c.to, new Date(c.at).toISOString(), c.to === 'applied' ? null : changedBy, note);
        stats.stageChanges++;

        const type = interviewTypeFor[c.to];
        if (!type) continue;
        if (type === 'final' && !rng.chance(0.4)) continue;
        const nextChange = p.changes[i + 1];
        const interviewer =
          type === 'phone' ? p.ownerId
          : type === 'first' ? (rng.chance(0.5) ? p.ownerId : rng.pick(leaders).id)
          : type === 'observation' ? rng.pick([...teamLeaderOf.values()]).id
          : rng.chance(0.6) ? danil.id : amelia.id;
        let at: number;
        let outcome: InterviewPlan['outcome'];
        if (nextChange) {
          at = c.at + (nextChange.at - c.at) * rng.float(0.3, 0.8);
          if (nextChange.to === 'rejected') outcome = rng.chance(0.15) ? 'no_show' : 'failed';
          else if (nextChange.to === 'withdrawn') outcome = rng.chance(0.5) ? 'no_show' : 'passed'; // never left "pending"
          else outcome = 'passed';
        } else if (nowMs - c.at < 10 * DAY && (nowMs - c.at < 4 * DAY || rng.chance(0.6))) {
          // open candidate who entered the stage recently: the stage interview is still to come
          at = nowMs + rng.int(1, 7) * DAY;
          outcome = 'pending';
        } else {
          at = c.at + rng.int(1, 3) * DAY;
          outcome = 'passed'; // "pending" is reserved for interviews that are still in the future
        }
        const d = new Date(at);
        // office hours, Monday to Friday
        d.setHours(rng.int(9, 16), rng.pick([0, 15, 30, 45]), 0, 0);
        if (d.getDay() === 0) d.setDate(d.getDate() + 1);
        else if (d.getDay() === 6) d.setDate(d.getDate() + 2);
        const interviewNotes = outcome === 'passed' ? rng.pick(S.STAGE_NOTES.interview!) : outcome === 'no_show' ? 'Did not attend; left voicemail.' : null;
        insertInterview.run(candidateId, type, d.toISOString(), interviewer, outcome, interviewNotes);
        stats.interviews++;
      }
    }

    // ── Payroll ──────────────────────────────────────────────────────────────
    const insertRun = db.prepare(
      `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const completedMondays: string[] = [];
    for (let monday = firstMonday; D.sundayOf(monday) < today; monday = D.addDays(monday, 7)) completedMondays.push(monday);
    const lastCompletedMonday = completedMondays[completedMondays.length - 1];
    // recruiters are paid a bonus on hires, so their weekly "sales" figure is the hires they closed (same rule as lib/pay.ts)
    const hiresInWeek = db.prepare(RECRUITER_HIRES_SQL);

    for (const monday of completedMondays) {
      const sunday = D.sundayOf(monday);
      const dueDate = paydayForWeek(monday); // Friday after the Mon–Sun pay week (shared rule)
      const { year, week } = D.isoWeek(monday);
      // team sales this week by team (for overrides)
      const teamWeekSales = new Map<number, number>();
      for (const u of users) {
        if (!u.teamId) continue;
        const agg = userWeek.get(`${u.id}|${monday}`);
        if (agg) teamWeekSales.set(u.teamId, (teamWeekSales.get(u.teamId) ?? 0) + agg.sales);
      }
      for (const u of users) {
        if (!(u.startDate <= sunday && (!u.stoppedOn || u.stoppedOn > monday))) continue;
        const plan = plans.get(u.position)!;
        const agg = userWeek.get(`${u.id}|${monday}`);
        let daysWorked = agg?.days.size ?? 0;
        let sales = agg?.sales ?? 0;
        if (u.role === 'recruiter') {
          // office-based: paid Mon–Fri; "sales" = hires closed this week (the recruiter plan's bonus counts hires)
          const firstDay = u.startDate > monday ? u.startDate : monday;
          daysWorked = Math.max(0, Math.min(5, D.diffDays(firstDay, D.addDays(monday, 4)) + 1));
          sales = Number((hiresInWeek.get(u.id, monday, sunday) as { n: number }).n);
        }
        let teamSales = 0;
        if (plan.overridePerTeamSale > 0) {
          if (u.teamId) teamSales = Math.max(0, (teamWeekSales.get(u.teamId) ?? 0) - sales);
          else {
            // owners without a team: override on the other reps' sales at the events they ran
            for (const evId of attendedEvents.get(`${u.id}|${monday}`) ?? []) {
              for (const [uid, s] of salesByEventUser(evId)) if (uid !== u.id) teamSales += s;
            }
          }
        }
        const deductions = rng.chance(0.08) ? rng.pick([12.5, 20, 35, 50]) : 0;
        const pay = calculatePayroll(plan, { daysWorked, sales, teamSales, deductions });
        if (pay.gross <= 0) continue;
        let status: PayrollStatus = 'pending';
        let paidDate: string | null = null;
        if (monday !== lastCompletedMonday && dueDate < today) {
          const r = rng.next();
          if (r < 0.88) {
            status = 'paid';
            paidDate = D.addDays(dueDate, -rng.int(0, 2));
          } else if (r < 0.97) {
            status = 'late';
            paidDate = D.addDays(dueDate, rng.int(1, 6));
            if (paidDate > today) paidDate = today;
          } else if (r < 0.98) {
            status = 'failed';
          } else {
            status = 'paid';
            paidDate = dueDate;
          }
        }
        const reference = `PAY-${year}${String(week).padStart(2, '0')}-${u.employeeId}`;
        insertRun.run(
          u.id, monday, sunday, daysWorked, sales, teamSales, pay.basePay, pay.commission, pay.bonus, pay.overrides, pay.deductions, pay.gross,
          dueDate, paidDate, status, reference,
        );
        stats.payrollRuns++;
      }
    }

    // ── Announcements ────────────────────────────────────────────────────────
    // Every name or number an announcement quotes is derived from the data generated above, so it is always true.
    const thomas = users.find((u) => u.employeeId === 'LM-0006')!;
    const monthEnd = D.addDays(D.startOfMonth(today), -1); // last day of the previous calendar month
    const monthStart = D.startOfMonth(monthEnd);
    const monthName = MONTH_NAMES[Number(monthStart.slice(5, 7)) - 1]!;
    const monthBoard = db
      .prepare(
        `SELECT u.first_name AS firstName, u.first_name || ' ' || u.last_name AS name, SUM(g.sales) AS sales, SUM(g.stops) AS stops
         FROM gauge_entries g JOIN users u ON u.id = g.user_id WHERE g.date BETWEEN ? AND ?
         GROUP BY u.id ORDER BY sales DESC, stops ASC, name ASC`,
      )
      .all(monthStart, monthEnd) as { firstName: string; name: string; sales: number; stops: number }[];
    const [top, runnerUp] = monthBoard;
    const bestConversion = monthBoard.filter((r) => r.stops >= 200).sort((a, b) => b.sales / b.stops - a.sales / a.stops)[0];
    const crewSales = monthBoard.reduce((acc, r) => acc + Number(r.sales), 0);
    const inPipeline = Number((db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE stage IN ('interview', 'observation')`).get() as { n: number }).n);

    const announcements: [string, string, number, number, boolean][] = [
      [
        'Breast Cancer Awareness Month — October push',
        'October is Breast Cancer Awareness Month and BCN have doubled their private-site allocation for us. Target is 500 new regular givers across the crew this month. Top three reps on BCN sales by 31 October take home a double bonus. Wear pink on Fridays.',
        danil.id, 14, true,
      ],
      [
        'FibreCity: new residential patches live in Sale & Altrincham',
        'FibreCity have switched on full-fibre in Sale Moor, Brooklands and Timperley. Leaflets dropped last week, so expect warm doors. Ancoats and Deansgate have the first fortnight; patch maps are in the shared drive.',
        users.find((u) => u.employeeId === 'LM-0004')!.id, 9, false,
      ],
      [
        'Observation days: bring a trainee candidate with you',
        `We have ${inPipeline} candidate${inPipeline === 1 ? '' : 's'} at interview or observation stage right now. If you are running a retail or private-site day next week, let me know and I will pair you with one. Observation feedback forms go back to me the same day please.`,
        priya.id, 5, false,
      ],
      [
        'Payday reminder — payroll runs Friday',
        'Gauges must be submitted by Sunday 8pm for the week to be included in Friday\'s payroll. Late submissions roll into the following week. Query your payslip via Finance → My pay.',
        danil.id, 2, false,
      ],
      [
        'Volt Energy B2B refresher — Thursday 9am, Parsonage Gardens',
        'Volt have updated their tariff sheet and the objection-handling script. 45-minute refresher in the office for everyone working VLT days this month. Coffee and pastries provided.',
        thomas.id, 1, false,
      ],
    ];
    if (top && runnerUp && bestConversion) {
      const pct = (Math.round((bestConversion.sales / bestConversion.stops) * 1000) / 10).toFixed(1);
      // posted the day after the month closed, or 12 days ago when the month ended longer ago than that
      const postedDaysAgo = Math.max(0, Math.min(12, D.diffDays(monthEnd, today) - 1));
      announcements.push([
        `${monthName} leaderboard — congratulations ${top.firstName} and ${runnerUp.firstName}`,
        `${top.name} topped the ${monthName} board with ${top.sales} sales and ${runnerUp.name} took second on ${runnerUp.sales}. ` +
          `Best conversion went to ${bestConversion.name} at ${pct}% (${bestConversion.sales} sales from ${bestConversion.stops} stops). ` +
          `The crew closed ${monthName} on ${crewSales} sales — well done everyone.`,
        amelia.id, postedDaysAgo, false,
      ]);
    }
    for (const [title, body, authorId, daysAgo, pinned] of announcements) {
      run(db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES (?, ?, ?, ?, ?)`, [
        title, body, authorId, new Date(nowMs - daysAgo * DAY - rng.int(0, 6) * HOUR).toISOString(), pinned,
      ]);
      stats.announcements++;
    }

    run(db, `INSERT INTO meta (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [nowIso]);
    run(db, `INSERT INTO meta (key, value) VALUES ('seed_today', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [today]);
  });

  return stats;
}

/** Delete the DB file (and WAL side files), recreate the schema and seed it. */
export function resetAndSeed(file: string): SeedStats {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(file + suffix)) rmSync(file + suffix);
  }
  const db = openDb(file);
  try {
    createSchema(db);
    return seed(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
  const started = performance.now();
  const stats = resetAndSeed(file);
  const ms = Math.round(performance.now() - started);
  console.log(`Seeded ${file} in ${ms}ms`);
  console.table(stats);
}
