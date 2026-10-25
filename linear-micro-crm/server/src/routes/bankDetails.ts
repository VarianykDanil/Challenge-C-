/**
 * Release 1.4 — OWNED BY F payments-foundation: bank details (lib/payments/bankDetails.ts), always masked.
 *
 *  - myBankDetailsRouter, mounted at /me: GET /me/bank-details and PUT /me/bank-details — every staff role, their own
 *    (client accounts never reach it: the client guard answers 403 first).
 *  - userBankDetailsRouter, mounted at /users before the users router (it answers only these paths):
 *    GET / PUT /users/:id/bank-details and POST /users/:id/bank-details/confirm — administrators only.
 * A change needs the changer's current two-step code when they have two-step verification on. Audit specs:
 * lib/audit/paymentSpecs.ts (never the numbers). Write limit: middleware/writeLimit.ts.
 */
import { Router, type Request } from 'express';
import { validateBankDetails, type BankDetailsInput } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { badRequest } from '../lib/errors.ts';
import { idParam } from '../lib/validate.ts';
import { assertBankDetailsAccess, bankDetailsView, confirmBankDetails, saveBankDetails } from '../lib/payments/bankDetails.ts';
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
  assertFreshCode(db, me, b.code, codeSource(req), { required: false });
  return saveBankDetails(db, me, targetId, checked.value).view;
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
    res.json(confirmBankDetails(db, me, id).view);
  });
  return router;
}
