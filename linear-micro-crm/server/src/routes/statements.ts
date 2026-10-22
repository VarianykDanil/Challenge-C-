/**
 * Release 1.3 — /statements (commission statements from the clients: mail settings, senders, templates, the parsed
 * statements, applying them to pay, people's client fundraiser IDs) — admin only — OWNED BY P3 statements.
 *
 *  GET    /statements?campaignId=&status=        → StatementSummary[] (newest first)
 *  GET    /statements/mail, PUT …  MailSettingsInput → MailSettings (the app password is write-only, stored encrypted)
 *  POST   /statements/mail/test                  → MailTestResult (409 when no address / app password is saved)
 *  GET    /statements/senders, PUT … StatementSender[] → StatementSender[] (PUT replaces the whole list)
 *  GET    /statements/templates/:campaignId      → StatementTemplate (404 until saved)
 *  PUT    /statements/templates/:campaignId  StatementColumnMapping → StatementTemplate (re-reads the campaign's
 *         unapplied statements with it)
 *  GET    /statements/client-refs?userId=        → ClientRef[] (everyone's without userId)
 *  PUT    /statements/client-refs/:userId  ClientRef[] (or {campaignId, ref}[]) → ClientRef[] (replaces that person's;
 *         a blank ref removes one; 409 when another person has that ID at that client; unapplied statements match again)
 *  POST   /statements/check-now                  → CheckNowResult (one Gmail check now; 409 when mail is not set up)
 *  POST   /statements/upload?fileName=&campaignId= → 201 StatementSummary. The body is the PDF itself
 *         (Content-Type: application/pdf), read on this route only with express.raw (limit STATEMENT_MAX_BYTES, 20 MB):
 *         415 for another content type, 413 over 20 MB, 422 when the bytes are not a PDF, 409 (details.statementId)
 *         when the same PDF is already stored. A PDF that cannot be read is still stored, with status 'failed'.
 *  GET    /statements/:id                        → StatementDetail
 *  GET    /statements/:id/file[?download=1]      → the PDF (inline; X-Frame-Options SAMEORIGIN + frame-ancestors 'self'
 *         so the statement page can show it in a frame; private, no-store). Audited (it lists people's earnings): a
 *         download as an export of the PDF, an inline open as the statement PDF opened (P9's recordClientEvent; the
 *         same person opening it again within a few minutes adds no row).
 *  PATCH  /statements/:id  StatementPatchInput   → StatementDetail (campaign / period; 409 once applied)
 *  DELETE /statements/:id                        → 204 (409 once applied)
 *  POST   /statements/:id/apply                  → StatementDetail (409 with the first blocker in plain words)
 *  PUT    /statements/:id/rows/:rowId  StatementRowMatchInput → StatementRow (+ rememberedRef)
 * Types: shared/src/types/statements.ts. Logic: lib/statements/*. Audit specs: lib/audit/statementSpecs.ts.
 */
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  STATEMENT_MAX_BYTES,
  STATEMENT_FIELDS,
  formatStatementPeriod,
  type ClientAuditEventInput,
  type ClientRef,
  type StatementColumnMapping,
  type StatementSender,
  type StatementStatus,
} from '@lm/shared';
import { all, get, placeholders, run, transaction, type Db } from '../db/connection.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { nowISO } from '../lib/dates.ts';
import { HttpError, badRequest, conflict, notFound, tooManyRequests } from '../lib/errors.ts';
import { FailureLimiter } from '../lib/limiter.ts';
import { idParam, isoDate } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';
import { recordClientEvent } from '../lib/audit/events.ts';
import { ensureStatementFile } from '../lib/statements/demo.ts';
import { sha256Of } from '../lib/statements/files.ts';
import { checkMail, isCheckRunning, readMailSettings, saveMailSettings, testMailConnection } from '../lib/statements/mail.ts';
import { looksLikePdf } from '../lib/statements/pdf.ts';
import {
  applyStatement,
  deleteStatement,
  existingStatement,
  ingestStatement,
  listStatements,
  loadTemplate,
  patchStatement,
  rematchCampaigns,
  rereadCampaign,
  saveTemplate,
  setRowMatch,
  statementDetail,
  statementFileInfo,
  statementSummary,
} from '../lib/statements/store.ts';

const STATUSES = ['parsed', 'needs_review', 'applied', 'failed'] as const satisfies readonly StatementStatus[];

/**
 * Re-review fix: per-person limits, counted per router (in memory, real clock; lib/limiter.ts). A Check now that
 * starts a check opens a Gmail connection (a press while one is running shares it and does not count); an upload
 * that is read costs the PDF worker up to 20 MB (a duplicate, refused before reading, does not count). The 15-minute
 * job is not limited.
 */
export const STATEMENT_CHECKS_PER_WINDOW = 12;
export const STATEMENT_UPLOADS_PER_WINDOW = 30;
export const STATEMENT_LIMIT_WINDOW_MS = 10 * 60_000;
export const STATEMENT_CHECKS_LIMIT_MESSAGE = `That is more than ${STATEMENT_CHECKS_PER_WINDOW} Gmail checks in 10 minutes. Linear Hub also checks by itself every 15 minutes, so wait a few minutes before you press Check now again.`;
export const STATEMENT_UPLOADS_LIMIT_MESSAGE = `That is more than ${STATEMENT_UPLOADS_PER_WINDOW} statement uploads in 10 minutes. Wait a few minutes, then upload the rest.`;

const listQuery = z.object({
  campaignId: z.coerce.number().int().positive().optional(),
  status: z.enum(STATUSES).optional(),
});

const email = z.string().trim().toLowerCase().max(254).email('Enter an email address, like statements@charity.org.uk');

const mailBody = z.object({
  address: z.union([z.literal(''), email]).nullable().optional(),
  appPassword: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
});

const sendersBody = z
  .array(z.object({ campaignId: z.number().int().positive(), address: email }))
  .max(200, 'At most 200 sender addresses');

const column = z.union([z.number().int().min(0).max(60), z.string().trim().min(1).max(120)]).nullable().optional();
const mappingBody = z.object(Object.fromEntries(STATEMENT_FIELDS.map((f) => [f, column])) as Record<(typeof STATEMENT_FIELDS)[number], typeof column>);

const refsBody = z
  .array(z.object({ userId: z.number().int().positive().optional(), campaignId: z.number().int().positive(), ref: z.string().trim().max(40, 'A fundraiser ID is at most 40 characters') }))
  .max(50);

const rowBody = z.object({ userId: z.number().int().positive().nullable() });

const patchBody = z.object({
  campaignId: z.number().int().positive().nullable().optional(),
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate.nullable().optional(),
});

const uploadQuery = z.object({
  fileName: z.string().max(200).optional(),
  campaignId: z.coerce.number().int().positive().optional(),
});

/** A file name safe to store and to send back in Content-Disposition. */
function safeFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!clean) return 'statement.pdf';
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
}

const rawPdf = express.raw({ type: 'application/pdf', limit: STATEMENT_MAX_BYTES });

/** The PDF body, on the upload route only (the app-wide JSON parser leaves application/pdf alone). */
const readPdfBody: RequestHandler = (req, res, next) => {
  rawPdf(req, res, (err?: unknown) => {
    const e = err as { type?: string } | undefined;
    if (e?.type === 'entity.too.large') return next(new HttpError(413, 'This PDF is over 20 MB. Ask the client for a smaller copy.'));
    next(err);
  });
};

function campaignExists(db: Db, id: number): boolean {
  return Boolean(get<{ id: number }>(db, `SELECT id FROM campaigns WHERE id = ?`, [id]));
}

function sendersOf(db: Db): StatementSender[] {
  return all<StatementSender>(db, `SELECT campaign_id AS campaignId, address FROM campaign_statement_senders ORDER BY campaign_id, address`);
}

function refsOf(db: Db, userId?: number): ClientRef[] {
  return userId
    ? all<ClientRef>(db, `SELECT user_id AS userId, campaign_id AS campaignId, ref FROM user_client_refs WHERE user_id = ? ORDER BY campaign_id`, [userId])
    : all<ClientRef>(db, `SELECT user_id AS userId, campaign_id AS campaignId, ref FROM user_client_refs ORDER BY user_id, campaign_id`);
}

/**
 * P9's recordClientEvent, with the record's name as its fifth argument (P9 adds it: "Opened the statement PDF: BCN
 * 5–11 Oct 2026"); the foundation's stub takes four and ignores the rest.
 */
const recordFileEvent = recordClientEvent as (db: Db, me: ReturnType<typeof currentUser>, input: ClientAuditEventInput, ip: string | null, label?: string) => unknown;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};

export function statementsRouter(db: Db): Router {
  const router = Router();
  // Every /statements path is the office's (this router has the prefix to itself).
  router.use(requireRole('admin'));
  const checks = new FailureLimiter(STATEMENT_CHECKS_PER_WINDOW, STATEMENT_LIMIT_WINDOW_MS, 1_000);
  const uploads = new FailureLimiter(STATEMENT_UPLOADS_PER_WINDOW, STATEMENT_LIMIT_WINDOW_MS, 1_000);
  /** 429 with `message` once the person has used up `limiter` (FailureLimiter's own words are about sign-in attempts). */
  const assertUnder = (limiter: FailureLimiter, key: string, message: string) => {
    if (limiter.count(key) >= limiter.maxFailures) throw tooManyRequests(message);
  };

  router.get('/', (req, res) => {
    const q = listQuery.parse(req.query);
    res.json(listStatements(db, { campaignId: q.campaignId, status: q.status }));
  });

  // ── Gmail ──
  router.get('/mail', (_req, res) => {
    res.json(readMailSettings(db));
  });
  router.put('/mail', (req, res) => {
    const body = mailBody.parse(req.body ?? {});
    res.json(saveMailSettings(db, { address: body.address === '' ? null : body.address, appPassword: body.appPassword, enabled: body.enabled }));
  });
  router.post('/mail/test', async (_req, res) => {
    res.json(await testMailConnection(db));
  });
  router.post('/check-now', async (req, res) => {
    const key = String(currentUser(req).id);
    assertUnder(checks, key, STATEMENT_CHECKS_LIMIT_MESSAGE);
    const shared = isCheckRunning();
    const result = checkMail(db); // 409 straight away when Gmail is not set up (not counted)
    if (!shared) checks.record(key);
    res.json(await result);
  });

  // ── senders ──
  router.get('/senders', (_req, res) => {
    res.json(sendersOf(db));
  });
  router.put('/senders', (req, res) => {
    const rows = sendersBody.parse(req.body);
    const missing = [...new Set(rows.map((r) => r.campaignId))].filter((id) => !campaignExists(db, id));
    if (missing.length) throw notFound('Campaign');
    transaction(db, () => {
      run(db, `DELETE FROM campaign_statement_senders`);
      for (const r of rows) run(db, `INSERT OR IGNORE INTO campaign_statement_senders (campaign_id, address) VALUES (?, ?)`, [r.campaignId, r.address]);
    });
    res.json(sendersOf(db));
  });

  // ── column templates ──
  router.get('/templates/:campaignId', (req, res) => {
    const campaignId = idParam(req, 'campaignId');
    const t = loadTemplate(db, campaignId);
    if (!t) throw notFound('Statement template');
    res.json(t);
  });
  router.put('/templates/:campaignId', (req, res) => {
    const campaignId = idParam(req, 'campaignId');
    if (!campaignExists(db, campaignId)) throw notFound('Campaign');
    const parsed = mappingBody.parse(req.body ?? {});
    const mapping: StatementColumnMapping = {};
    for (const f of STATEMENT_FIELDS) if (parsed[f] !== null && parsed[f] !== undefined) mapping[f] = parsed[f]!;
    const who = mapping.ref !== undefined || mapping.name !== undefined;
    const what = ['gross', 'confirmed', 'cancelled', 'date', 'status'].some((f) => mapping[f as keyof StatementColumnMapping] !== undefined);
    if (!who || !what) throw badRequest('Choose the column with the fundraiser’s name or ID, and the one with the subs (or each sign-up’s date or status).');
    const t = transaction(db, () => {
      const saved = saveTemplate(db, campaignId, mapping, currentUser(req).id);
      rereadCampaign(db, campaignId);
      return saved;
    });
    bumpDataVersion();
    res.json(t);
  });

  // ── people's client fundraiser IDs ──
  router.get('/client-refs', (req, res) => {
    const q = z.object({ userId: z.coerce.number().int().positive().optional() }).parse(req.query);
    res.json(refsOf(db, q.userId));
  });
  router.put('/client-refs/:userId', (req, res) => {
    const userId = idParam(req, 'userId');
    const person = get<{ id: number; role: string }>(db, `SELECT id, role FROM users WHERE id = ?`, [userId]);
    if (!person || person.role === 'client') throw notFound('Person');
    const rows = refsBody.parse(req.body);
    if (rows.some((r) => r.userId !== undefined && r.userId !== userId)) throw badRequest('These client IDs are for another person.');
    const byCampaign = new Map<number, string>();
    for (const r of rows) if (r.ref) byCampaign.set(r.campaignId, r.ref);
    for (const id of byCampaign.keys()) if (!campaignExists(db, id)) throw notFound('Campaign');
    const wanted = [...byCampaign];
    if (wanted.length) {
      const clashes = all<{ campaignId: number; ref: string; owner: string; code: string }>(
        db,
        `SELECT r.campaign_id AS campaignId, r.ref, u.first_name || ' ' || u.last_name AS owner, c.code
           FROM user_client_refs r JOIN users u ON u.id = r.user_id JOIN campaigns c ON c.id = r.campaign_id
          WHERE r.user_id <> ? AND r.campaign_id IN (${placeholders(wanted.length)})`,
        [userId, ...wanted.map(([c]) => c)],
      ).filter((c) => byCampaign.get(c.campaignId)?.toLowerCase() === c.ref.toLowerCase());
      if (clashes.length) {
        const c = clashes[0]!;
        throw conflict(`${c.ref} is already ${c.owner}’s fundraiser ID at ${c.code}.`);
      }
    }
    const before = refsOf(db, userId).map((r) => r.campaignId);
    transaction(db, () => {
      run(db, `DELETE FROM user_client_refs WHERE user_id = ?`, [userId]);
      for (const [campaignId, ref] of wanted) run(db, `INSERT INTO user_client_refs (user_id, campaign_id, ref) VALUES (?, ?, ?)`, [userId, campaignId, ref]);
      rematchCampaigns(db, [...new Set([...before, ...byCampaign.keys()])]);
    });
    bumpDataVersion();
    res.json(refsOf(db, userId));
  });

  // ── upload ──
  router.post('/upload', readPdfBody, async (req, res) => {
    const q = uploadQuery.parse(req.query);
    if (!req.is('application/pdf')) throw new HttpError(415, 'Send the PDF itself, with Content-Type: application/pdf.');
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) throw badRequest('The upload was empty. Choose the statement PDF again.');
    if (!looksLikePdf(buf)) throw new HttpError(422, 'This file is not a PDF. Upload the statement as the PDF the client sent.');
    if (q.campaignId && !campaignExists(db, q.campaignId)) throw notFound('Campaign');
    const key = String(currentUser(req).id);
    let dup = existingStatement(db, sha256Of(buf));
    let replacedFailed: number | null = null;
    if (dup && statementSummary(db, dup)?.status === 'failed') {
      // re-review fix: the same bytes as a statement that could not be read (a timeout, a reader that stopped) are
      // read afresh, as its message says to do; the failed copy is discarded first
      assertUnder(uploads, key, STATEMENT_UPLOADS_LIMIT_MESSAGE);
      deleteStatement(db, dup);
      replacedFailed = dup;
      dup = null;
    }
    if (dup) {
      const s = statementSummary(db, dup)!;
      throw new HttpError(409, `This PDF is already here: the ${[s.campaignCode, 'statement'].filter(Boolean).join(' ')} for ${formatStatementPeriod(s.periodStart, s.periodEnd)}, received ${dayLabel(s.receivedAt)}.`, { statementId: dup });
    }
    assertUnder(uploads, key, STATEMENT_UPLOADS_LIMIT_MESSAGE);
    uploads.record(key);
    const r = await ingestStatement(db, { buf, fileName: safeFileName(q.fileName), source: 'upload', receivedAt: nowISO(), campaignId: q.campaignId ?? null });
    if (r.duplicate) throw new HttpError(409, 'This PDF is already here.', { statementId: r.statementId });
    res.status(201).json(replacedFailed ? { ...statementSummary(db, r.statementId), replacedFailedId: replacedFailed } : statementSummary(db, r.statementId));
  });

  // ── one statement ──
  router.get('/:id', (req, res) => {
    res.json(statementDetail(db, idParam(req)));
  });
  router.get('/:id/file', async (req, res) => {
    const id = idParam(req);
    const info = statementFileInfo(db, id);
    if (!info) throw notFound('Statement');
    const buf = await ensureStatementFile(db, id);
    if (!buf) throw notFound('Statement PDF');
    const name = safeFileName(info.fileName ?? `${info.campaignCode ?? 'statement'} ${info.periodStart ?? id}.pdf`);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    const download = req.query.download === '1';
    const disposition = download ? 'attachment' : 'inline';
    // the PDF lists people's earnings: opening or downloading it is on the audit trail (never in the way of the file)
    try {
      const period = info.periodStart && info.periodEnd ? formatStatementPeriod(info.periodStart, info.periodEnd) : null;
      const label = [info.campaignCode, period].filter(Boolean).join(' ') || name;
      const what = `${[info.campaignCode, 'statement'].filter(Boolean).join(' ')}${period ? ` for ${period}` : ''}`; // "BCN statement for 5–11 Oct 2026"
      recordFileEvent(
        db,
        currentUser(req),
        download
          ? { kind: 'export', format: 'pdf', what, filename: name, entity: 'statement', entityId: id }
          : { kind: 'opened', what: 'statement PDF', entity: 'statement', entityId: id },
        req.ip ?? null,
        label,
      );
    } catch (err) {
      console.error(`Statement ${id}: recording the PDF ${download ? 'download' : 'open'} on the audit trail failed`, err);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    // the statement page shows the PDF in a frame of its own origin (every other response stays DENY / 'none')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.end(buf);
  });
  router.patch('/:id', (req, res) => {
    const id = idParam(req);
    const body = patchBody.parse(req.body ?? {});
    patchStatement(db, id, body);
    res.json(statementDetail(db, id));
  });
  router.delete('/:id', (req, res) => {
    deleteStatement(db, idParam(req));
    res.status(204).end();
  });
  router.post('/:id/apply', (req, res) => {
    res.json(applyStatement(db, idParam(req), currentUser(req).id));
  });
  router.put('/:id/rows/:rowId', (req, res) => {
    const id = idParam(req);
    const rowId = idParam(req, 'rowId');
    const body = rowBody.parse(req.body ?? {});
    const { row, rememberedRef, alsoMatched } = setRowMatch(db, id, rowId, body.userId);
    res.json({ ...row, rememberedRef, alsoMatched });
  });
  return router;
}
