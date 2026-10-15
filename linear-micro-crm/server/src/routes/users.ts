import { Router } from 'express';
import { z } from 'zod';
import { POSITIONS, type Position, type UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { USER_SELECT, Where, getUser, listGauges } from '../db/queries.ts';
import { AVATAR_PALETTE } from '../db/seed-data.ts';
import { mondayOf, todayISO } from '../lib/dates.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { punctualityFor, ratiosOf, salesPerDay, summaryRows, totalsFor, trendFor } from '../lib/metrics.ts';
import { assertCanViewUser } from '../lib/scope.ts';
import { hexColor, idParam, isoDate, optionalIdQuery, optionalString, parseRange } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const ROLES = ['admin', 'leader', 'recruiter', 'rep'] as const;
const STATUSES = ['active', 'on_leave', 'left'] as const;

const userBody = z.object({
  employeeId: z.string().trim().min(3).max(20),
  email: z.string().trim().email(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  role: z.enum(ROLES),
  position: z.enum(POSITIONS as [Position, ...Position[]]),
  teamId: z.number().int().positive().nullable().default(null),
  payPlanId: z.number().int().positive().optional(),
  startDate: isoDate.default(() => todayISO()),
  status: z.enum(STATUSES).default('active'),
  phone: z.string().trim().max(30).nullable().optional().default(null),
  avatarColor: hexColor.optional(),
  city: z.string().trim().max(60).nullable().optional().default(null),
});

export function defaultPayPlanId(db: Db, position: Position): number {
  const row = get<{ id: number }>(db, `SELECT id FROM pay_plans WHERE position = ? ORDER BY id LIMIT 1`, [position]);
  if (!row) throw badRequest(`No pay plan exists for position ${position}`);
  return row.id;
}

export function nextEmployeeId(db: Db): string {
  const row = get<{ n: number | null }>(db, `SELECT MAX(CAST(substr(employee_id, 4) AS INTEGER)) AS n FROM users WHERE employee_id LIKE 'LM-%'`);
  return `LM-${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
}

export function pickAvatarColor(seed: number): string {
  return AVATAR_PALETTE[seed % AVATAR_PALETTE.length]!;
}

export function usersRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const where = new Where();
    const teamId = optionalIdQuery(req.query.teamId, 'teamId');
    const role = optionalString(req.query.role);
    const status = optionalString(req.query.status) ?? 'active';
    const q = optionalString(req.query.q);
    if (teamId) where.add('u.team_id = ?', teamId);
    if (role) {
      if (!ROLES.includes(role as (typeof ROLES)[number])) throw badRequest('Invalid role');
      where.add('u.role = ?', role);
    }
    if (status !== 'all') {
      if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw badRequest('Invalid status');
      where.add('u.status = ?', status);
    }
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.add(`(lower(u.first_name || ' ' || u.last_name) LIKE ? OR lower(u.email) LIKE ? OR lower(u.employee_id) LIKE ?)`, like, like, like);
    }
    res.json(all<UserWithTeam>(db, `${USER_SELECT} ${where} ORDER BY u.last_name, u.first_name`, where.params));
  });

  router.get('/:id', (req, res) => {
    const user = getUser(db, idParam(req));
    if (!user) throw notFound('User');
    res.json(user);
  });

  router.get('/:id/performance', (req, res) => {
    const me = currentUser(req);
    const user = getUser(db, idParam(req));
    if (!user) throw notFound('User');
    assertCanViewUser(me, user);
    const today = todayISO();
    const { from, to } = parseRange(req.query, { from: mondayOf(today), to: today });
    const where = new Where().add('g.user_id = ?', user.id).add('g.date BETWEEN ? AND ?', from, to);
    const totals = totalsFor(db, where);
    const { days, ...plain } = totals;
    res.json({
      user,
      totals: plain,
      ratios: ratiosOf(totals),
      days,
      salesPerDay: salesPerDay(totals, days),
      trend: trendFor(db, where, from, to, 'day'),
      byCampaign: summaryRows(db, 'campaign', where),
      recentEntries: listGauges(db, 'WHERE g.user_id = ?', [user.id], 'g.date DESC, g.submitted_at DESC', 10),
      punctualityRate: punctualityFor(db, where),
    });
  });

  router.post('/', requireRole('admin'), (req, res) => {
    const body = userBody.parse(req.body);
    if (get(db, `SELECT 1 FROM users WHERE lower(employee_id) = lower(?)`, [body.employeeId])) throw conflict(`Employee ID ${body.employeeId} is already in use`);
    if (get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?)`, [body.email])) throw conflict(`Email ${body.email} is already in use`);
    if (body.teamId !== null && !get(db, `SELECT 1 FROM teams WHERE id = ?`, [body.teamId])) throw badRequest('Unknown teamId');
    const payPlanId = body.payPlanId ?? defaultPayPlanId(db, body.position);
    if (!get(db, `SELECT 1 FROM pay_plans WHERE id = ?`, [payPlanId])) throw badRequest('Unknown payPlanId');
    const count = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users`)!.n;
    const r = run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.employeeId, body.email, body.firstName, body.lastName, body.role, body.position, body.teamId, payPlanId, body.startDate, body.status, body.phone, body.avatarColor ?? pickAvatarColor(Number(count)), body.city],
    );
    res.status(201).json(getUser(db, r.lastInsertRowid));
  });

  router.patch('/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    const existing = getUser(db, id);
    if (!existing) throw notFound('User');
    const patch = userBody.partial().parse(req.body);
    if (patch.employeeId && get(db, `SELECT 1 FROM users WHERE lower(employee_id) = lower(?) AND id <> ?`, [patch.employeeId, id])) throw conflict(`Employee ID ${patch.employeeId} is already in use`);
    if (patch.email && get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?) AND id <> ?`, [patch.email, id])) throw conflict(`Email ${patch.email} is already in use`);
    if (patch.teamId !== undefined && patch.teamId !== null && !get(db, `SELECT 1 FROM teams WHERE id = ?`, [patch.teamId])) throw badRequest('Unknown teamId');
    if (patch.payPlanId !== undefined && !get(db, `SELECT 1 FROM pay_plans WHERE id = ?`, [patch.payPlanId])) throw badRequest('Unknown payPlanId');
    const next = { ...existing, ...patch };
    run(
      db,
      `UPDATE users SET employee_id = ?, email = ?, first_name = ?, last_name = ?, role = ?, position = ?, team_id = ?, pay_plan_id = ?, start_date = ?, status = ?, phone = ?, avatar_color = ?, city = ? WHERE id = ?`,
      [next.employeeId, next.email, next.firstName, next.lastName, next.role, next.position, next.teamId, next.payPlanId, next.startDate, next.status, next.phone, next.avatarColor, next.city, id],
    );
    res.json(getUser(db, id));
  });

  return router;
}
