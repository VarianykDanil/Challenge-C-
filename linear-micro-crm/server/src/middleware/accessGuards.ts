/**
 * Two guards app.ts mounts on the API by route, so the routers behind them (bank details, payments) need not know:
 *
 *  - secureOnly: money and secret actions are refused over plain http from another device (lib/secureRequest.ts):
 *    entering, changing, confirming or reporting bank details, approving or downloading a payment, adding or changing a
 *    payment connection (its keys, its 1p test file, or switching it to live), the two-approvals setting, confirming a
 *    VAT number, freeing the weeks of a downloaded bank file, and anything that shows a setup code or recovery codes.
 *    The office computer itself (loopback) and https (built in, or at the trusted proxy) are allowed.
 *  - demoGuard: during the trial a one-tap demo account or one of the demo company's people (lib/trial.ts
 *    isRestrictedDemo) writes only what lib/demoWrites.ts lists: its own account, the demo company and new records,
 *    never a person of the office's own, anyone's pay but the demo company's, payments or office-wide money and
 *    security settings; and it never reads a real person's bank details or a payment file.
 *
 * Both run after `authenticate` and only for a signed-in caller (an anonymous request still gets its 401 from the
 * router), and before the write limit and the audit recorder, so a refusal is neither counted nor recorded as a change.
 */
import type { Request, RequestHandler } from 'express';
import { ACCESS_MESSAGES } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { isSecureRequest } from '../lib/secureRequest.ts';
import { demoRefusalFor } from '../lib/demoWrites.ts';
import { demoRefusal, isRestrictedDemo } from '../lib/trial.ts';

/** [method, path] and, for a route that is only sometimes a money action, which requests (by their JSON body). */
type Rule = readonly [method: string, path: RegExp, when?: (body: Record<string, unknown>) => boolean];

/** The request carries a typed confirmation or a two-step code (cancel or mark-paid after a bank file's download). */
const confirming = (body: Record<string, unknown>) => body.confirm !== undefined || body.code !== undefined;

const ID = '\\d+';
/** Paths are relative to /api, as Express gives them to the API router, compared lower case without a trailing slash. */
export const SECURE_ONLY_ROUTES: readonly Rule[] = [
  ['PUT', /^\/me\/bank-details$/],
  ['PUT', new RegExp(`^/users/${ID}/bank-details$`)],
  ['POST', new RegExp(`^/users/${ID}/bank-details/confirm$`)],
  ['POST', new RegExp(`^/payments/batches/${ID}/approve$`)],
  ['GET', new RegExp(`^/payments/batches/${ID}/file$`)],
  ['POST', /^\/payments\/connections$/],
  ['PATCH', new RegExp(`^/payments/connections/${ID}$`)],
  ['POST', new RegExp(`^/users/${ID}/setup-code$`)],
  ['POST', new RegExp(`^/users/${ID}/2fa/reset$`)],
  ['POST', new RegExp(`^/auth/pin/reset/${ID}$`)],
  ['POST', new RegExp(`^/client-accounts/${ID}/reset-2fa$`)],
  ['POST', new RegExp(`^/client-accounts/${ID}/reset-pin$`)],
  ['POST', /^\/auth\/2fa\/recovery-codes$/],
  // 1.5 (money): the person's own answer about details someone else typed in (MON-3), an administrator confirming a
  // VAT number (MON-7), "two people approve each payment" (MONEY-MISSED-2), the 1p test file (it holds a full account
  // number) and its result (MON-6), and saying a downloaded bank file was not uploaded or not paid, which frees those
  // weeks to be paid again (MON-2: the typed confirmation with a fresh code)
  ['POST', /^\/me\/bank-details\/confirm$/],
  ['POST', /^\/me\/bank-details\/report$/],
  ['POST', new RegExp(`^/invoices/profile/${ID}/vat/confirm$`)],
  ['PUT', /^\/payments\/settings$/],
  ['POST', new RegExp(`^/payments/connections/${ID}/test-file$`)],
  ['POST', new RegExp(`^/payments/connections/${ID}/test-file-result$`)],
  ['POST', new RegExp(`^/payments/batches/${ID}/cancel$`), confirming],
  ['POST', new RegExp(`^/payments/batches/${ID}/mark-paid$`), confirming],
];

const normalPath = (req: Request) => req.path.toLowerCase().replace(/\/+$/, '') || '/';
const bodyOf = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
const matches = (rules: readonly Rule[], req: Request) => {
  const p = normalPath(req);
  return rules.some(([m, re, when]) => m === req.method && re.test(p) && (!when || when(bodyOf(req))));
};

export function secureOnly(): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || isSecureRequest(req) || !matches(SECURE_ONLY_ROUTES, req)) return next();
    next(new HttpError(403, ACCESS_MESSAGES.insecure, { code: 'insecure_connection' }));
  };
}

export function demoGuard(db: Db): RequestHandler {
  return (req, _res, next) => {
    const me = req.user;
    if (!me || !isRestrictedDemo(db, me)) return next();
    const refused = demoRefusalFor(db, me, req.method, normalPath(req), req.body);
    next(refused ? demoRefusal(refused) : undefined);
  };
}
