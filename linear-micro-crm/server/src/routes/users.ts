import { Router } from 'express';
import { z } from 'zod';
import { POSITIONS, addPersonRefusal, staffSignInInstructions, type AddPersonResult, type Position, type UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../db/connection.ts';
import { USER_SELECT, Where, getUser, listGauges } from '../db/queries.ts';
import { AVATAR_PALETTE } from '../db/seed-data.ts';
import { mondayOf, todayISO } from '../lib/dates.ts';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { nextEmployeeId, personOrderSql } from '../lib/people.ts';
import { readSecuritySettings } from '../lib/pin.ts';
import { punctualityFor, ratiosOf, salesPerDay, summaryRows, totalsFor, trendFor } from '../lib/metrics.ts';
import { redactEntry, redactUser } from '../lib/scope.ts';
import { clearTwoFactor } from '../lib/twofactor.ts';
import { hexColor, idParam, isoDate, optionalIdQuery, optionalString, parseRange } from '../lib/validate.ts';
import { currentUser, destroyUserSessions, requireRole } from '../middleware/auth.ts';

const ROLES = ['admin', 'leader', 'recruiter', 'rep'] as const;
const STATUSES = ['active', 'on_leave', 'left'] as const;

const userBody = z.object({
  employeeId: z.string().trim().min(3).max(20),
  email: z.string().trim().email(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1, 'Enter their last name').max(60),
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

/**
 * Release 1.3.1: POST /users — the employee ID is optional for everyone (missing → the next one); the role too, for a
 * recruiter or a leader (always `rep`); `signInUrl` (the sign-in page as the caller opened it) goes into the sign-in
 * instructions of the answer only, never stored. Who may set what: shared addPersonRefusal.
 */
const createBody = userBody.extend({
  employeeId: userBody.shape.employeeId.optional(),
  role: userBody.shape.role.optional(),
  signInUrl: z.string().trim().max(300).regex(/^https?:\/\/[^\s]+$/i, 'Expected an http(s) address').optional(),
});

/** PATCH: a last name may stay blank only when it is blank already (the demo accounts start without one). */
const patchBody = userBody.partial().extend({ lastName: z.string().trim().max(60).optional() });

export function defaultPayPlanId(db: Db, position: Position): number {
  const row = get<{ id: number }>(db, `SELECT id FROM pay_plans WHERE position = ? ORDER BY id LIMIT 1`, [position]);
  if (!row) throw badRequest(`No pay plan exists for position ${position}`);
  return row.id;
}

/** Release 1.3.1: lives in lib/people.ts (the demo teams use it too); re-exported for the recruitment hire. */
export { nextEmployeeId } from '../lib/people.ts';

export function pickAvatarColor(seed: number): string {
  return AVATAR_PALETTE[seed % AVATAR_PALETTE.length]!;
}

/**
 * Release 1.3 (r3-foundation): client portal accounts (role 'client') are not staff — they never appear in the Team
 * list and the routes below treat them as unknown (P6 manages them from the campaign page).
 */
function getStaffUser(db: Db, id: number): UserWithTeam | undefined {
  const user = getUser(db, id);
  return user && user.role !== 'client' ? user : undefined;
}

export function usersRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const me = currentUser(req);
    const where = new Where().add(`u.role <> 'client'`);
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
      // The employee ID is a credential: only admins may search by it (otherwise `q` would be a guessing oracle).
      if (me.role === 'admin') where.add(`(lower(TRIM(u.first_name || ' ' || u.last_name)) LIKE ? OR lower(u.email) LIKE ? OR lower(u.employee_id) LIKE ?)`, like, like, like);
      else where.add(`(lower(TRIM(u.first_name || ' ' || u.last_name)) LIKE ? OR lower(u.email) LIKE ?)`, like, like);
    }
    // Release 1.3.1: someone without a surname sorts by their first name in its place (lib/people.ts personOrderSql).
    res.json(all<UserWithTeam>(db, `${USER_SELECT} ${where} ORDER BY ${personOrderSql('u')}`, where.params).map((u) => redactUser(me, u)));
  });

  router.get('/:id', (req, res) => {
    const user = getStaffUser(db, idParam(req));
    if (!user) throw notFound('User');
    res.json(redactUser(currentUser(req), user));
  });

  router.get('/:id/performance', (req, res) => {
    const me = currentUser(req);
    const user = getStaffUser(db, idParam(req));
    if (!user) throw notFound('User');
    // read-only for every signed-in user; personal details on the entries are stripped below unless allowed
    const today = todayISO();
    const { from, to } = parseRange(req.query, { from: mondayOf(today), to: today });
    const where = new Where().add('g.user_id = ?', user.id).add('g.date BETWEEN ? AND ?', from, to);
    const totals = totalsFor(db, where);
    const { days, ...plain } = totals;
    res.json({
      user: redactUser(me, user),
      totals: plain,
      ratios: ratiosOf(totals),
      days,
      salesPerDay: salesPerDay(totals, days),
      trend: trendFor(db, where, from, to, 'day'),
      byCampaign: summaryRows(db, 'campaign', where),
      recentEntries: listGauges(db, 'WHERE g.user_id = ?', [user.id], 'g.date DESC, g.submitted_at DESC', 10).map((e) => redactEntry(me, e)),
      punctualityRate: punctualityFor(db, where),
    });
  });

  /**
   * Add a person. Release 1.3.1: administrators as before (any role, position, team, pay plan, employee ID — now
   * optional); recruiters add trainees and field reps to any team; leaders (Team and Crew Leaders) to their own team
   * (the default). What a non-administrator may not set is refused with 403 and a sentence (shared addPersonRefusal),
   * before anything is checked or written. The 201 answer carries the new person's employee ID — this once, for the
   * recruiter or leader too, who passes on the sign-in details — and `signInInstructions`; every later read redacts it
   * as before (lib/scope.ts redactUser). Audited by the 1.2 spec (lib/auditSpecs.ts: "Added Sam Smith: Representative,
   * Trainee, Sapiens", the actor is whoever added them) and counted in the per-person write limit.
   */
  router.post('/', requireRole('admin', 'recruiter', 'leader'), (req, res) => {
    const me = currentUser(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const team = me.teamId === null ? undefined : get<{ name: string }>(db, `SELECT name FROM teams WHERE id = ?`, [me.teamId]);
    const refusal = addPersonRefusal({ role: me.role, teamId: me.teamId, teamName: team?.name ?? null }, raw);
    if (refusal) throw new HttpError(refusal.status, refusal.message, [{ path: refusal.field, message: refusal.message }]);
    const admin = me.role === 'admin';
    // empty values of the office-only fields are not attempts (shared addPersonRefusal): drop them before validating
    const fieldPerson = Object.fromEntries(
      Object.entries(raw).filter(([k, v]) => !(['role', 'payPlanId', 'status', 'avatarColor', 'employeeId'].includes(k) && (v === null || v === '' || (typeof v === 'string' && !v.trim())))),
    );
    const input = admin ? raw : { ...fieldPerson, teamId: raw.teamId ?? me.teamId ?? null };
    const parsed = createBody.safeParse(input);
    if (!parsed.success) {
      // A missing last name, and nothing else wrong, answers with its own sentence (as PATCH does), not the general
      // "Validation failed"; with other problems too, the general answer lists them all, the last name among them.
      const lastNameOnly = parsed.error.issues.every((i) => i.path[0] === 'lastName');
      if (lastNameOnly && (typeof input.lastName !== 'string' || !input.lastName.trim())) {
        throw badRequest('Enter their last name', [{ path: 'lastName', message: 'Enter their last name' }]);
      }
      throw parsed.error;
    }
    const body = parsed.data;
    if (admin && !body.role) throw badRequest('Choose a role', [{ path: 'role', message: 'Choose a role' }]);
    const role = body.role ?? 'rep';
    if (body.employeeId && get(db, `SELECT 1 FROM users WHERE lower(employee_id) = lower(?)`, [body.employeeId])) throw conflict(`Employee ID ${body.employeeId} is already in use`);
    if (get(db, `SELECT 1 FROM users WHERE lower(email) = lower(?)`, [body.email])) throw conflict(`Email ${body.email} is already in use`);
    if (body.teamId !== null && !get(db, `SELECT 1 FROM teams WHERE id = ?`, [body.teamId])) throw badRequest('Unknown teamId');
    const payPlanId = body.payPlanId ?? defaultPayPlanId(db, body.position);
    if (!get(db, `SELECT 1 FROM pay_plans WHERE id = ?`, [payPlanId])) throw badRequest('Unknown payPlanId');
    const employeeId = body.employeeId ?? nextEmployeeId(db);
    // Release 1.3: staff only, so client portal accounts never shift the avatar colours.
    const count = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE role <> 'client'`)!.n;
    const r = run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employeeId, body.email, body.firstName, body.lastName, role, body.position, body.teamId, payPlanId, body.startDate, body.status, body.phone, body.avatarColor ?? pickAvatarColor(Number(count)), body.city],
    );
    const created = getUser(db, r.lastInsertRowid)!;
    const result: AddPersonResult = {
      ...created,
      signInInstructions: staffSignInInstructions({
        firstName: created.firstName,
        email: created.email,
        employeeId: created.employeeId,
        teamName: created.teamName,
        signInUrl: body.signInUrl ?? null,
        pinRequired: readSecuritySettings(db).requirePin,
      }),
    };
    res.status(201).json(result);
  });

  router.patch('/:id', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    const existing = getStaffUser(db, id);
    if (!existing) throw notFound('User');
    const patch = patchBody.parse(req.body);
    if (patch.lastName === '' && existing.lastName.trim() !== '') {
      throw badRequest('Enter their last name', [{ path: 'lastName', message: 'Enter their last name' }]);
    }
    if (patch.status === 'left' && id === me.id) throw badRequest('You cannot deactivate your own account');
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
    // Deactivation revokes access at once: every live session of that user goes (authenticate also rejects any stragglers).
    if (next.status === 'left') destroyUserSessions(db, id);
    res.json(getUser(db, id));
  });

  /**
   * Lost-device recovery: an admin switches someone's two-step verification off without a code (active and pending
   * secrets, recovery codes and open challenges go) and signs them out everywhere. Admins turn their own off through
   * `POST /auth/2fa/disable`, which asks for a code, never through this route.
   */
  router.post('/:id/2fa/reset', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    if (!getStaffUser(db, id)) throw notFound('User');
    if (id === me.id) throw badRequest('Use Settings → Security to turn off your own two-step verification');
    clearTwoFactor(db, id);
    destroyUserSessions(db, id);
    res.status(204).end();
  });

  return router;
}
