import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Role, TwoFactorChallenge, UserWithTeam } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { USER_SELECT } from '../db/queries.ts';
import { badRequest, conflict, unauthorized } from '../lib/errors.ts';
import { FailureLimiter } from '../lib/limiter.ts';
import {
  assertCodeAttemptsLeft, beginSetup, clearCodeFailures, clearTwoFactor, createChallenge, deleteChallenge, enableTwoFactor,
  isTwoFactorEnabled, issueRecoveryCodes, recordChallengeAttempt, recordCodeFailure, requireChallenge, twoFactorStatus, verifySecondFactor,
} from '../lib/twofactor.ts';
import { clearSessionCookie, createSession, currentUser, destroySession, requireAuth, setSessionCookie } from '../middleware/auth.ts';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required'),
  employeeId: z.string().trim().min(1, 'Employee ID is required'),
});

/** A code as typed: whitespace is tolerated, the shape is checked by the verifier (a malformed code is simply wrong). */
const codeField = z.string().trim().min(1, 'Code is required').max(64);
const codeBody = z.object({ code: codeField });
/** Either a current authenticator code or a recovery code; at least one. */
const secondFactorFields = {
  code: codeField.optional(),
  recoveryCode: codeField.optional(),
};
const needsOneFactor = (b: { code?: string; recoveryCode?: string }) => b.code !== undefined || b.recoveryCode !== undefined;
const ONE_FACTOR_MESSAGE = { message: 'Provide a code or a recovery code', path: ['code'] };
const disableBody = z.object(secondFactorFields).refine(needsOneFactor, ONE_FACTOR_MESSAGE);
const loginTwoFactorBody = z.object({ challengeToken: z.string().trim().min(1, 'Challenge token is required').max(128), ...secondFactorFields }).refine(needsOneFactor, ONE_FACTOR_MESSAGE);

/** The four demo accounts from docs/API.md, in role order. */
const DEMO: { employeeId: string; role: Role; label: string }[] = [
  { employeeId: 'LM-0001', role: 'admin', label: 'Owner' },
  { employeeId: 'LM-0002', role: 'leader', label: 'Crew Leader' },
  { employeeId: 'LM-0003', role: 'recruiter', label: 'Recruiter' },
  { employeeId: 'LM-0010', role: 'rep', label: 'Field Rep' },
];

// ── login rate limit ──
// Failed sign-ins are counted twice: per (source address, email) — 8 in 15 minutes locks that source for that email —
// and per email from anywhere (a backstop against an attacker rotating addresses). The source is the TCP peer
// (`req.socket.remoteAddress`), never a header the client can forge; with TRUST_PROXY set, req.ip would follow
// X-Forwarded-For, but the limiter deliberately stays on the socket address. Both maps are bounded LRUs (10k keys)
// swept every five minutes off the request path.
export const LOGIN_MAX_FAILURES = 8;
export const LOGIN_MAX_FAILURES_PER_EMAIL = 20;
export const LOGIN_WINDOW_MS = 15 * 60_000;
const loginBySource = new FailureLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);
const loginByEmail = new FailureLimiter(LOGIN_MAX_FAILURES_PER_EMAIL, LOGIN_WINDOW_MS);

/** The TCP peer address of a request (what the limiters key on). */
export function clientSource(req: Request): string {
  return req.socket?.remoteAddress ?? 'unknown';
}

interface LoginKeys { source: string; email: string }

function loginKeys(req: Request, email: string): LoginKeys {
  const e = email.trim().toLowerCase();
  return { source: `${clientSource(req)}|${e}`, email: e };
}

/** Throws 429 when either the (source, email) pair or the email as a whole has exhausted its attempts. */
function assertLoginAllowed(keys: LoginKeys, now: number): void {
  loginBySource.assertAllowed(keys.source, now);
  loginByEmail.assertAllowed(keys.email, now);
}

function recordLoginFailure(keys: LoginKeys, now: number): void {
  loginBySource.record(keys.source, now);
  loginByEmail.record(keys.email, now);
}

function clearLoginFailures(keys: LoginKeys): void {
  loginBySource.clear(keys.source);
  loginByEmail.clear(keys.email);
}

/** Test hook: forget every recorded failure. */
export function resetLoginFailures(): void {
  loginBySource.reset();
  loginByEmail.reset();
}

const WRONG_CODE = 'That code is not valid';
/** One message for an unknown email, a wrong ID and a deactivated account: the response never confirms a credential. */
export const INVALID_LOGIN = 'Invalid email or employee ID';

export function authRouter(db: Db): Router {
  const router = Router();

  const userById = (id: number) => get<UserWithTeam>(db, `${USER_SELECT} WHERE u.id = ?`, [id]);
  const withFlag = (user: UserWithTeam, twoFactorEnabled: boolean): UserWithTeam => ({ ...user, twoFactorEnabled });

  /**
   * Shared by every endpoint that checks a second factor for a signed-in user: the limiters first, then the code;
   * a miss is counted and answered with `status` (400 in settings, 401 at login). Never logs the code.
   */
  function checkFactor(userId: number, source: string, input: { code?: string; recoveryCode?: string }, status: 400 | 401, onFailure?: () => void): void {
    assertCodeAttemptsLeft(userId, source);
    if (verifySecondFactor(db, userId, input)) {
      clearCodeFailures(userId, source);
      return;
    }
    recordCodeFailure(userId, source);
    onFailure?.();
    throw status === 401 ? unauthorized(WRONG_CODE) : badRequest(WRONG_CODE);
  }

  router.post('/login', (req, res) => {
    const { email, employeeId } = loginSchema.parse(req.body);
    const keys = loginKeys(req, email);
    const now = Date.now();
    assertLoginAllowed(keys, now);
    const user = get<UserWithTeam>(
      db,
      `${USER_SELECT} WHERE lower(u.email) = lower(?) AND lower(u.employee_id) = lower(?)`,
      [email, employeeId],
    );
    if (!user || user.status === 'left') {
      recordLoginFailure(keys, now);
      throw unauthorized(INVALID_LOGIN);
    }
    if (isTwoFactorEnabled(db, user.id)) {
      // Step one of two: no cookie yet, and the login counters keep running until the code is right.
      const challenge: TwoFactorChallenge = { requiresTwoFactor: true, challengeToken: createChallenge(db, user.id), method: 'totp' };
      return res.json(challenge);
    }
    clearLoginFailures(keys); // a successful sign-in resets the counters
    const token = createSession(db, user.id);
    setSessionCookie(req, res, token);
    res.json({ user: withFlag(user, false) });
  });

  /** Step two: the challenge token from `/login` plus a current code or an unused recovery code. */
  router.post('/login/2fa', (req, res) => {
    const body = loginTwoFactorBody.parse(req.body);
    const challenge = requireChallenge(db, body.challengeToken); // 410 when unknown, used, expired or exhausted
    const user = userById(challenge.userId);
    if (!user || user.status === 'left') {
      deleteChallenge(db, challenge.token);
      throw unauthorized(INVALID_LOGIN);
    }
    const keys = loginKeys(req, user.email);
    const now = Date.now();
    assertLoginAllowed(keys, now);
    checkFactor(user.id, clientSource(req), body, 401, () => {
      recordLoginFailure(keys, now); // a wrong code counts against the login limiter too
      recordChallengeAttempt(db, challenge.token);
    });
    deleteChallenge(db, challenge.token);
    clearLoginFailures(keys);
    const token = createSession(db, user.id);
    setSessionCookie(req, res, token);
    res.json({ user: withFlag(user, true) });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionToken) destroySession(db, req.sessionToken);
    clearSessionCookie(req, res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: currentUser(req) });
  });

  // ── two-step verification (signed in) ──

  router.get('/2fa', requireAuth, (req, res) => {
    res.json(twoFactorStatus(db, currentUser(req).id));
  });

  router.post('/2fa/setup', requireAuth, async (req, res) => {
    res.status(201).json(await beginSetup(db, currentUser(req).id)); // 409 when already on
  });

  router.post('/2fa/enable', requireAuth, (req, res) => {
    const me = currentUser(req);
    const source = clientSource(req);
    const { code } = codeBody.parse(req.body);
    assertCodeAttemptsLeft(me.id, source);
    const recoveryCodes = enableTwoFactor(db, me.id, code, req.sessionToken); // 409 when nothing pending / already on
    if (!recoveryCodes) {
      recordCodeFailure(me.id, source);
      throw badRequest(WRONG_CODE);
    }
    clearCodeFailures(me.id, source);
    res.json({ recoveryCodes });
  });

  router.post('/2fa/disable', requireAuth, (req, res) => {
    const me = currentUser(req);
    const body = disableBody.parse(req.body);
    if (!isTwoFactorEnabled(db, me.id)) throw conflict('Two-step verification is not on');
    checkFactor(me.id, clientSource(req), body, 400);
    clearTwoFactor(db, me.id);
    res.status(204).end();
  });

  router.post('/2fa/recovery-codes', requireAuth, (req, res) => {
    const me = currentUser(req);
    const { code } = codeBody.parse(req.body);
    if (!isTwoFactorEnabled(db, me.id)) throw conflict('Two-step verification is not on');
    checkFactor(me.id, clientSource(req), { code }, 400);
    res.json({ recoveryCodes: issueRecoveryCodes(db, me.id) });
  });

  /**
   * Public: the login page needs these before any session exists. The response is the login credential of four
   * people, so it is only ever the four *seeded* demo accounts: when any of them is missing, deactivated or has a
   * different role (a real deployment), or when `LM_DEMO_ACCOUNTS=0`, the list is empty. There is no fallback.
   */
  router.get('/demo-accounts', (_req, res) => {
    if (process.env.LM_DEMO_ACCOUNTS === '0') return res.json({ accounts: [] });
    const rows = all<UserWithTeam>(db, `${USER_SELECT} WHERE upper(u.employee_id) IN ('LM-0001', 'LM-0002', 'LM-0003', 'LM-0010')`);
    const accounts: { label: string; role: Role; email: string; employeeId: string }[] = [];
    for (const d of DEMO) {
      const u = rows.find((r) => r.employeeId.toUpperCase() === d.employeeId);
      if (!u || u.status === 'left' || u.role !== d.role) return res.json({ accounts: [] });
      accounts.push({ label: `${u.firstName} ${u.lastName} (${d.label})`, role: u.role, email: u.email, employeeId: u.employeeId });
    }
    res.json({ accounts });
  });

  return router;
}
