/**
 * P7 recruitment-plus: the demo seed (the default bank, dates of birth with two open under-18s, the change log of every
 * seeded interview, the sheets of recent passed / failed interviews) is consistent with the core rows, deterministic,
 * never in the future, and leaves a restart with nothing to do; and the demo accounts see it through the routes.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOn, dateOfBirthProblem, questionTopicWarning } from '@lm/shared';
import { all, get, openDb, type Db } from '../db/connection.ts';
import { QUESTIONS_FLAG } from '../db/extensions/recruitment.ts';
import { metaFlag } from '../db/extensions/types.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { DEFAULT_INTERVIEW_QUESTIONS } from '../lib/recruitmentPlus/defaults.ts';
import { addDays, nowISO, todayISO } from '../lib/dates.ts';
import { startTestServer, type Json, type TestServer } from './helpers.ts';

function seeded(): Db {
  const db = openDb(':memory:');
  createSchema(db);
  seed(db, todayISO());
  return db;
}

let db: Db;
before(() => {
  db = seeded();
});
after(() => db.close());

test('the bank: the default questions, the flag set, and a restart after the seed changes nothing', () => {
  const rows = all<{ text: string }>(db, `SELECT text FROM interview_questions ORDER BY id`);
  assert.deepEqual(rows.map((r) => r.text), DEFAULT_INTERVIEW_QUESTIONS.map((q) => q.text));
  assert.ok(rows.every((r) => questionTopicWarning(r.text) === null));
  assert.equal(metaFlag(db, QUESTIONS_FLAG), true);
  assert.deepEqual(createSchema(db), []);
});

test('dates of birth: most candidates, all plausible, two open applicants under 18 and no one else', () => {
  const today = todayISO();
  const rows = all<{ id: number; stage: string; dob: string | null }>(db, `SELECT id, stage, date_of_birth AS dob FROM candidates`);
  const recorded = rows.filter((r) => r.dob !== null);
  assert.ok(recorded.length >= rows.length * 0.75, `${recorded.length} of ${rows.length}`);
  for (const r of recorded) assert.equal(dateOfBirthProblem(r.dob!, today), null, `${r.id} ${r.dob}`);
  const under = recorded.filter((r) => ageOn(r.dob!, today)! < 18);
  assert.equal(under.length, 2);
  assert.deepEqual(under.map((r) => r.stage).sort(), ['applied', 'screening']);
});

test('the change log matches the interviews: one booking each, outcomes and reassignments end where the interview is now', () => {
  const now = nowISO();
  const ivs = all<{ id: number; scheduledAt: string; interviewerId: number | null; outcome: string }>(
    db,
    `SELECT id, scheduled_at AS scheduledAt, interviewer_id AS interviewerId, outcome FROM interviews`,
  );
  const byId = new Map(ivs.map((i) => [i.id, i]));
  const changes = all<{ interviewId: number; field: string; fromValue: string | null; toValue: string | null; changedAt: string; changedBy: number | null }>(
    db,
    `SELECT interview_id AS interviewId, field, from_value AS fromValue, to_value AS toValue, changed_at AS changedAt, changed_by AS changedBy FROM interview_changes ORDER BY id`,
  );
  const booked = changes.filter((c) => c.field === 'booked');
  assert.equal(booked.length, ivs.length);
  assert.equal(new Set(booked.map((c) => c.interviewId)).size, ivs.length);
  for (const c of changes) {
    const iv = byId.get(c.interviewId)!;
    assert.ok(c.changedAt <= now, `no change in the future: ${c.changedAt}`);
    assert.ok(c.changedBy !== null, 'every change has an author');
    if (c.field === 'booked') assert.ok(c.changedAt <= c.toValue! && c.changedAt < iv.scheduledAt, 'booked before the interview');
    if (c.field === 'outcome') assert.deepEqual([c.fromValue, c.toValue], ['pending', iv.outcome]);
    if (c.field === 'interviewer') {
      assert.equal(c.toValue, String(iv.interviewerId));
      assert.notEqual(c.fromValue, c.toValue);
      assert.ok(c.changedAt < iv.scheduledAt);
    }
    if (c.field === 'scheduled_at') {
      assert.equal(c.toValue, iv.scheduledAt);
      assert.ok(c.fromValue! < c.toValue!, 'moved to a later slot');
      const first = booked.find((b) => b.interviewId === c.interviewId)!;
      assert.equal(first.toValue, c.fromValue, 'the booking was for the first slot');
    }
  }
  assert.ok(changes.some((c) => c.field === 'interviewer'), 'some reassignments');
  assert.ok(changes.some((c) => c.field === 'scheduled_at'), 'some reschedules');
  const recorded = ivs.filter((i) => i.outcome !== 'pending').length;
  assert.equal(changes.filter((c) => c.field === 'outcome').length, recorded);
});

test('bookings, moves and reassignments are made in office hours (Mon–Fri 09:00–18:00), half an hour or more before the interview', () => {
  const rows = all<{ field: string; changedAt: string; scheduledAt: string }>(
    db,
    `SELECT c.field, c.changed_at AS changedAt, i.scheduled_at AS scheduledAt FROM interview_changes c JOIN interviews i ON i.id = c.interview_id
     WHERE c.field IN ('booked', 'scheduled_at', 'interviewer')`,
  );
  // Local time, like the core seed's interview slots (the tests run in Europe/London, as the office does).
  const outside = rows.filter((r) => {
    const d = new Date(r.changedAt);
    return d.getDay() === 0 || d.getDay() === 6 || d.getHours() < 9 || d.getHours() >= 18;
  });
  // Only a stage move out of hours with the interview first thing the next working morning leaves no office-hours moment.
  assert.ok(outside.length <= Math.ceil(rows.length * 0.03), `${outside.length} of ${rows.length} outside office hours: ${outside.slice(0, 3).map((r) => r.changedAt).join(', ')}`);
  for (const r of rows) assert.ok(Date.parse(r.changedAt) <= Date.parse(r.scheduledAt) - 30 * 60_000 || r.field === 'scheduled_at', `${r.field} at ${r.changedAt} for ${r.scheduledAt}`);
});

test('the sheets: recent passed or failed interviews only, the bank\'s words, scores 1–5', () => {
  const now = nowISO();
  const rows = all<{ interviewId: number; questionId: number | null; questionText: string; bankText: string | null; score: number | null; outcome: string; scheduledAt: string; updatedAt: string | null }>(
    db,
    `SELECT a.interview_id AS interviewId, a.question_id AS questionId, a.question_text AS questionText, q.text AS bankText, a.score,
            i.outcome, i.scheduled_at AS scheduledAt, a.updated_at AS updatedAt
     FROM interview_answers a JOIN interviews i ON i.id = a.interview_id LEFT JOIN interview_questions q ON q.id = a.question_id`,
  );
  assert.ok(rows.length > 20, `${rows.length} answers`);
  const lookback = new Date(Date.parse(now) - 42 * 86_400_000).toISOString();
  for (const r of rows) {
    assert.ok(r.outcome === 'passed' || r.outcome === 'failed', r.outcome);
    assert.ok(r.scheduledAt >= lookback && r.scheduledAt <= now);
    assert.equal(r.questionText, r.bankText);
    if (r.score !== null) assert.ok(Number.isInteger(r.score) && r.score >= 1 && r.score <= 5);
    if (r.updatedAt) assert.ok(r.updatedAt >= r.scheduledAt && r.updatedAt <= now);
  }
});

test('the seed is deterministic: the same day gives the same rows', () => {
  const other = seeded();
  try {
    const dump = (d: Db) => JSON.stringify([
      all(d, `SELECT * FROM interview_changes ORDER BY id`),
      all(d, `SELECT * FROM interview_answers ORDER BY id`),
      all(d, `SELECT id, date_of_birth FROM candidates ORDER BY id`),
    ].map((rows) => rows.map((r) => ({ ...(r as object) }))));
    // updated_at / changed_at follow the business clock, which ticks between the two seeds: compare dates only.
    const strip = (s: string) => s.replace(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '');
    assert.equal(strip(dump(other)), strip(dump(db)));
  } finally {
    other.close();
  }
});

// ───────────────────────────── through the routes, with the demo accounts ─────────────────────────────

let srv: TestServer;
before(async () => {
  srv = await startTestServer({ seed: true });
});
after(async () => {
  await srv.close();
});

test('demo: the recruiter\'s schedule, a candidate timeline with a reassignment, a saved sheet, the under-18 profile', async () => {
  const recruiter = await srv.login('recruiter');
  const today = todayISO();
  const schedule = await recruiter.get(`/recruitment/schedule?from=${today}&to=${addDays(today, 13)}`);
  assert.equal(schedule.status, 200);
  assert.ok((schedule.json as Json[]).length >= 1, 'upcoming interviews');
  const reassigned = get<{ candidateId: number }>(srv.db, `SELECT i.candidate_id AS candidateId FROM interview_changes c JOIN interviews i ON i.id = c.interview_id WHERE c.field = 'interviewer' LIMIT 1`)!;
  const timeline = (await recruiter.get(`/recruitment/candidates/${reassigned.candidateId}/timeline`)).json as Json[];
  assert.ok(timeline.some((i) => i.kind === 'interviewer' && / interviewer changed from .+ to .+ by /.test(i.text)), JSON.stringify(timeline.slice(0, 3)));
  assert.ok(timeline.some((i) => i.kind === 'booked'));
  assert.equal(timeline.at(-1).kind, 'applied');
  const sheetOf = get<{ id: number }>(srv.db, `SELECT interview_id AS id FROM interview_answers LIMIT 1`)!;
  const sheet = (await recruiter.get(`/recruitment/interviews/${sheetOf.id}/sheet`)).json;
  assert.equal(sheet.saved, true);
  assert.ok(sheet.summary.answered > 0);
  const young = get<{ id: number }>(srv.db, `SELECT id FROM candidates WHERE stage = 'applied' AND date_of_birth > ? ORDER BY applied_at DESC LIMIT 1`, [`${Number(today.slice(0, 4)) - 18}${today.slice(4)}`])!;
  const profile = (await recruiter.get(`/recruitment/candidates/${young.id}`)).json;
  assert.ok(ageOn(profile.dateOfBirth, today)! < 18);
  const leader = await srv.login('leader');
  assert.equal((await leader.get('/recruitment/questions')).status, 403, 'the bank is the admin\'s and the recruiter\'s');
  const demoClient = await srv.login('client');
  assert.equal((await demoClient.get('/recruitment/schedule')).status, 403);
});
