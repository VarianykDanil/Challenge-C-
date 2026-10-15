import { Router } from 'express';
import { z } from 'zod';
import { POSITION_LABELS, type Role, type UserWithTeam } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { USER_SELECT } from '../db/queries.ts';
import { unauthorized } from '../lib/errors.ts';
import { clearSessionCookie, createSession, currentUser, destroySession, requireAuth, setSessionCookie } from '../middleware/auth.ts';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required'),
  employeeId: z.string().trim().min(1, 'Employee ID is required'),
});

/** The four demo accounts from docs/API.md, in role order. */
const DEMO: { employeeId: string; label: string }[] = [
  { employeeId: 'LM-0001', label: 'Owner' },
  { employeeId: 'LM-0002', label: 'Crew Leader' },
  { employeeId: 'LM-0003', label: 'Recruiter' },
  { employeeId: 'LM-0010', label: 'Field Rep' },
];

export function authRouter(db: Db): Router {
  const router = Router();

  router.post('/login', (req, res) => {
    const { email, employeeId } = loginSchema.parse(req.body);
    const user = get<UserWithTeam>(
      db,
      `${USER_SELECT} WHERE lower(u.email) = lower(?) AND lower(u.employee_id) = lower(?)`,
      [email, employeeId],
    );
    if (!user) throw unauthorized('Email and employee ID do not match');
    if (user.status === 'left') throw unauthorized('This account has been deactivated');
    const token = createSession(db, user.id);
    setSessionCookie(res, token);
    res.json({ user });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionToken) destroySession(db, req.sessionToken);
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: currentUser(req) });
  });

  // Public: the login page needs these before any session exists.
  router.get('/demo-accounts', (_req, res) => {
    const rows = all<UserWithTeam>(db, `${USER_SELECT} WHERE u.employee_id IN ('LM-0001', 'LM-0002', 'LM-0003', 'LM-0010')`);
    const seen = new Set<Role>();
    const accounts: { label: string; role: Role; email: string; employeeId: string }[] = [];
    for (const d of DEMO) {
      const u = rows.find((r) => r.employeeId === d.employeeId);
      if (!u || seen.has(u.role)) continue;
      seen.add(u.role);
      accounts.push({ label: `${u.firstName} ${u.lastName} (${d.label})`, role: u.role, email: u.email, employeeId: u.employeeId });
    }
    // Fallback for a non-demo database: one user per role.
    if (accounts.length < 4) {
      for (const role of ['admin', 'leader', 'recruiter', 'rep'] as Role[]) {
        if (seen.has(role)) continue;
        const u = get<UserWithTeam>(db, `${USER_SELECT} WHERE u.role = ? AND u.status = 'active' ORDER BY u.id LIMIT 1`, [role]);
        if (u) accounts.push({ label: `${u.firstName} ${u.lastName} (${POSITION_LABELS[u.position]})`, role, email: u.email, employeeId: u.employeeId });
      }
    }
    res.json({ accounts });
  });

  return router;
}
