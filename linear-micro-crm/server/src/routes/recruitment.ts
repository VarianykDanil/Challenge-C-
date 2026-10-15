import { Router } from 'express';
import { z } from 'zod';
import { PIPELINE_STAGES, POSITIONS, TERMINAL_STAGES, type CandidateSource, type CandidateStage, type Position, type RecruitmentSummary } from '@lm/shared';
import { all, get, run, transaction, type Db } from '../db/connection.ts';
import { Where, getCandidate, getInterview, getUser, listCandidates, listInterviews, listStageChanges } from '../db/queries.ts';
import { addDays, eachMonday, mondayOf, nowISO, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { idParam, isoTimestamp, optionalIdQuery, optionalString, parseRange } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';
import { defaultPayPlanId, nextEmployeeId, pickAvatarColor } from './users.ts';

const SOURCES = ['indeed', 'linkedin', 'referral', 'website', 'walk_in', 'agency', 'university', 'other'] as const;
const STAGES = ['applied', 'screening', 'interview', 'observation', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
const INTERVIEW_TYPES = ['phone', 'first', 'observation', 'final'] as const;
const OUTCOMES = ['pending', 'passed', 'failed', 'no_show'] as const;

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
  nextActionAt: isoTimestamp.nullable().optional(),
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

  router.post('/candidates', (req, res) => {
    const me = currentUser(req);
    const body = candidateBody.parse(req.body);
    const ownerId = body.ownerId === undefined ? me.id : body.ownerId;
    if (ownerId !== null && !getUser(db, ownerId)) throw badRequest('Unknown ownerId');
    if (body.referredById && !getUser(db, body.referredById)) throw badRequest('Unknown referredById');
    const now = nowISO();
    const id = transaction(db, () => {
      const r = run(
        db,
        `INSERT INTO candidates (first_name, last_name, email, phone, city, source, stage, position_applied, applied_at, stage_updated_at, owner_id, referred_by_id, rating, notes, next_action, next_action_at, hired_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          body.firstName, body.lastName, body.email, body.phone ?? null, body.city ?? null, body.source ?? 'other', body.positionApplied ?? 'trainee',
          now, now, ownerId, body.referredById ?? null, body.rating ?? null, body.notes ?? null, body.nextAction ?? 'Phone screen', body.nextActionAt ?? null,
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
    const { stage, note } = z.object({ stage: z.enum(STAGES), note: z.string().trim().max(2000).optional() }).parse(req.body);
    if (candidate.stage === stage) throw conflict(`Candidate is already at stage ${stage}`);
    if (candidate.stage === 'hired') throw conflict('Hired candidates cannot change stage');
    const now = nowISO();
    const isTerminal = TERMINAL_STAGES.includes(stage);
    transaction(db, () => {
      let hiredUserId: number | null = candidate.hiredUserId;
      if (stage === 'hired' && hiredUserId === null) {
        const owner = candidate.ownerId ? getUser(db, candidate.ownerId) : undefined;
        const base = `${candidate.firstName}.${candidate.lastName}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
        let email = `${base}@linear-mcr.co.uk`;
        for (let i = 2; get(db, `SELECT 1 FROM users WHERE lower(email) = ?`, [email]); i++) email = `${base}${i}@linear-mcr.co.uk`;
        const count = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users`)!.n;
        const r = run(
          db,
          `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
           VALUES (?, ?, ?, ?, 'rep', ?, ?, ?, ?, 'active', ?, ?, ?)`,
          [
            nextEmployeeId(db), email, candidate.firstName, candidate.lastName, candidate.positionApplied, owner?.teamId ?? null,
            defaultPayPlanId(db, candidate.positionApplied), todayISO(), candidate.phone, pickAvatarColor(Number(count)), candidate.city,
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
        [stage, now, hiredUserId, isTerminal ? null : NEXT_ACTION[stage] ?? null, isTerminal ? null : candidate.nextActionAt, id],
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

const NEXT_ACTION: Partial<Record<CandidateStage, string>> = {
  applied: 'Phone screen',
  screening: 'Book first interview',
  interview: 'Schedule observation day',
  observation: 'Decision & offer call',
  offer: 'Chase offer acceptance',
};

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

  const weekly = eachMonday(from, to).map((weekStart) => {
    const wFrom = `${weekStart}T00:00:00.000Z`;
    const wTo = `${addDays(weekStart, 6)}T23:59:59.999Z`;
    const applied = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM candidates WHERE applied_at BETWEEN ? AND ?`, [wFrom, wTo])!.n;
    const interviews = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM interviews WHERE scheduled_at BETWEEN ? AND ?`, [wFrom, wTo])!.n;
    const hired = get<{ n: number }>(db, `SELECT COUNT(DISTINCT candidate_id) AS n FROM stage_changes WHERE to_stage = 'hired' AND changed_at BETWEEN ? AND ?`, [wFrom, wTo])!.n;
    return { weekStart, applied: Number(applied), interviews: Number(interviews), hired: Number(hired) };
  });

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
  const overdue = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM candidates WHERE stage NOT IN ${TERMINAL_SQL} AND next_action_at IS NOT NULL AND next_action_at < ?`,
    [nowISO()],
  )!.n;

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
