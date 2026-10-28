/**
 * Two guards app.ts mounts on the API by route, so the routers behind them (bank details, payments) need not know:
 *
 *  - secureOnly: money and secret actions are refused over plain http from another device (lib/secureRequest.ts):
 *    entering or changing bank details, approving or downloading a payment, adding or changing a payment connection
 *    (its keys, or switching it to live), and anything that shows a setup code or recovery codes. The office computer
 *    itself (loopback) and https (built in, or at the trusted proxy) are allowed.
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

type Rule = readonly [method: string, path: RegExp];

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
];

const normalPath = (req: Request) => req.path.toLowerCase().replace(/\/+$/, '') || '/';
const matches = (rules: readonly Rule[], req: Request) => {
  const p = normalPath(req);
  return rules.some(([m, re]) => m === req.method && re.test(p));
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
