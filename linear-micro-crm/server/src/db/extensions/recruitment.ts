/**
 * Release 1.3 — OWNED BY P7 recruitment-plus (laid down by r3-foundation: tables and the column are the contract).
 *
 *  - candidates.date_of_birth: YYYY-MM-DD or NULL (the profile shows the age and an "Under 18" warning).
 *  - interview_questions: the bank per interview type ('phone' | 'first' | 'observation' | 'final'), optionally per
 *    position, ordered (sort), active / inactive (Settings → Recruitment). The default set
 *    (lib/recruitmentPlus/defaults.ts; plain, lawful questions only) goes in once:
 *      · `upgrade`, on an existing database that already has people (meta `ext:recruitment:questions`), only while the
 *        bank is empty; a fresh install's upgrade runs before the seed on an empty users table and skips WITHOUT the
 *        flag, so the seed writes the set and sets the flag (a restart after a fresh seed changes nothing). The
 *        step is not in upgrade()'s list (a data step in this extension's own table; see upgradeDefaultQuestions);
 *      · `seed`, on a fresh demo database.
 *  - interview_answers: the questions AS ASKED (question_text copied when the sheet is first saved) with the
 *    interviewer's written answer and an optional 1–5 score; later edits to the bank never change a past interview.
 *  - interview_changes: bookings, interviewer reassignments, reschedules, changes of type and outcomes (field, from,
 *    to, who, when), written by P7's POST / PATCH /recruitment/interviews. "Who handled each stage" is
 *    stage_changes.changed_by_id (already recorded).
 *
 * The demo seed (fresh databases only; its own random stream, ctx.rng(7307)) writes the default bank, a date of birth
 * for most candidates (two open applicants are 17, so the "Under 18" warning shows), the change log of every seeded
 * interview (booked, some reassigned or rescheduled, each recorded outcome) and the sheets of most passed or failed
 * interviews of the last six weeks. On core tables it changes only candidates.date_of_birth (its own column).
 * Rules: ./types.ts.
 */
import { ageOn, draftSheetQuestions, type InterviewType, type Position } from '@lm/shared';
import { DEMO_ANSWERS } from '../../lib/recruitmentPlus/defaults.ts';
import { insertDefaultQuestions, listQuestions } from '../../lib/recruitmentPlus/store.ts';
import { addDays, nowISO } from '../../lib/dates.ts';
import type { Rng } from '../../lib/prng.ts';
import type { Db } from '../connection.ts';
import { addColumnIfMissing, metaFlag, setMetaFlag, type DbExtension, type SeedContext } from './types.ts';

export const QUESTIONS_FLAG = 'ext:recruitment:questions';

const SQL = `
CREATE TABLE IF NOT EXISTS interview_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_type TEXT NOT NULL,
  position TEXT,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_interview_questions_type ON interview_questions(interview_type, sort);

CREATE TABLE IF NOT EXISTS interview_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES interview_questions(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  answer TEXT NOT NULL DEFAULT '',
  score INTEGER,
  updated_at TEXT,
  updated_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_interview_answers_interview ON interview_answers(interview_id, sort);

CREATE TABLE IF NOT EXISTS interview_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  changed_by INTEGER,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_changes_interview ON interview_changes(interview_id, changed_at);
`;

/**
 * Once, on a database that already has people: the default question bank (only while the bank is empty). A data step
 * in a table of this extension's own, so it is not reported: the start-up line lists schema changes, and the 1.2
 * upgrade tests (pin, pitches) compare that list exactly. Returns how many questions went in (for the tests).
 */
export function upgradeDefaultQuestions(db: Db): number {
  if (metaFlag(db, QUESTIONS_FLAG)) return 0;
  // Fresh install: the seed (which runs next) writes the bank; try again on a later start otherwise.
  if (!db.prepare(`SELECT 1 FROM users LIMIT 1`).get()) return 0;
  const added = insertDefaultQuestions(db, nowISO());
  setMetaFlag(db, QUESTIONS_FLAG);
  return added;
}

// ───────────────────────────── the demo seed ─────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** `today`'s month and day `years` earlier (29 Feb → 28 Feb). */
function yearsBefore(today: string, years: number): string {
  const [y, m, d] = today.split('-');
  return `${Number(y) - years}-${m}-${m === '02' && d === '29' ? '28' : d}`;
}

/** A date of birth that makes someone exactly `age` on `today` (birthday somewhere in the last year). */
function birthdayFor(age: number, today: string, rng: Rng): string {
  return addDays(yearsBefore(today, age), -rng.int(0, 364));
}

function seedDatesOfBirth(db: Db, ctx: SeedContext, rng: Rng): void {
  const rows = db.prepare(`SELECT id, stage, applied_at AS appliedAt FROM candidates ORDER BY id`).all() as { id: number; stage: string; appliedAt: string }[];
  const update = db.prepare(`UPDATE candidates SET date_of_birth = ? WHERE id = ?`);
  // Two open applicants are 17 (one turns 18 in a few weeks), so the warning shows in the demo.
  const newestAt = (stage: string) => rows.filter((r) => r.stage === stage).sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))[0]?.id;
  const under = new Map<number, string>();
  const a = newestAt('applied');
  const s = newestAt('screening');
  if (a) under.set(a, birthdayFor(17, ctx.today, rng));
  if (s) under.set(s, addDays(yearsBefore(ctx.today, 18), rng.int(10, 40))); // turns 18 in 10–40 days
  for (const r of rows) {
    const forced = under.get(r.id);
    if (forced) {
      update.run(forced, r.id);
      continue;
    }
    if (rng.chance(0.12)) continue; // not recorded
    const band = rng.weighted<[number, number]>([[[18, 21], 50], [[22, 26], 30], [[27, 35], 15], [[36, 55], 5]]);
    const dob = birthdayFor(rng.int(band[0], band[1]), ctx.today, rng);
    update.run(dob, r.id);
  }
  // Every forced date really is under 18 on the demo's today (asserted in the seed test).
  for (const [, dob] of under) if ((ageOn(dob, ctx.today) ?? 18) >= 18) throw new Error(`demo date of birth ${dob} is not under 18`);
}

interface SeedInterview {
  id: number;
  candidateId: number;
  type: InterviewType;
  scheduledAt: string;
  interviewerId: number | null;
  outcome: string;
  ownerId: number | null;
  positionApplied: Position;
}

const STAGE_OF: Record<InterviewType, string> = { phone: 'screening', first: 'interview', observation: 'observation', final: 'offer' };

/** Back to a weekday (local time, like the core seed's interview times). */
function weekdayOnOrBefore(ms: number): number {
  const d = new Date(ms);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** Mon–Fri, 09:00–17:59 local (the core seed's interview slots are local times too). */
function inOffice(ms: number): boolean {
  const d = new Date(ms);
  return d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && d.getHours() < 18;
}

/** The next working morning's 09:00 after `ms` (the same morning when `ms` is before 09:00 on a weekday). */
function nextOfficeOpen(ms: number): number {
  const d = new Date(ms);
  if (d.getHours() >= 9) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The last office-hours minute at or before `ms` (17:59 of the working day before, when `ms` is out of hours). */
function lastOfficeMinute(ms: number): number {
  if (inOffice(ms)) return ms;
  const d = new Date(ms);
  if (d.getHours() < 9) d.setDate(d.getDate() - 1);
  d.setHours(17, 59, 0, 0);
  return weekdayOnOrBefore(d.getTime());
}

/**
 * An office-hours moment for a booking, a move or a reassignment made at about `ms`, inside [lo, hi] (lo: the stage
 * move or the booking it follows; hi: half an hour before the interview, and never after now). Out of hours it is
 * made the next working morning (09:00–10:29), or, when the interview comes first, late on the last working afternoon
 * before `hi`. Only when the window holds no office minute at all (a stage move at night with the interview first
 * thing next morning) does it stay out of hours.
 */
function officeTime(ms: number, lo: number, hi: number, rng: Rng): number {
  const t = Math.min(hi, Math.max(lo, ms));
  if (inOffice(t)) return t;
  const morning = nextOfficeOpen(t) + rng.int(0, 89) * MINUTE;
  if (morning <= hi) return morning;
  const open = nextOfficeOpen(t);
  if (open <= hi) return open + Math.round((Math.min(hi, open + 89 * MINUTE) - open) * rng.next());
  const late = lastOfficeMinute(hi) - rng.int(0, 120) * MINUTE;
  if (late >= lo && inOffice(late)) return late;
  const last = lastOfficeMinute(hi);
  return last >= lo ? last : t;
}

function seedInterviewChanges(db: Db, ctx: SeedContext, rng: Rng, interviews: SeedInterview[]): void {
  const nowMs = Date.parse(ctx.nowIso);
  const entries = new Map<number, { toStage: string; at: number; by: number | null }[]>();
  for (const s of db.prepare(`SELECT candidate_id AS candidateId, to_stage AS toStage, changed_at AS changedAt, changed_by_id AS by FROM stage_changes ORDER BY candidate_id, changed_at, id`).all() as {
    candidateId: number; toStage: string; changedAt: string; by: number | null;
  }[]) {
    const list = entries.get(s.candidateId) ?? [];
    list.push({ toStage: s.toStage, at: Date.parse(s.changedAt), by: s.by });
    entries.set(s.candidateId, list);
  }
  const pool = ctx.users.filter((u) => u.status === 'active' && (u.role === 'leader' || u.role === 'admin')).map((u) => u.id);
  const insert = db.prepare(`INSERT INTO interview_changes (interview_id, field, from_value, to_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const between = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rng.next());

  for (const iv of interviews) {
    const at = Date.parse(iv.scheduledAt);
    const entry = (entries.get(iv.candidateId) ?? []).filter((e) => e.toStage === STAGE_OF[iv.type] && e.at <= at).pop();
    const by = entry?.by ?? iv.ownerId;
    const bookedLatest = Math.min(at - 30 * MINUTE, nowMs);
    const bookedFrom = entry ? entry.at : at - 3 * DAY;
    const booked = officeTime(Math.min(bookedFrom + rng.int(5, 180) * MINUTE, bookedLatest), Math.min(bookedFrom, bookedLatest), bookedLatest, rng);

    // ~10%: first booked for an earlier slot (a weekday, an hour or two earlier), then moved to this one.
    let firstSlot = at;
    let movedAt: number | null = null;
    if (rng.chance(0.1)) {
      const earlier = weekdayOnOrBefore(at - rng.int(1, 3) * DAY - rng.pick([0, 1, 2]) * HOUR);
      const latest = Math.min(earlier - HOUR, nowMs);
      if (earlier > booked + 2 * HOUR && latest > booked + HOUR) {
        firstSlot = earlier;
        movedAt = officeTime(between(booked + HOUR, latest), booked + HOUR, latest, rng);
      }
    }
    insert.run(iv.id, 'booked', null, iso(firstSlot), by, iso(booked));
    if (movedAt !== null) insert.run(iv.id, 'scheduled_at', iso(firstSlot), iv.scheduledAt, by, iso(movedAt));

    // ~12% of interviews with an interviewer (not phone screens): first given to another leader, then reassigned.
    if (iv.interviewerId !== null && iv.type !== 'phone' && rng.chance(0.12)) {
      const others = pool.filter((id) => id !== iv.interviewerId);
      const latest = Math.min(at - 30 * MINUTE, nowMs);
      if (others.length && latest > booked + 30 * MINUTE) {
        const when = officeTime(between(booked + 30 * MINUTE, latest), booked + 30 * MINUTE, latest, rng);
        insert.run(iv.id, 'interviewer', String(rng.pick(others)), String(iv.interviewerId), by, iso(when));
      }
    }

    // Every recorded outcome: who recorded it, a little after the interview.
    if (iv.outcome !== 'pending' && at <= nowMs) {
      insert.run(iv.id, 'outcome', 'pending', iv.outcome, iv.interviewerId ?? by, iso(Math.min(at + rng.int(20, 120) * MINUTE, nowMs)));
    }
  }
}

function seedSheets(db: Db, ctx: SeedContext, rng: Rng, interviews: SeedInterview[]): void {
  const nowMs = Date.parse(ctx.nowIso);
  const bank = listQuestions(db);
  const insert = db.prepare(
    `INSERT INTO interview_answers (interview_id, question_id, question_text, sort, answer, score, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const iv of interviews) {
    const at = Date.parse(iv.scheduledAt);
    if ((iv.outcome !== 'passed' && iv.outcome !== 'failed') || at > nowMs || at < nowMs - 42 * DAY) continue;
    if (!rng.chance(0.8)) continue;
    const passed = iv.outcome === 'passed';
    draftSheetQuestions(bank, iv.type, iv.positionApplied).forEach((q, sort) => {
      const pool = DEMO_ANSWERS[q.text] ?? [];
      const answer = pool.length && rng.chance(0.9) ? rng.pick(pool) : '';
      const score = rng.chance(0.8) ? (passed ? rng.int(3, 5) : rng.int(1, 3)) : null;
      const written = answer !== '' || score !== null;
      insert.run(iv.id, q.id, q.text, sort, answer, score, written ? iso(Math.min(at + rng.int(15, 90) * MINUTE, nowMs)) : null, written ? iv.interviewerId : null);
    });
  }
}

function seedRecruitment(db: Db, ctx: SeedContext): void {
  const rng = ctx.rng(7307);
  insertDefaultQuestions(db, ctx.nowIso);
  setMetaFlag(db, QUESTIONS_FLAG);
  seedDatesOfBirth(db, ctx, rng);
  const interviews = db
    .prepare(
      `SELECT i.id, i.candidate_id AS candidateId, i.type, i.scheduled_at AS scheduledAt, i.interviewer_id AS interviewerId, i.outcome,
              c.owner_id AS ownerId, c.position_applied AS positionApplied
       FROM interviews i JOIN candidates c ON c.id = i.candidate_id ORDER BY i.id`,
    )
    .all() as unknown as SeedInterview[];
  seedInterviewChanges(db, ctx, rng, interviews);
  seedSheets(db, ctx, rng, interviews);
}

export const extension: DbExtension = {
  name: 'recruitment',
  sql: SQL,
  upgrade(db) {
    const columns = [addColumnIfMissing(db, 'candidates', 'date_of_birth', 'TEXT')].filter((name): name is string => name !== null);
    upgradeDefaultQuestions(db);
    return columns;
  },
  seed: seedRecruitment,
};
