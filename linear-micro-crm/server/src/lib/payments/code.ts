/**
 * Release 1.4 — OWNED BY F payments-foundation: the fresh two-step code a payment approval (always) and a bank details
 * change (when the person has two-step verification on) need. A current code from the authenticator app only — not a
 * recovery code — and, as at sign-in, a code is accepted once (lib/twofactor.ts verifySecondFactor stores its time
 * step) and wrong codes count towards the same limiter (6 per source and person in 10 minutes → 429).
 */
import type { Request } from 'express';
import type { UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { HttpError, badRequest } from '../errors.ts';
import { assertCodeAttemptsLeft, clearCodeFailures, isTwoFactorEnabled, recordCodeFailure, verifySecondFactor } from '../twofactor.ts';

export const CODE_NEEDED_MESSAGE = 'Type the 6-digit code from your authenticator app';
export const WRONG_PAYMENT_CODE_MESSAGE = 'That code is not right. Codes change every 30 seconds and each one works once: wait for the next one and try again.';
export const TWO_FACTOR_FOR_PAYMENTS_MESSAGE = 'Set up two-step verification in Settings → Security first: every payment needs a code from your authenticator app.';

/** The caller's address for the code limiter (the socket's, or req.ip behind a trusted proxy — as at sign-in). */
export function codeSource(req: Request): string {
  const behindTrustedProxy = Boolean(req.app?.get('trust proxy'));
  return (behindTrustedProxy ? req.ip : undefined) ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Checks `code` for `me`. `required`: the action always needs two-step verification (paying people) — 403 with
 * `twoFactorRequired` when it is not set up; otherwise a person without two-step passes with no code.
 */
export function assertFreshCode(db: Db, me: UserWithTeam, code: unknown, source: string, opts: { required: boolean }): void {
  if (!isTwoFactorEnabled(db, me.id)) {
    if (opts.required) throw new HttpError(403, TWO_FACTOR_FOR_PAYMENTS_MESSAGE, { code: 'two_factor_required', twoFactorRequired: true });
    return;
  }
  const typed = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(typed)) throw badRequest(CODE_NEEDED_MESSAGE, [{ path: 'code', message: CODE_NEEDED_MESSAGE }]);
  assertCodeAttemptsLeft(me.id, source);
  if (verifySecondFactor(db, me.id, { code: typed }) !== 'totp') {
    recordCodeFailure(me.id, source);
    throw badRequest(WRONG_PAYMENT_CODE_MESSAGE, [{ path: 'code', message: WRONG_PAYMENT_CODE_MESSAGE }]);
  }
  clearCodeFailures(me.id, source);
}
