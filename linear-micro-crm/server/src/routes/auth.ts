import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  PIN_LOCK_AFTER_FAILURES, PIN_PROBLEM_MESSAGES, SESSION_IDLE_HOURS_MAX, SESSION_IDLE_HOURS_MIN, pinProblem,
  type LoginPinChallenge, type LoginPinDetails, type LoginPinReason, type LoginPinRequired, type Role, type TwoFactorChallenge,
  type UserWithTeam,
} from '@lm/shared';
import { all, get, run, transaction, type Db } from '../db/connection.ts';
import { USER_SELECT } from '../db/queries.ts';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../lib/errors.ts';
import { FailureLimiter } from '../lib/limiter.ts';
import {
  accountFlags, clearPin, clearPinFailures, countPinAttempt, hashPin, isPinLocked, pinAttemptsLeft, pinRow, pinStatusFor,
  readSecuritySettings, savePinHash, verifyPin, writeSecuritySettings, type PinRow,
} from '../lib/pin.ts';
import {
  assertCodeAttemptsLeft, beginSetup, clearCodeFailures, clearTwoFactor, createChallenge, deleteChallenge, enableTwoFactor,
  isTwoFactorEnabled, issueRecoveryCodes, recordChallengeAttempt, recordCodeFailure, requireChallenge, twoFactorStatus, verifySecondFactor,
} from '../lib/twofactor.ts';
import { idParam } from '../lib/validate.ts';
import {
  clearSessionCookie, createSession, currentUser, destroyOtherSessions, destroySession, destroyUserSessions, requireAuth, requireRole, setSessionCookie,
} from '../middleware/auth.ts';

/** A PIN as typed (the rules are checked by the shared `pinProblem` and by the hash). */
const pinField = z.string().trim().max(32);

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required'),
  employeeId: z.string().trim().min(1, 'Employee ID is required'),
  /** Release 1.2 (U1): required once the person has a PIN; ignored for an account without one. */
  pin: pinField.optional(),
});

const setPinBody = z.object({ pin: pinField, currentPin: pinField.optional() });
const removePinBody = z.object({ currentPin: pinField });
const securitySettingsBody = z
  .object({
    requirePin: z.boolean().optional(),
    requireAdminTwoFactor: z.boolean().optional(),
    sessionIdleHours: z.number().int('Whole hours only').min(SESSION_IDLE_HOURS_MIN).max(SESSION_IDLE_HOURS_MAX).optional(),
  })
  .strict();

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

// ── PIN checks while signed in (change or remove your PIN) ──
// Wrong current PINs count towards the person's PIN lock (the same count as at sign-in) and, as a quicker brake,
// 6 per user in 15 minutes → 429.
export const PIN_CHANGE_MAX_FAILURES = 6;
const pinChangeByUser = new FailureLimiter(PIN_CHANGE_MAX_FAILURES, LOGIN_WINDOW_MS);

/** Test hook: forget every recorded failure. */
export function resetLoginFailures(): void {
  loginBySource.reset();
  loginByEmail.reset();
  pinChangeByUser.reset();
}

const WRONG_CODE = 'That code is not valid';
/** One message for an unknown email, a wrong ID and a deactivated account: the response never confirms a credential. */
export const INVALID_LOGIN = 'Invalid email or employee ID';
export const PIN_MESSAGES = {
  wrong: 'That PIN is not right',
  locked: 'Your PIN is locked after too many wrong tries. Ask an administrator to reset it.',
  wrongCurrent: 'Your current PIN is not right',
  currentNeeded: 'Enter your current PIN',
  sameAsCurrent: 'That is your current PIN. Pick a new one.',
} as const;

/** 401 (wrong) or 423 (locked) with the LoginPinRequired body; `details` repeats it for the client's ApiError. */
function sendPinRequired(res: Response, reason: LoginPinReason, attemptsLeft?: number): void {
  const details: LoginPinDetails = reason === 'locked' ? { requiresPin: true, reason } : { requiresPin: true, reason, attemptsLeft };
  const body: LoginPinRequired = { error: PIN_MESSAGES[reason], requiresPin: true, details };
  res.status(reason === 'locked' ? 423 : 401).json(body);
}

export function authRouter(db: Db): Router {
  const router = Router();

  const userById = (id: number) => get<UserWithTeam>(db, `${USER_SELECT} WHERE u.id = ?`, [id]);
  /** The signed-in person's own flags on a login response (the same ones `authenticate` puts on /auth/me). */
  const withFlags = (user: UserWithTeam, twoFactorEnabled: boolean): UserWithTeam => ({
    ...user,
    twoFactorEnabled,
    ...accountFlags(readSecuritySettings(db), { role: user.role, hasPin: Boolean(pinRow(db, user.id)?.hash), twoFactorEnabled }),
  });

  /**
   * Checks the current PIN of a signed-in person (change or remove). Locked → 423; wrong → 400 (423 when that was the
   * last try). The attempt is counted before the hash is awaited and cleared when it matches.
   */
  async function checkCurrentPin(userId: number, row: PinRow, candidate: string | undefined): Promise<void> {
    if (isPinLocked(row)) throw new HttpError(423, PIN_MESSAGES.locked);
    if (!candidate) throw badRequest(PIN_MESSAGES.currentNeeded, [{ path: 'currentPin', message: PIN_MESSAGES.currentNeeded }]);
    const key = String(userId);
    pinChangeByUser.assertAllowed(key);
    pinChangeByUser.record(key);
    const failures = countPinAttempt(db, userId);
    if (!(await verifyPin(row.hash ?? '', candidate))) {
      if (failures >= PIN_LOCK_AFTER_FAILURES) throw new HttpError(423, PIN_MESSAGES.locked);
      throw badRequest(PIN_MESSAGES.wrongCurrent, [{ path: 'currentPin', message: PIN_MESSAGES.wrongCurrent }]);
    }
    pinChangeByUser.clear(key);
    clearPinFailures(db, userId);
  }

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

  router.post('/login', async (req, res) => {
    const { email, employeeId, pin } = loginSchema.parse(req.body);
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
    // Release 1.2 (U1): an account with a PIN needs it too. Every stop here counts against the login limiter, like a
    // wrong employee ID; a wrong PIN also counts towards the PIN lock (PIN_LOCK_AFTER_FAILURES in a row).
    const pinState = pinRow(db, user.id);
    if (pinState?.hash) {
      if (isPinLocked(pinState)) {
        recordLoginFailure(keys, now);
        return sendPinRequired(res, 'locked');
      }
      if (!pin) {
        // Step two of the sign-in (no cookie yet), answered 200 like the two-step challenge.
        recordLoginFailure(keys, now);
        const challenge: LoginPinChallenge = { requiresPin: true, attemptsLeft: pinAttemptsLeft(pinState) };
        return res.json(challenge);
      }
      // Counted before the hash is awaited, so a burst of parallel guesses meets both limits one request at a time;
      // a right PIN clears the PIN count (and the login counters below, once the sign-in completes).
      recordLoginFailure(keys, now);
      const failures = countPinAttempt(db, user.id);
      if (!(await verifyPin(pinState.hash, pin))) {
        const left = PIN_LOCK_AFTER_FAILURES - failures;
        return left > 0 ? sendPinRequired(res, 'wrong', left) : sendPinRequired(res, 'locked');
      }
      clearPinFailures(db, user.id);
    }
    if (isTwoFactorEnabled(db, user.id)) {
      // Step one of two: no cookie yet, and the login counters keep running until the code is right.
      const challenge: TwoFactorChallenge = { requiresTwoFactor: true, challengeToken: createChallenge(db, user.id), method: 'totp' };
      return res.json(challenge);
    }
    clearLoginFailures(keys); // a successful sign-in resets the counters
    const token = createSession(db, user.id);
    setSessionCookie(req, res, token);
    res.json({ user: withFlags(user, false) });
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
    res.json({ user: withFlags(user, true) });
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
    // Release 1.2 (U1): while the admin rule holds, an administrator keeps two-step verification on.
    if (me.role === 'admin' && readSecuritySettings(db).requireAdminTwoFactor) {
      throw conflict('Two-step verification is required for administrators. Switch that rule off in Settings → Security first.');
    }
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

  // ── Release 1.2 (U1): sign-in PIN ──

  router.get('/pin', requireAuth, (req, res) => {
    res.json(pinStatusFor(db, currentUser(req).id));
  });

  /** Set a first PIN, or change it with the current one. Signs out every other session of the person. */
  router.post('/pin', requireAuth, async (req, res) => {
    const me = currentUser(req);
    const body = setPinBody.parse(req.body);
    const problem = pinProblem(body.pin, { employeeId: me.employeeId });
    if (problem) throw badRequest(PIN_PROBLEM_MESSAGES[problem], [{ path: 'pin', message: PIN_PROBLEM_MESSAGES[problem] }]);
    const row = pinRow(db, me.id);
    if (row?.hash) {
      await checkCurrentPin(me.id, row, body.currentPin);
      if (await verifyPin(row.hash, body.pin)) throw badRequest(PIN_MESSAGES.sameAsCurrent, [{ path: 'pin', message: PIN_MESSAGES.sameAsCurrent }]);
    }
    const hash = await hashPin(body.pin);
    transaction(db, () => {
      savePinHash(db, me.id, hash);
      destroyOtherSessions(db, me.id, req.sessionToken);
    });
    res.status(204).end();
  });

  /** Remove your own PIN (asks for it); refused while the admin requires a PIN for everyone. */
  router.post('/pin/remove', requireAuth, async (req, res) => {
    const me = currentUser(req);
    const { currentPin } = removePinBody.parse(req.body);
    if (readSecuritySettings(db).requirePin) throw conflict('A PIN is required for everyone, so it cannot be removed. You can change it instead.');
    const row = pinRow(db, me.id);
    if (!row?.hash) throw conflict('You have no PIN to remove');
    await checkCurrentPin(me.id, row, currentPin);
    clearPin(db, me.id);
    res.status(204).end();
  });

  /** Admin: anyone's PIN state (set, when, locked), never the PIN. */
  router.get('/pin/:userId', requireRole('admin'), (req, res) => {
    const status = pinStatusFor(db, idParam(req, 'userId'));
    if (!status) throw notFound('User');
    res.json(status);
  });

  /** Admin: a forgotten or locked PIN. Clears it and its lock and signs the person out everywhere. */
  router.post('/pin/reset/:userId', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const id = idParam(req, 'userId');
    if (!userById(id)) throw notFound('User');
    if (id === me.id) throw badRequest('Use Settings → Security to change or remove your own PIN');
    transaction(db, () => {
      clearPin(db, id);
      destroyUserSessions(db, id);
    });
    res.status(204).end();
  });

  // ── Release 1.2 (U1): sign-in settings (admin) ──

  router.get('/security-settings', requireRole('admin'), (_req, res) => {
    res.json(readSecuritySettings(db));
  });

  /**
   * Partial update. Switching on a rule that would shut out the admin making the change is refused (409): set your own
   * PIN before requiring one, turn on your own two-step verification before requiring it. Requiring two-step
   * verification signs out the other administrators who have not set it up, so they meet the setup step at sign-in.
   */
  router.put('/security-settings', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const patch = securitySettingsBody.parse(req.body);
    const before = readSecuritySettings(db);
    if (patch.requirePin && !before.requirePin && !me.hasPin) {
      throw conflict('Set your own PIN first, so the new rule cannot lock you out.');
    }
    if (patch.requireAdminTwoFactor && !before.requireAdminTwoFactor && !me.twoFactorEnabled) {
      throw conflict('Turn on two-step verification for yourself first, so the new rule cannot lock you out.');
    }
    const after = transaction(db, () => {
      const next = writeSecuritySettings(db, patch);
      if (next.requireAdminTwoFactor && !before.requireAdminTwoFactor) {
        run(db, `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'admin' AND totp_enabled_at IS NULL AND id <> ?)`, [me.id]);
      }
      return next;
    });
    res.json(after);
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
