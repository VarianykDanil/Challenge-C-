import { Router } from 'express';
import { z } from 'zod';
import { PIPELINE_STAGES, POSITIONS, TERMINAL_STAGES, defaultNextActionAt, isOverdue, stageIndex, type CandidateSource, type CandidateStage, type Position, type RecruitmentSummary, type UserWithTeam } from '@lm/shared';
import { all, get, run, transaction, type Db } from '../db/connection.ts';
import { Where, getCandidate, getInterview, getUser, listCandidates, listInterviews, listStageChanges } from '../db/queries.ts';
import { addDays, businessNow, eachMonday, isISODate, mondayOf, nowISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { idParam, isoTimestamp, optionalIdQuery, optionalString, parseRange } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';
import { defaultPayPlanId, nextEmployeeId, pickAvatarColor } from './users.ts';

const SOURCES = ['indeed', 'linkedin', 'referral', 'website', 'walk_in', 'agency', 'university', 'other'] as const;
const STAGES = ['applied', 'screening', 'interview', 'observation', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
const INTERVIEW_TYPES = ['phone', 'first', 'observation', 'final'] as const;
const OUTCOMES = ['pending', 'passed', 'failed', 'no_show'] as const;

/**
 * A next-action deadline (create, patch and stage move alike): a real calendar date `YYYY-MM-DD` (due that day, overdue
 * from the next) or an ISO 8601 timestamp (`2026-10-24T17:00:00Z`, `…+01:00`). The calendar day must exist (`Date`
 * would roll 31 Feb over to 3 Mar) and free text such as `Oct 24 2026` is refused.
 */
const nextActionDeadline = z
  .string()
  .trim()
  .refine(
    (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? isISODate(s) : /^\d{4}-\d{2}-\d{2}T/.test(s) && isISODate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s))),
    'Expected a date (YYYY-MM-DD) or an ISO 8601 timestamp',
  );

const candidateBody = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.string().trim().email(),
  phone: z.string().trim().max(30).nullable().optional(),
  city: z.string().trim().max(60).nullable().optional(),
  source: z.enum(SOURCES).optional(),
  positionApplied: z.enum(POSITIONS as [Position, ...Position[]]).optional(),
  ownerId: z.number().int().positive().nullable().optional(),
  referredById: z.number().int().positive().nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  nextAction: z.string().trim().max(200).nullable().optional(),
  nextActionAt: nextActionDeadline.nullable().optional(),
});

const interviewBody = z.object({
  candidateId: z.number().int().positive(),
  type: z.enum(INTERVIEW_TYPES),
  scheduledAt: isoTimestamp,
  interviewerId: z.number().int().positive().nullable().optional().default(null),
  outcome: z.enum(OUTCOMES).default('pending'),
  notes: z.string().trim().max(2000).nullable().optional().default(null),
});

const TERMINAL_SQL = `('hired', 'rejected', 'withdrawn')`;

/**
 * The stage machine: forward moves along the pipeline (any number of steps), one step back, `rejected`/`withdrawn`
 * from any open stage, `hired` only from `offer`. Terminal stages are immutable except that an admin may reopen a
 * `rejected`/`withdrawn` candidate to `offer`. Anything else is a `409`.
 */
export function assertStageTransition(me: UserWithTeam, from: CandidateStage, to: CandidateStage): void {
  if (from === to) throw conflict(`Candidate is already at stage ${to}`);
  if (from === 'hired') throw conflict('Hired candidates cannot change stage');
  if (from === 'rejected' || from === 'withdrawn') {
    if (me.role === 'admin' && to === 'offer') return;
    throw conflict(`A ${from} candidate can only be reopened to offer, by an administrator`);
  }
  if (to === 'rejected' || to === 'withdrawn') return;
  if (to === 'hired') {
    if (from === 'offer') return;
    throw conflict('Candidates are hired from the offer stage');
  }
  const fi = stageIndex(from);
  const ti = stageIndex(to);
  if (ti > fi || ti === fi - 1) return;
  throw conflict(`Cannot move a candidate from ${from} back to ${to} — only one stage back`);
}

/** Letters that have no Unicode decomposition and would otherwise vanish from a staff email address. */
const ASCII_FOLD: Record<string, string> = { 'ł': 'l', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'þ': 'th', 'ð': 'd', 'ı': 'i', 'ŋ': 'n' };

/**
 * The local part of a hire's company address: accents stripped (NFD, combining marks removed), the few letters that
 * do not decompose folded by hand, then ASCII letters and digits only — `Łukasz Żółć` → `lukasz.zolc`. A name part
 * with nothing left is dropped; when nothing is left at all the address starts with `staff`.
 */
export function staffEmailLocalPart(firstName: string, lastName: string): string {
  const fold = (s: string) =>
    s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\x00-\x7f]/g, (ch) => ASCII_FOLD[ch] ?? '').replace(/[^a-z0-9]/g, '');
  const parts = [fold(firstName), fold(lastName)].filter(Boolean);
  return parts.length ? parts.join('.') : 'staff';
}

export function recruitmentRouter(db: Db): Router {
  const router = Router();
  router.use(requireRole('recruiter', 'leader', 'admin'));

  // ── candidates ──
  router.get('/candidates', (req, res) => {
    const where = new Where();
    const stage = optionalString(req.query.stage);
    if (stage) {
      if (!STAGES.includes(stage as CandidateStage)) throw badRequest('Invalid stage');
      where.add('c.stage = ?', stage);
    }
    const ownerId = optionalIdQuery(req.query.ownerId, 'ownerId');
    if (ownerId) where.add('c.owner_id = ?', ownerId);
    const source = optionalString(req.query.source);
    if (source) {
      if (!SOURCES.includes(source as CandidateSource)) throw badRequest('Invalid source');
      where.add('c.source = ?', source);
    }
    const q = optionalString(req.query.q);
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.add(`(lower(c.first_name || ' ' || c.last_name) LIKE ? OR lower(c.email) LIKE ? OR lower(COALESCE(c.city, '')) LIKE ?)`, like, like, like);
    }
    if (req.query.open === 'true') where.add(`c.stage NOT IN ${TERMINAL_SQL}`);
    res.json(listCandidates(db, `${where}`, where.params));
  });

  router.get('/candidates/:id', (req, res) => {
    const candidate = getCandidate(db, idParam(req));
    if (!candidate) throw notFound('Candidate');
    res.json({
      ...candidate,
      history: listStageChanges(db, candidate.id),
      interviews: listInterviews(db, 'WHERE i.candidate_id = ?', [candidate.id]),
    });
  });

  /** An email may only be in the open pipeline once (closed candidates may re-apply). */
  const assertEmailNotOpen = (email: string, exceptId = 0) => {
    const open = get<{ id: number }>(db, `SELECT id FROM candidates WHERE lower(email) = lower(?) AND stage NOT IN ${TERMINAL_SQL} AND id <> ?`, [email, exceptId]);
    if (open) throw conflict(`A candidate with that email is already in the pipeline (#${open.id})`);
  };

  router.post('/candidates', (req, res) => {
    const me = currentUser(req);
    const body = candidateBody.parse(req.body);
    const ownerId = body.ownerId === undefined ? me.id : body.ownerId;
    if (ownerId !== null && !getUser(db, ownerId)) throw badRequest('Unknown ownerId');
    if (body.referredById && !getUser(db, body.referredById)) throw badRequest('Unknown referredById');
    assertEmailNotOpen(body.email);
    const now = nowISO();
    // 1.1: an omitted deadline defaults to the Applied target (today + 3 days, date-only); an explicit null stays null
    const nextActionAt = body.nextActionAt === undefined ? defaultNextActionAt('applied', todayISO()) : body.nextActionAt;
    const id = transaction(db, () => {
      const r = run(
        db,
        `INSERT INTO candidates (first_name, last_name, email, phone, city, source, stage, position_applied, applied_at, stage_updated_at, owner_id, referred_by_id, rating, notes, next_action, next_action_at, hired_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          body.firstName, body.lastName, body.email, body.phone ?? null, body.city ?? null, body.source ?? 'other', body.positionApplied ?? 'trainee',
          now, now, ownerId, body.referredById ?? null, body.rating ?? null, body.notes ?? null, body.nextAction ?? 'Phone screen', nextActionAt,
        ],
      );
      run(db, `INSERT INTO stage_changes (candidate_id, from_stage, to_stage, changed_at, changed_by_id, note) VALUES (?, NULL, 'applied', ?, ?, NULL)`, [r.lastInsertRowid, now, me.id]);
      return r.lastInsertRowid;
    });
    res.status(201).json(getCandidate(db, id));
  });

  router.patch('/candidates/:id', (req, res) => {
    const id = idParam(req);
    const existing = getCandidate(db, id);
    if (!existing) throw notFound('Candidate');
    if (req.body && typeof req.body === 'object' && 'stage' in req.body) throw badRequest('Use POST /recruitment/candidates/:id/stage to change the stage');
    const patch = candidateBody.partial().parse(req.body);
    if (patch.ownerId && !getUser(db, patch.ownerId)) throw badRequest('Unknown ownerId');
    if (patch.referredById && !getUser(db, patch.referredById)) throw badRequest('Unknown referredById');
    if (patch.email !== undefined && patch.email.toLowerCase() !== existing.email.toLowerCase() && !TERMINAL_STAGES.includes(existing.stage)) assertEmailNotOpen(patch.email, id);
    const next = { ...existing, ...patch };
    run(
      db,
      `UPDATE candidates SET first_name = ?, last_name = ?, email = ?, phone = ?, city = ?, source = ?, position_applied = ?, owner_id = ?, referred_by_id = ?, rating = ?, notes = ?, next_action = ?, next_action_at = ? WHERE id = ?`,
      [next.firstName, next.lastName, next.email, next.phone ?? null, next.city ?? null, next.source, next.positionApplied, next.ownerId ?? null, next.referredById ?? null, next.rating ?? null, next.notes ?? null, next.nextAction ?? null, next.nextActionAt ?? null, id],
    );
    res.json(getCandidate(db, id));
  });

  router.post('/candidates/:id/stage', (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const candidate = getCandidate(db, id);
    if (!candidate) throw notFound('Candidate');
    const { stage, note, teamId, position, nextActionAt: bodyNextActionAt } = z
      .object({
        stage: z.enum(STAGES),
        note: z.string().trim().max(2000).optional(),
        /** 1.1: the new stage's deadline. Omitted → today + the stage SLA (date-only); null → none. Ignored for terminal stages. */
        nextActionAt: nextActionDeadline.nullable().optional(),
        /** hire only: the team the new rep joins (default: the candidate owner's team, or none) */
        teamId: z.number().int().positive().nullable().optional(),
        /** hire only: entry positions only — nobody is minted as a leader or owner through recruitment */
        position: z.enum(['trainee', 'field_rep']).optional(),
      })
      .parse(req.body);
    assertStageTransition(me, candidate.stage, stage);
    if (stage === 'hired' && teamId != null && !get(db, `SELECT 1 FROM teams WHERE id = ?`, [teamId])) throw badRequest('Unknown teamId');
    if (stage === 'hired' && candidate.hiredUserId === null) {
      // one person, one employee account
      if (get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?)`, [candidate.email])) throw conflict(`A user with the email ${candidate.email} already exists`);
      const twin = get<{ id: number }>(db, `SELECT id FROM candidates WHERE lower(email) = lower(?) AND stage = 'hired' AND id <> ?`, [candidate.email, id]);
      if (twin) throw conflict(`This person has already been hired (candidate #${twin.id})`);
    }
    const now = nowISO();
    const isTerminal = TERMINAL_STAGES.includes(stage);
    // A move starts the new stage's clock: the deadline is the stage target unless the body sets one (or null for none).
    // It no longer carries the previous stage's date forward, which left most open candidates overdue.
    const nextActionAt = isTerminal ? null : bodyNextActionAt === undefined ? defaultNextActionAt(stage, todayISO()) : bodyNextActionAt;
    transaction(db, () => {
      let hiredUserId: number | null = candidate.hiredUserId;
      if (stage === 'hired' && hiredUserId === null) {
        const owner = candidate.ownerId ? getUser(db, candidate.ownerId) : undefined;
        const newTeamId = teamId !== undefined ? teamId : (owner?.teamId ?? null);
        // the position is restricted to entry roles and the pay plan is always the server default for it,
        // whatever the body or the application said (recruiters/leaders cannot choose plans)
        const newPosition: Position = position ?? (candidate.positionApplied === 'field_rep' ? 'field_rep' : 'trainee');
        const base = staffEmailLocalPart(candidate.firstName, candidate.lastName);
        let email = `${base}@linear-mcr.co.uk`;
        for (let i = 2; get(db, `SELECT 1 FROM users WHERE lower(email) = ?`, [email]); i++) email = `${base}${i}@linear-mcr.co.uk`;
        const count = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users`)!.n;
        const r = run(
          db,
          `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
           VALUES (?, ?, ?, ?, 'rep', ?, ?, ?, ?, 'active', ?, ?, ?)`,
          [
            nextEmployeeId(db), email, candidate.firstName, candidate.lastName, newPosition, newTeamId,
            defaultPayPlanId(db, newPosition), todayISO(), candidate.phone, pickAvatarColor(Number(count)), candidate.city,
          ],
        );
        hiredUserId = r.lastInsertRowid;
      }
      run(db, `INSERT INTO stage_changes (candidate_id, from_stage, to_stage, changed_at, changed_by_id, note) VALUES (?, ?, ?, ?, ?, ?)`, [
        id, candidate.stage, stage, now, me.id, note ?? null,
      ]);
      run(
        db,
        `UPDATE candidates SET stage = ?, stage_updated_at = ?, hired_user_id = ?, next_action = ?, next_action_at = ? WHERE id = ?`,
        [stage, now, hiredUserId, isTerminal ? null : NEXT_ACTION[stage] ?? null, nextActionAt, id],
      );
    });
    res.json(getCandidate(db, id));
  });

  // ── interviews ──
  router.get('/interviews', (req, res) => {
    const where = new Where();
    const candidateId = optionalIdQuery(req.query.candidateId, 'candidateId');
    if (candidateId) where.add('i.candidate_id = ?', candidateId);
    const hasRange = req.query.from !== undefined || req.query.to !== undefined;
    if (hasRange || !candidateId) {
      const today = todayISO();
      const { from, to } = parseRange(req.query, { from: mondayOf(today), to: addDays(today, 14) });
      where.add('substr(i.scheduled_at, 1, 10) BETWEEN ? AND ?', from, to);
    }
    res.json(listInterviews(db, `${where}`, where.params));
  });

  router.post('/interviews', (req, res) => {
    const body = interviewBody.parse(req.body);
    if (!getCandidate(db, body.candidateId)) throw notFound('Candidate');
    if (body.interviewerId !== null && !getUser(db, body.interviewerId)) throw badRequest('Unknown interviewerId');
    const r = run(db, `INSERT INTO interviews (candidate_id, type, scheduled_at, interviewer_id, outcome, notes) VALUES (?, ?, ?, ?, ?, ?)`, [
      body.candidateId, body.type, new Date(body.scheduledAt).toISOString(), body.interviewerId, body.outcome, body.notes,
    ]);
    res.status(201).json(getInterview(db, r.lastInsertRowid));
  });

  router.patch('/interviews/:id', (req, res) => {
    const id = idParam(req);
    const existing = getInterview(db, id);
    if (!existing) throw notFound('Interview');
    const patch = interviewBody.partial().parse(req.body);
    if (patch.candidateId !== undefined && !getCandidate(db, patch.candidateId)) throw notFound('Candidate');
    if (patch.interviewerId && !getUser(db, patch.interviewerId)) throw badRequest('Unknown interviewerId');
    const next = { ...existing, ...patch };
    run(db, `UPDATE interviews SET candidate_id = ?, type = ?, scheduled_at = ?, interviewer_id = ?, outcome = ?, notes = ? WHERE id = ?`, [
      next.candidateId, next.type, new Date(next.scheduledAt).toISOString(), next.interviewerId ?? null, next.outcome, next.notes ?? null, id,
    ]);
    res.json(getInterview(db, id));
  });

  // ── summary ──
  router.get('/summary', (req, res) => {
    const today = todayISO();
    const { from, to } = parseRange(req.query, { from: addDays(mondayOf(today), -12 * 7), to: today });
    res.json(recruitmentSummary(db, from, to));
  });

  return router;
}

/** SQL: the Monday (`YYYY-MM-DD`) of a UTC ISO timestamp column (SQLite %w: 0 = Sunday). */
const mondayOfTimestamp = (col: string) => `date(substr(${col}, 1, 10), '-' || ((CAST(strftime('%w', substr(${col}, 1, 10)) AS INTEGER) + 6) % 7) || ' days')`;

const NEXT_ACTION: Partial<Record<CandidateStage, string>> = {
  applied: 'Phone screen',
  screening: 'Book first interview',
  interview: 'Schedule observation day',
  observation: 'Decision & offer call',
  offer: 'Chase offer acceptance',
};

/**
 * Open candidates past their next action across the whole pipeline: the "Overdue actions" tile (recruitmentSummary),
 * also quoted by the recruiter's Needs-attention item. The shared rule, not a string compare: a date-only deadline is
 * overdue from the next calendar day, a timestamp once now is past it.
 */
export function countOverdueActions(db: Db, now: Date): number {
  return all<{ at: string }>(db, `SELECT next_action_at AS at FROM candidates WHERE stage NOT IN ${TERMINAL_SQL} AND next_action_at IS NOT NULL`).filter((r) =>
    isOverdue(r.at, now),
  ).length;
}

export function recruitmentSummary(db: Db, from: string, to: string): RecruitmentSummary {
  const toEnd = `${to}T23:59:59.999Z`;
  const fromStart = `${from}T00:00:00.000Z`;
  const openByStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<CandidateStage, number>;
  for (const r of all<{ stage: CandidateStage; n: number }>(db, `SELECT stage, COUNT(*) AS n FROM candidates WHERE stage NOT IN ${TERMINAL_SQL} GROUP BY stage`)) {
    openByStage[r.stage] = Number(r.n);
  }
  for (const r of all<{ stage: CandidateStage; n: number }>(
    db,
    `SELECT to_stage AS stage, COUNT(DISTINCT candidate_id) AS n FROM stage_changes WHERE to_stage IN ${TERMINAL_SQL} AND changed_at BETWEEN ? AND ? GROUP BY to_stage`,
    [fromStart, toEnd],
  )) {
    openByStage[r.stage] = Number(r.n);
  }

  const reached = new Map<CandidateStage, number>();
  for (const r of all<{ stage: CandidateStage; n: number }>(
    db,
    `SELECT s.to_stage AS stage, COUNT(DISTINCT s.candidate_id) AS n FROM stage_changes s JOIN candidates c ON c.id = s.candidate_id
     WHERE c.applied_at BETWEEN ? AND ? GROUP BY s.to_stage`,
    [fromStart, toEnd],
  )) {
    reached.set(r.stage, Number(r.n));
  }
  const funnel = PIPELINE_STAGES.map((stage) => ({ stage, count: reached.get(stage) ?? 0 }));

  const bySource = all<{ source: CandidateSource; applied: number; hired: number }>(
    db,
    `SELECT source, COUNT(*) AS applied, COALESCE(SUM(stage = 'hired'), 0) AS hired FROM candidates WHERE applied_at BETWEEN ? AND ? GROUP BY source ORDER BY applied DESC`,
    [fromStart, toEnd],
  ).map((r) => ({ source: r.source, applied: Number(r.applied), hired: Number(r.hired), conversion: r.applied ? Math.round((Number(r.hired) / Number(r.applied)) * 10_000) / 10_000 : 0 }));

  // Weekly buckets are clipped to [from, to] like the finance series, so the bars add up to the headline totals; the
  // first bucket is keyed by `from` when the range starts mid-week. One GROUP BY query per series instead of three
  // queries per week.
  const weekKeyOf = (monday: string) => (monday < from ? from : monday);
  const weekly = eachMonday(from, to).map((monday) => ({ weekStart: weekKeyOf(monday), applied: 0, interviews: 0, hired: 0 }));
  const weekByKey = new Map(weekly.map((w) => [w.weekStart, w]));
  const fill = (rows: { wk: string; n: number }[], field: 'applied' | 'interviews' | 'hired') => {
    for (const r of rows) {
      const w = weekByKey.get(weekKeyOf(r.wk));
      if (w) w[field] += Number(r.n);
    }
  };
  fill(all(db, `SELECT ${mondayOfTimestamp('applied_at')} AS wk, COUNT(*) AS n FROM candidates WHERE applied_at BETWEEN ? AND ? GROUP BY wk`, [fromStart, toEnd]), 'applied');
  fill(all(db, `SELECT ${mondayOfTimestamp('scheduled_at')} AS wk, COUNT(*) AS n FROM interviews WHERE scheduled_at BETWEEN ? AND ? GROUP BY wk`, [fromStart, toEnd]), 'interviews');
  fill(all(db, `SELECT ${mondayOfTimestamp('changed_at')} AS wk, COUNT(DISTINCT candidate_id) AS n FROM stage_changes WHERE to_stage = 'hired' AND changed_at BETWEEN ? AND ? GROUP BY wk`, [fromStart, toEnd]), 'hired');

  const hiredRows = all<{ appliedAt: string; hiredAt: string }>(
    db,
    `SELECT c.applied_at AS appliedAt, s.changed_at AS hiredAt FROM stage_changes s JOIN candidates c ON c.id = s.candidate_id
     WHERE s.to_stage = 'hired' AND s.changed_at BETWEEN ? AND ?`,
    [fromStart, toEnd],
  );
  const avgTimeToHireDays = hiredRows.length
    ? Math.round((hiredRows.reduce((a, r) => a + (Date.parse(r.hiredAt) - Date.parse(r.appliedAt)) / 86_400_000, 0) / hiredRows.length) * 10) / 10
    : 0;
  const applied = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM candidates WHERE applied_at BETWEEN ? AND ?`, [fromStart, toEnd])!.n;
  const overdue = countOverdueActions(db, businessNow());

  return {
    from,
    to,
    openByStage,
    funnel,
    bySource,
    weekly,
    hired: hiredRows.length,
    applied: Number(applied),
    avgTimeToHireDays,
    overdueActions: Number(overdue),
  };
}
