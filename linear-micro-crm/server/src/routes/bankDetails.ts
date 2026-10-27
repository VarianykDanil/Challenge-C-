/**
 * Release 1.4 — OWNED BY F payments-foundation: bank details (lib/payments/bankDetails.ts), always masked.
 *
 *  - myBankDetailsRouter, mounted at /me: GET /me/bank-details and PUT /me/bank-details — every staff role, their own
 *    (client accounts never reach it: the client guard answers 403 first).
 *  - userBankDetailsRouter, mounted at /users before the users router (it answers only these paths):
 *    GET / PUT /users/:id/bank-details and POST /users/:id/bank-details/confirm — administrators only. Confirm takes
 *    the `changedAt` of the details the admin checked (optional): changed again since → 409, nothing confirmed.
 * A change needs the changer's current two-step code when they have two-step verification on; an administrator typing in
 * someone else's details, and every administrator's confirmation, always needs a fresh code (MON-3).
 * POST /me/bank-details/confirm ("yes, these are mine", for details someone else typed in) and
 * POST /me/bank-details/report ("these are not mine"). Audit specs: lib/audit/paymentSpecs.ts (never the numbers).
 * Write limit: middleware/writeLimit.ts.
 */
import { Router, type Request } from 'express';
import { validateBankDetails, type BankDetailsInput } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { badRequest } from '../lib/errors.ts';
import { idParam } from '../lib/validate.ts';
import { assertBankDetailsAccess, assertMayConfirm, bankDetailsView, confirmBankDetails, confirmOwnBankDetails, reportBankDetails, saveBankDetails } from '../lib/payments/bankDetails.ts';
import { assertFreshCode, codeSource } from '../lib/payments/code.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const input = (raw: unknown): Partial<BankDetailsInput> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<BankDetailsInput>;

function save(db: Db, req: Request, targetId: number) {
  const me = currentUser(req);
  assertBankDetailsAccess(db, me, targetId);
  const b = input(req.body);
  // the fields first, so a typing mistake never uses up a two-step code
  const checked = validateBankDetails({ holderName: b.holderName, sortCode: b.sortCode, accountNumber: b.accountNumber });
  if (!checked.ok) throw badRequest(checked.errors[0]!.message, checked.errors);
  // typing in someone else's details always needs the administrator's fresh code (MON-3)
  assertFreshCode(db, me, b.code, codeSource(req), { required: me.id !== targetId });
  return saveBankDetails(db, me, targetId, checked.value).view;
}

/** The `changedAt` the client showed (optional), as text. */
function changedAtOf(body: unknown): string | undefined {
  const raw = (body && typeof body === 'object' && !Array.isArray(body) ? (body as { changedAt?: unknown }).changedAt : undefined) ?? undefined;
  if (raw !== undefined && typeof raw !== 'string') throw badRequest('changedAt must be the time the details were changed, as text');
  return raw;
}

export function myBankDetailsRouter(db: Db): Router {
  const router = Router();
  router.get('/bank-details', (req, res) => {
    const me = currentUser(req);
    assertBankDetailsAccess(db, me, me.id);
    res.json(bankDetailsView(db, me, me.id));
  });
  router.put('/bank-details', (req, res) => {
    res.json(save(db, req, currentUser(req).id));
  });
  // MON-3: "yes, these are mine" — details someone else typed in (confirmed if they were waiting; the notice goes)
  router.post('/bank-details/confirm', (req, res) => {
    const me = currentUser(req);
    assertBankDetailsAccess(db, me, me.id);
    const changedAt = changedAtOf(req.body);
    assertMayConfirm(db, me, me.id);
    assertFreshCode(db, me, input(req.body).code, codeSource(req), { required: false });
    res.json(confirmOwnBankDetails(db, me, changedAt).view);
  });
  // MON-3: "these are not my details" — held for every payment, the office is told
  router.post('/bank-details/report', (req, res) => {
    const me = currentUser(req);
    assertBankDetailsAccess(db, me, me.id);
    const raw = (req.body && typeof req.body === 'object' ? (req.body as { note?: unknown }).note : undefined) ?? '';
    if (typeof raw !== 'string') throw badRequest('The note must be text');
    const note = raw.trim();
    if (note.length > 300) throw badRequest('Keep the note under 300 characters');
    res.json(reportBankDetails(db, me, note || null));
  });
  return router;
}

export function userBankDetailsRouter(db: Db): Router {
  const router = Router();
  router.get('/:id/bank-details', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    assertBankDetailsAccess(db, me, id);
    res.json(bankDetailsView(db, me, id));
  });
  router.put('/:id/bank-details', requireRole('admin'), (req, res) => {
    res.json(save(db, req, idParam(req)));
  });
  router.post('/:id/bank-details/confirm', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const id = idParam(req);
    assertBankDetailsAccess(db, me, id);
    // review fix (cross:X-2): the client sends the changedAt of the details it showed; changed again since → 409
    const changedAt = changedAtOf(req.body);
    // MON-3: never the administrator who changed them, and always with a fresh code (checked before the code is used)
    assertMayConfirm(db, me, id);
    assertFreshCode(db, me, input(req.body).code, codeSource(req), { required: true });
    res.json(confirmBankDetails(db, me, id, changedAt).view);
  });
  return router;
}
