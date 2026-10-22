/**
 * Release 1.3 — /invoices (self-billing invoices, the agreement, the supplier profile, company settings, disputes) —
 * OWNED BY P2 invoices. Every route is behind requireAuth (app.ts); a client account never gets here (clientGuard).
 *
 *  GET  /invoices/agreement                     → SelfBillingAgreement (the current text + when I accepted it)
 *  POST /invoices/agreement/accept              → SelfBillingAgreement (records version, time, IP; once)
 *  GET  /invoices/profile, PUT /invoices/profile InvoiceProfileInput → InvoiceProfile (mine)
 *  GET  /invoices/profile/:userId, PUT …        → InvoiceProfile (admin)
 *  GET  /invoices/company                       → CompanySettings (every staff role: the customer block of an invoice)
 *  PUT  /invoices/company CompanySettingsInput  → CompanySettings (admin; signatureImage = data:image/png;base64, ≤ 200 KB)
 *  GET  /invoices/signatures/:file              → the signature PNG an invoice prints (staff)
 *  GET  /invoices/disputes                      → InvoiceDisputeRow[] (admin)
 *  GET  /invoices?from=&to=&userId=&weekStart=&status= → InvoiceListRow[] (own; leader: own team; admin: all)
 *  GET  /invoices/by-run/:runId                 → Invoice (the payslip's rule: admin, the person, their team leader)
 *  GET  /invoices/:id                           → Invoice (same rule)
 *  POST /invoices/:id/accept                    → Invoice (the supplier; needs the agreement)
 *  POST /invoices/:id/dispute  InvoiceDisputeInput → Invoice (the supplier; before the deadline, while unpaid)
 *  POST /invoices/:id/resolve  InvoiceResolveInput → Invoice (admin: 'reissue' = Fix and reissue, 'keep' = Keep as it is)
 * Types: shared/src/types/invoices.ts. Rules and the finance hooks: lib/invoices.ts. Audit specs: lib/audit/invoiceSpecs.ts.
 *
 * The writes any field person can repeat (PUT /profile, POST /agreement/accept, /:id/accept, /:id/dispute) share a
 * per-person limit of 60 a minute (middleware/writeLimit.ts's numbers and wording, its own counter): 429 after that.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { INVOICE_STATUSES, isInvoicedRole, type InvoiceStatus } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import { syncPayrollRun } from '../db/maintenance.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound, tooManyRequests } from '../lib/errors.ts';
import { FailureLimiter } from '../lib/limiter.ts';
import {
  acceptAgreement,
  acceptInvoice,
  agreementFor,
  companySettings,
  disputeInvoice,
  invoiceFor,
  invoiceProfile,
  listDisputes,
  listInvoices,
  readSignatureImage,
  resolveInvoice,
  saveCompanySettings,
  saveInvoiceProfile,
} from '../lib/invoices.ts';
import { idParam, isoDate, optionalIdQuery, optionalString, parseRange } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';
import { WRITE_LIMIT_MESSAGE, WRITE_LIMIT_PER_MINUTE, WRITE_LIMIT_WINDOW_MS } from '../middleware/writeLimit.ts';

/**
 * At most WRITE_LIMIT_PER_MINUTE of the self-service invoice writes per person in a minute (real clock, in memory; a
 * refused write does not count and is never audited). One counter per router, so per app.
 */
function selfServiceWriteLimit(perMinute = WRITE_LIMIT_PER_MINUTE): RequestHandler {
  const counter = new FailureLimiter(perMinute, WRITE_LIMIT_WINDOW_MS);
  return (req, res, next) => {
    const key = String(currentUser(req).id);
    const t = Date.now();
    if (counter.count(key, t) >= perMinute) {
      res.setHeader('Retry-After', String(WRITE_LIMIT_WINDOW_MS / 1000));
      throw tooManyRequests(WRITE_LIMIT_MESSAGE);
    }
    counter.record(key, t);
    next();
  };
}

const nullableText = (max: number) => z.string().max(max).nullable().optional();

const profileBody = z.object({
  addressLine1: nullableText(200),
  addressLine2: nullableText(200),
  addressTown: nullableText(120),
  postcode: nullableText(20),
  utr: nullableText(20),
  vatNumber: nullableText(20),
}).strict();

const companyBody = z.object({
  legalName: z.string().max(200).optional(),
  addressLines: z.array(z.string().max(200)).max(6).optional(),
  postcode: z.string().max(20).nullable().optional(),
  companyNumber: z.string().max(20).nullable().optional(),
  signatoryName: z.string().max(200).optional(),
  // ≤ 200 KB once decoded (lib/invoices.ts checks the bytes); base64 is 4/3 of that
  signatureImage: z.string().max(280_000).nullable().optional(),
}).strict();

const disputeBody = z.object({
  reason: z.string().trim().min(3, 'Say what is wrong (at least 3 characters)').max(1000),
  lines: z.array(z.object({ line: z.number().int().min(0).max(200), note: z.string().trim().max(300).optional() })).max(50).default([]),
});

const resolveBody = z.object({
  action: z.enum(['reissue', 'keep']),
  note: z.string().trim().min(3, 'Write a note for the person (at least 3 characters)').max(1000),
  adjustment: z.object({ amount: z.number().finite(), note: z.string().trim().max(300).optional() }).nullable().optional(),
});

/** The address that accepted (the TCP peer, or the client behind a trusted proxy — Express's req.ip). */
const ipOf = (req: Request): string | null => req.ip ?? req.socket?.remoteAddress ?? null;

/** Recalculates one run with the pay rules (P1's db/maintenance.ts syncPayrollRun), after a dispute correction. */
function recalculateRun(db: Db, runId: number): void {
  const u = get<{ id: number; employeeId: string; teamId: number | null; payPlanId: number; role: string; startDate: string; weekStart: string }>(
    db,
    `SELECT u.id, u.employee_id AS employeeId, u.team_id AS teamId, u.pay_plan_id AS payPlanId, u.role, u.start_date AS startDate, p.week_start AS weekStart
     FROM payroll_runs p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    [runId],
  );
  if (!u) return;
  const { weekStart, ...user } = u;
  syncPayrollRun(db, user as Parameters<typeof syncPayrollRun>[1], weekStart, todayISO());
}

export function invoicesRouter(db: Db): Router {
  const router = Router();
  const limited = selfServiceWriteLimit();

  // ── the self-billing agreement ──
  router.get('/agreement', (req, res) => {
    res.json(agreementFor(db, currentUser(req).id));
  });
  router.post('/agreement/accept', limited, (req, res) => {
    const me = currentUser(req);
    if (!isInvoicedRole(me.role)) throw forbidden('The self-billing agreement is for field staff (reps and leaders)');
    res.json(acceptAgreement(db, me.id, ipOf(req)).agreement);
  });

  // ── the supplier's details ──
  router.get('/profile', (req, res) => {
    res.json(invoiceProfile(db, currentUser(req).id));
  });
  router.put('/profile', limited, (req, res) => {
    res.json(saveInvoiceProfile(db, currentUser(req).id, profileBody.parse(req.body ?? {})));
  });
  router.get('/profile/:userId', requireRole('admin'), (req, res) => {
    const profile = invoiceProfile(db, idParam(req, 'userId'));
    if (!profile) throw notFound('User');
    res.json(profile);
  });
  router.put('/profile/:userId', requireRole('admin'), (req, res) => {
    res.json(saveInvoiceProfile(db, idParam(req, 'userId'), profileBody.parse(req.body ?? {})));
  });

  // ── Settings → Company ──
  router.get('/company', (_req, res) => {
    res.json(companySettings(db));
  });
  router.put('/company', requireRole('admin'), (req, res) => {
    res.json(saveCompanySettings(db, companyBody.parse(req.body ?? {})));
  });
  router.get('/signatures/:file', (req, res) => {
    const bytes = readSignatureImage(String(req.params.file));
    if (!bytes) throw notFound('Signature');
    // content-addressed: the bytes behind a name never change
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('png').send(bytes);
  });

  // ── the office's disputes ──
  router.get('/disputes', requireRole('admin'), (_req, res) => {
    res.json(listDisputes(db));
  });

  // ── invoices ──
  router.get('/', (req, res) => {
    const me = currentUser(req);
    const today = todayISO();
    const { from, to } = parseRange(req.query, { from: addDays(mondayOf(today), -12 * 7), to: today });
    const status = optionalString(req.query.status);
    if (status && !INVOICE_STATUSES.includes(status as InvoiceStatus)) throw badRequest('Invalid status');
    const weekStart = optionalString(req.query.weekStart);
    if (weekStart && !isoDate.safeParse(weekStart).success) throw badRequest('Invalid weekStart');
    res.json(listInvoices(db, me, {
      from, to,
      userId: optionalIdQuery(req.query.userId, 'userId') ?? null,
      weekStart: weekStart ?? null,
      status: (status as InvoiceStatus | undefined) ?? null,
    }));
  });
  router.get('/by-run/:runId', (req, res) => {
    res.json(invoiceFor(db, currentUser(req), { runId: idParam(req, 'runId') }));
  });
  router.get('/:id', (req, res) => {
    res.json(invoiceFor(db, currentUser(req), { id: idParam(req) }));
  });
  router.post('/:id/accept', limited, (req, res) => {
    res.json(acceptInvoice(db, currentUser(req), idParam(req), ipOf(req)));
  });
  router.post('/:id/dispute', limited, (req, res) => {
    const id = idParam(req);
    const body = disputeBody.parse(req.body ?? {});
    res.json(disputeInvoice(db, currentUser(req), id, { reason: body.reason, lines: body.lines.map((l) => (l.note ? { line: l.line, note: l.note } : { line: l.line })) }));
  });
  router.post('/:id/resolve', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    const body = resolveBody.parse(req.body ?? {});
    res.json(resolveInvoice(db, currentUser(req), id, body, (runId) => recalculateRun(db, runId)));
  });
  return router;
}
