/**
 * Release 1.3 — self-billing invoices on the server — OWNED BY P2 invoices. The three hooks the foundation wired into
 * code P2 does not own are STABLE:
 *
 *  - assertInvoicePayable(db, run, me, body): routes/finance.ts calls it in POST /finance/payroll/:id/pay before the run
 *    is marked paid. 409 unless the run's invoice is accepted, deemed accepted or resolved ("Keep as it is"), or the
 *    admin sent `overrideReason` (recorded on the invoice and in the audit trail). A run without an invoice (an
 *    office role, a week paid before 1.3, a run issued less than one job tick ago) keeps the 1.2 rules.
 *  - withInvoiceSummaries(db, runs, me): every payroll answer carries `invoice` (InvoiceSummary) once one is issued —
 *    one grouped query; runs without an invoice gain no key.
 *  - startInvoiceJobs(db): at start-up and every 15 minutes (unref'd): make sure the closed weeks have their runs,
 *    deem accepted the invoices past their deadline, reissue the open ones whose run changed, issue the missing ones.
 *
 * The rules (shared/src/logic/invoices.ts): reps and leaders (the field people) are invoiced; one invoice per payroll
 * run, numbered LM-SB-<year>-<6 digits> in issue order per year; the lines come from P1's breakdown when it adds up to
 * the run's gross, else from the stored run, so the total is always what will be paid; the deadline is 12:00 the day
 * before payday, or 24 hours after the version was issued when that is later (shared invoiceDeadline: a version issued
 * late — on payday, or for an old failed transfer — is never accepted at once); a disputed invoice is held until an admin
 * resolves it ("Fix and reissue" → a new version to accept, or "Keep as it is" with a note the person sees). While an
 * invoice is open (issued or disputed) its supplier and customer blocks follow the person's and the company's details;
 * once accepted they are frozen. When an unpaid run's figures change, its invoice is reissued (the person accepts
 * again) — by the job, and at once when someone accepts, disputes or pays it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  BRAND,
  INVOICED_ROLES,
  MONEY_MAX,
  SELF_BILLING_AGREEMENT_VERSION,
  canDisputeInvoice,
  deemedAcceptanceMoment,
  deemedAcceptedAt,
  effectiveInvoiceStatus,
  formatInvoiceNumber,
  invoiceDeadline,
  invoiceDeadlineText,
  invoiceLinesFor,
  isInvoicePayable,
  isInvoicedRole,
  normalisePostcode,
  normaliseUtr,
  normaliseVatNumber,
  round2,
  sameInvoicePayment,
  selfBillingAgreementText,
  selfBillingNote,
  type CompanySettings,
  type CompanySettingsInput,
  type Invoice,
  type InvoiceActions,
  type InvoiceDisputeLine,
  type InvoiceDisputeRow,
  type InvoiceLine,
  type InvoiceListRow,
  type InvoiceParty,
  type InvoiceProfile,
  type InvoiceProfileInput,
  type InvoiceStatus,
  type InvoiceSummary,
  type InvoiceVersionNote,
  type PayrollRunWithUser,
  type PayrollStatus,
  type SelfBillingAgreement,
  type UserWithTeam,
  type WeekPayBreakdown,
} from '@lm/shared';
import { all, get, placeholders, run, transaction, type Db } from '../db/connection.ts';
import { ensurePayrollMaterialised } from '../db/maintenance.ts';
import { getPayroll } from '../db/queries.ts';
import { recordSystemEvent } from './audit/events.ts';
import { bumpDataVersion } from './cache.ts';
import { appSecretFile } from './crypto.ts';
import { businessNow, formatWeek, toBusinessISO } from './dates.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from './errors.ts';
import { weekPayBreakdown } from './payRule.ts';

// ───────────────────────────── clocks and SQL pieces ─────────────────────────────

/** Naive Europe/London wall-clock time of an instant ("2026-10-21T15:00:00"), what invoice deadlines are written in. */
export const businessLocal = (at: Date = businessNow()): string => toBusinessISO(at);

/** A naive Europe/London wall-clock time ("2026-10-22T12:00:00") → the instant (DST-aware), whatever zone the process runs in. */
export function fromBusinessLocal(naive: string): Date {
  const asUtc = Date.parse(`${naive}Z`);
  const shown = Date.parse(`${businessLocal(new Date(asUtc))}Z`);
  return new Date(asUtc - (shown - asUtc));
}

const INVOICED_SQL = INVOICED_ROLES.map((r) => `'${r}'`).join(', ');
const UNPAID_SQL = `('pending', 'failed')`;

/**
 * The stored run's figures in one string: an invoice remembers it when issued, and a different value later means the
 * run was recalculated (gauges, a statement, an adjustment) and the invoice must be reissued.
 */
export const RUN_FINGERPRINT_SQL = `printf('%d|%d|%d|%.2f|%.2f|%.2f|%.2f|%.2f|%.2f|%s|%d|%d|%.2f',
  p.days_worked, p.sales, p.team_sales, p.base_pay, p.commission, p.bonus, p.overrides, p.deductions, p.gross,
  COALESCE(p.paid_as, ''), COALESCE(p.sales_confirmed, -1), COALESCE(p.sales_cancelled, -1), COALESCE(p.adjustments_total, 0))`;

interface InvoiceRow {
  id: number;
  payrollRunId: number;
  userId: number;
  number: string;
  version: number;
  issuedAt: string;
  status: InvoiceStatus;
  total: number;
  linesJson: string;
  supplierJson: string | null;
  customerJson: string | null;
  acceptedAt: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  disputeLines: string | null;
  resolvedAt: string | null;
  resolvedBy: number | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  resolutionAction: 'reissue' | 'keep' | null;
  deemAt: string | null;
  runFingerprint: string | null;
  currentFingerprint: string;
  paidOverrideReason: string | null;
  paidOverrideBy: number | null;
  paidOverrideByName: string | null;
  paidOverrideAt: string | null;
  weekStart: string;
  weekEnd: string;
  dueDate: string;
  runStatus: PayrollStatus;
  paidDate: string | null;
  runGross: number;
  salesLogged: number | null;
  salesConfirmed: number | null;
  sales: number;
  userName: string;
  userTeamId: number | null;
  teamName: string | null;
}

const INVOICE_SELECT = `
  SELECT i.id, i.payroll_run_id AS payrollRunId, i.user_id AS userId, i.number, i.version, i.issued_at AS issuedAt, i.status,
         i.total, i.lines_json AS linesJson, i.supplier_json AS supplierJson, i.customer_json AS customerJson,
         i.accepted_at AS acceptedAt, i.disputed_at AS disputedAt, i.dispute_reason AS disputeReason,
         i.dispute_lines AS disputeLines, i.resolved_at AS resolvedAt, i.resolved_by AS resolvedBy,
         TRIM(rb.first_name || ' ' || rb.last_name) AS resolvedByName, i.resolution_note AS resolutionNote,
         i.resolution_action AS resolutionAction, i.deem_at AS deemAt, i.run_fingerprint AS runFingerprint,
         ${RUN_FINGERPRINT_SQL} AS currentFingerprint,
         i.paid_override_reason AS paidOverrideReason, i.paid_override_by AS paidOverrideBy,
         TRIM(ob.first_name || ' ' || ob.last_name) AS paidOverrideByName, i.paid_override_at AS paidOverrideAt,
         p.week_start AS weekStart, p.week_end AS weekEnd, p.due_date AS dueDate, p.status AS runStatus,
         p.paid_date AS paidDate, p.gross AS runGross, p.sales_logged AS salesLogged, p.sales_confirmed AS salesConfirmed,
         p.sales, TRIM(u.first_name || ' ' || u.last_name) AS userName, u.team_id AS userTeamId, t.name AS teamName
  FROM invoices i
  JOIN payroll_runs p ON p.id = i.payroll_run_id
  JOIN users u ON u.id = i.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  LEFT JOIN users rb ON rb.id = i.resolved_by
  LEFT JOIN users ob ON ob.id = i.paid_override_by`;

const invoiceRow = (db: Db, where: string, params: (string | number | null)[]): InvoiceRow | undefined =>
  get<InvoiceRow>(db, `${INVOICE_SELECT} ${where}`, params);

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const deadlineOf = (r: Pick<InvoiceRow, 'deemAt' | 'dueDate'>): string => r.deemAt ?? deemedAcceptedAt(r.dueDate) ?? `${r.dueDate}T12:00:00`;
const isUnpaid = (status: PayrollStatus): boolean => status === 'pending' || status === 'failed';
const runChanged = (r: Pick<InvoiceRow, 'runFingerprint' | 'currentFingerprint'>): boolean => r.runFingerprint !== r.currentFingerprint;

function summaryOf(r: InvoiceRow, nowLocal: string): InvoiceSummary {
  const deadline = deadlineOf(r);
  return {
    id: r.id,
    number: r.number,
    status: effectiveInvoiceStatus(r.status, deadline, nowLocal),
    version: r.version,
    issuedAt: r.issuedAt,
    acceptedAt: r.acceptedAt,
    disputedAt: r.disputedAt,
    deemedAcceptedAt: deadline,
    total: r.total,
  };
}

// ───────────────────────────── files: the signature image ─────────────────────────────

/** Where uploads live: LM_UPLOADS_DIR, else `uploads/` next to the app secret (server/data/uploads; a temp dir in tests). */
export function uploadsDir(): string {
  const env = process.env.LM_UPLOADS_DIR?.trim();
  return env ? path.resolve(env) : path.join(path.dirname(appSecretFile()), 'uploads');
}

const SIGNATURE_FILE_RE = /^[a-f0-9]{16}\.png$/;
export const SIGNATURE_MAX_BYTES = 200 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The widest or tallest signature image accepted (Settings → Company scales uploads to at most 600 × 200). */
const PNG_MAX_SIDE = 4000;

/**
 * A complete, well-formed PNG: the signature, then IHDR first (13 bytes, a sane width and height), every chunk's length
 * and CRC right, at least one IDAT, and IEND last with nothing after it. Bytes that only start like a PNG are refused,
 * so a stored signature always decodes (P4's PDF embeds it in every invoice).
 */
export function isWellFormedPng(bytes: Buffer): boolean {
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return false;
  let off = 8;
  let sawIdat = false;
  while (off + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const end = off + 12 + len;
    if (end > bytes.length) return false;
    const type = bytes.toString('latin1', off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(bytes.subarray(off + 4, off + 8 + len)) !== bytes.readUInt32BE(off + 8 + len)) return false;
    if (off === 8) {
      if (type !== 'IHDR' || len !== 13) return false;
      const w = bytes.readUInt32BE(off + 8);
      const h = bytes.readUInt32BE(off + 12);
      if (!w || !h || w > PNG_MAX_SIDE || h > PNG_MAX_SIDE) return false;
    }
    if (type === 'IDAT') sawIdat = true;
    off = end;
    if (type === 'IEND') return sawIdat && len === 0 && off === bytes.length;
  }
  return false;
}

/** The served address of a stored signature file (content-addressed, so it never changes under an issued invoice). */
const signatureUrlOf = (file: string | null | undefined): string | null => (file && SIGNATURE_FILE_RE.test(file) ? `/api/invoices/signatures/${file}` : null);

/** Decodes and checks a `data:image/png;base64,…` signature (≤ 200 KB, a complete PNG); its content-addressed name. Writes nothing. */
export function decodeSignatureImage(dataUrl: string): { file: string; bytes: Buffer } {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw badRequest('The signature must be a PNG image');
  const bytes = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw badRequest('The signature image is empty');
  if (bytes.length > SIGNATURE_MAX_BYTES) throw badRequest('The signature image must be 200 KB or smaller');
  if (!isWellFormedPng(bytes)) throw badRequest('The signature must be a PNG image');
  return { file: `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`, bytes };
}

function writeSignatureFile(sig: { file: string; bytes: Buffer }): void {
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, sig.file);
  if (!existsSync(target)) writeFileSync(target, sig.bytes);
}

/** Checks and stores a signature (see decodeSignatureImage); returns the file name. */
export function storeSignatureImage(dataUrl: string): string {
  const sig = decodeSignatureImage(dataUrl);
  writeSignatureFile(sig);
  return sig.file;
}

/** The bytes of a stored signature file, or null (unknown name, missing file). */
export function readSignatureImage(file: string): Buffer | null {
  if (!SIGNATURE_FILE_RE.test(file)) return null;
  const target = path.join(uploadsDir(), file);
  return existsSync(target) ? readFileSync(target) : null;
}

// ───────────────────────────── company settings (Settings → Company) ─────────────────────────────

const COMPANY_KEY = 'ext:invoices:company';

interface StoredCompany {
  legalName?: string;
  addressLines?: string[];
  postcode?: string | null;
  companyNumber?: string | null;
  signatoryName?: string;
  signatureFile?: string | null;
}

const readMeta = (db: Db, key: string): string | null => get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null;
const writeMeta = (db: Db, key: string, value: string): void => {
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
};

/** The owner's name: the default authorised signatory until the admin sets one. */
function ownerName(db: Db): string {
  return get<{ name: string }>(db, `SELECT TRIM(first_name || ' ' || last_name) AS name FROM users WHERE position = 'owner' AND role = 'admin' ORDER BY id LIMIT 1`)?.name ?? '';
}

/** Settings → Company with defaults: the brand's legal name and address, the owner as signatory. */
export function companySettings(db: Db): CompanySettings {
  const stored = parseJson<StoredCompany>(readMeta(db, COMPANY_KEY), {});
  return {
    legalName: stored.legalName?.trim() || BRAND.legalName,
    addressLines: stored.addressLines?.length ? stored.addressLines : BRAND.address.split(',').map((s) => s.trim()).filter(Boolean),
    postcode: stored.postcode ?? null,
    companyNumber: stored.companyNumber ?? null,
    signatoryName: stored.signatoryName?.trim() || ownerName(db),
    signatureUrl: signatureUrlOf(stored.signatureFile),
  };
}

const COMPANY_NUMBER_RE = /^(?:\d{8}|[A-Z]{2}\d{6})$/;

/** Saves Settings → Company (admin) and refreshes the customer block of every open invoice. */
export function saveCompanySettings(db: Db, input: CompanySettingsInput): CompanySettings {
  const stored = parseJson<StoredCompany>(readMeta(db, COMPANY_KEY), {});
  const next: StoredCompany = { ...stored };
  if (input.legalName !== undefined) {
    const v = input.legalName.trim();
    if (!v) throw badRequest('Enter the company\'s legal name');
    if (v.length > 120) throw badRequest('The legal name is too long (120 characters at most)');
    next.legalName = v;
  }
  if (input.addressLines !== undefined) {
    const lines = input.addressLines.map((l) => l.trim()).filter(Boolean);
    if (lines.length > 4) throw badRequest('Use at most 4 address lines');
    if (lines.some((l) => l.length > 100)) throw badRequest('An address line is too long (100 characters at most)');
    next.addressLines = lines;
  }
  if (input.postcode !== undefined) {
    if (input.postcode === null || !input.postcode.trim()) next.postcode = null;
    else {
      const pc = normalisePostcode(input.postcode);
      if (!pc) throw badRequest('Enter a UK postcode, e.g. M3 2BB');
      next.postcode = pc;
    }
  }
  if (input.companyNumber !== undefined) {
    const v = (input.companyNumber ?? '').toUpperCase().replace(/\s+/g, '');
    if (v && !COMPANY_NUMBER_RE.test(v)) throw badRequest('A company number is 8 characters, e.g. 12345678 or SC123456');
    next.companyNumber = v || null;
  }
  if (input.signatoryName !== undefined) {
    const v = input.signatoryName.trim();
    if (v.length > 80) throw badRequest('The signatory\'s name is too long (80 characters at most)');
    next.signatoryName = v;
  }
  // checked with everything else first; the file is written inside the save, so a failed save leaves no stray file
  const signature = input.signatureImage != null ? decodeSignatureImage(input.signatureImage) : null;
  if (input.signatureImage !== undefined) next.signatureFile = signature?.file ?? null;
  transaction(db, () => {
    writeMeta(db, COMPANY_KEY, JSON.stringify(next));
    refreshOpenParties(db, null);
    if (signature) writeSignatureFile(signature);
  });
  return companySettings(db);
}

interface CustomerSnapshot extends InvoiceParty {
  signatory: { name: string; signatureFile: string | null };
}

function customerSnapshot(db: Db): CustomerSnapshot {
  const c = companySettings(db);
  const stored = parseJson<StoredCompany>(readMeta(db, COMPANY_KEY), {});
  return {
    name: c.legalName,
    addressLines: c.addressLines,
    postcode: c.postcode,
    companyNumber: c.companyNumber,
    signatory: { name: c.signatoryName, signatureFile: stored.signatureFile ?? null },
  };
}

// ───────────────────────────── the supplier's details (Settings → Invoices; Team → person) ─────────────────────────────

interface ProfileRow {
  userId: number;
  name: string;
  role: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressTown: string | null;
  postcode: string | null;
  utr: string | null;
  vatNumber: string | null;
}

const PROFILE_SELECT = `
  SELECT id AS userId, TRIM(first_name || ' ' || last_name) AS name, role, address_line1 AS addressLine1, address_line2 AS addressLine2,
         address_town AS addressTown, postcode, utr, vat_number AS vatNumber
  FROM users`;

function supplierParty(p: ProfileRow): InvoiceParty {
  return {
    name: p.name,
    addressLines: [p.addressLine1, p.addressLine2, p.addressTown].filter((l): l is string => !!l && !!l.trim()),
    postcode: p.postcode,
    utr: p.utr,
    vatNumber: p.vatNumber,
  };
}

/** The person's supplier details (null for an unknown id or a client account). */
export function invoiceProfile(db: Db, userId: number): InvoiceProfile | null {
  const p = get<ProfileRow>(db, `${PROFILE_SELECT} WHERE id = ? AND role <> 'client'`, [userId]);
  if (!p) return null;
  const accepted = agreementAcceptedAt(db, userId);
  return {
    userId: p.userId,
    name: p.name,
    addressLine1: p.addressLine1,
    addressLine2: p.addressLine2,
    addressTown: p.addressTown,
    postcode: p.postcode,
    utr: p.utr,
    vatNumber: p.vatNumber,
    invoiced: isInvoicedRole(p.role),
    agreement: { version: SELF_BILLING_AGREEMENT_VERSION, acceptedAt: accepted },
  };
}

const text = (v: string | null | undefined, max: number, label: string): string | null => {
  const t = (v ?? '').trim();
  if (t.length > max) throw badRequest(`${label} is too long (${max} characters at most)`);
  return t || null;
};

/** Saves the supplier details (fields left out stay as they are) and refreshes the person's open invoices. */
export function saveInvoiceProfile(db: Db, userId: number, input: InvoiceProfileInput): InvoiceProfile {
  const current = get<ProfileRow>(db, `${PROFILE_SELECT} WHERE id = ? AND role <> 'client'`, [userId]);
  if (!current) throw notFound('User');
  const next = { ...current };
  if (input.addressLine1 !== undefined) next.addressLine1 = text(input.addressLine1, 100, 'Address line 1');
  if (input.addressLine2 !== undefined) next.addressLine2 = text(input.addressLine2, 100, 'Address line 2');
  if (input.addressTown !== undefined) next.addressTown = text(input.addressTown, 60, 'Town or city');
  if (input.postcode !== undefined) {
    const raw = (input.postcode ?? '').trim();
    if (!raw) next.postcode = null;
    else {
      const pc = normalisePostcode(raw);
      if (!pc) throw badRequest('Enter a UK postcode, e.g. M14 5QT');
      next.postcode = pc;
    }
  }
  if (input.utr !== undefined) {
    const raw = (input.utr ?? '').trim();
    if (!raw) next.utr = null;
    else {
      const utr = normaliseUtr(raw);
      if (!utr) throw badRequest('A Unique Taxpayer Reference (UTR) is 10 digits');
      next.utr = utr;
    }
  }
  if (input.vatNumber !== undefined) {
    const raw = (input.vatNumber ?? '').trim();
    if (!raw) next.vatNumber = null;
    else {
      const vat = normaliseVatNumber(raw);
      if (!vat) throw badRequest('A UK VAT number is GB followed by 9 digits, e.g. GB123456789');
      next.vatNumber = vat;
    }
  }
  transaction(db, () => {
    run(db, `UPDATE users SET address_line1 = ?, address_line2 = ?, address_town = ?, postcode = ?, utr = ?, vat_number = ? WHERE id = ?`, [
      next.addressLine1, next.addressLine2, next.addressTown, next.postcode, next.utr, next.vatNumber, userId,
    ]);
    refreshOpenParties(db, userId);
  });
  return invoiceProfile(db, userId)!;
}

/**
 * Open invoices (issued or disputed, run unpaid) print the current details: after a profile edit (userId) or a company
 * edit (null), their supplier / customer blocks are brought up to date. Accepted ones keep what was accepted.
 */
function refreshOpenParties(db: Db, userId: number | null): void {
  const open = all<{ id: number; userId: number }>(
    db,
    `SELECT i.id, i.user_id AS userId FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
     WHERE i.status IN ('issued', 'disputed') AND p.status IN ${UNPAID_SQL}${userId ? ' AND i.user_id = ?' : ''}`,
    userId ? [userId] : [],
  );
  if (!open.length) return;
  if (userId) {
    const p = get<ProfileRow>(db, `${PROFILE_SELECT} WHERE id = ?`, [userId]);
    if (!p) return;
    const supplier = JSON.stringify(supplierParty(p));
    run(db, `UPDATE invoices SET supplier_json = ? WHERE id IN (${placeholders(open.length)})`, [supplier, ...open.map((o) => o.id)]);
  } else {
    const customer = JSON.stringify(customerSnapshot(db));
    run(db, `UPDATE invoices SET customer_json = ? WHERE id IN (${placeholders(open.length)})`, [customer, ...open.map((o) => o.id)]);
  }
}

// ───────────────────────────── the self-billing agreement ─────────────────────────────

export function agreementAcceptedAt(db: Db, userId: number, version = SELF_BILLING_AGREEMENT_VERSION): string | null {
  return get<{ at: string }>(db, `SELECT accepted_at AS at FROM self_billing_agreements WHERE user_id = ? AND version = ?`, [userId, version])?.at ?? null;
}

export function agreementFor(db: Db, userId: number): SelfBillingAgreement {
  const a = selfBillingAgreementText(companySettings(db).legalName);
  return { version: a.version, title: a.title, body: a.body, acceptedAt: agreementAcceptedAt(db, userId) };
}

/** Records the acceptance once (version, time, IP); a second call changes nothing. */
export function acceptAgreement(db: Db, userId: number, ip: string | null, at: Date = businessNow()): { agreement: SelfBillingAgreement; created: boolean } {
  const r = run(db, `INSERT OR IGNORE INTO self_billing_agreements (user_id, version, accepted_at, ip) VALUES (?, ?, ?, ?)`, [
    userId, SELF_BILLING_AGREEMENT_VERSION, at.toISOString(), ip,
  ]);
  return { agreement: agreementFor(db, userId), created: r.changes > 0 };
}

// ───────────────────────────── issuing ─────────────────────────────

/** The lines and total for a run: P1's breakdown when it adds up to the run's gross, else the run's own figures. */
export function linesForRun(db: Db, r: PayrollRunWithUser): { lines: InvoiceLine[]; total: number; source: 'breakdown' | 'run' } {
  let breakdown: WeekPayBreakdown | null = null;
  try {
    const b = weekPayBreakdown(db, r.userId, r.weekStart);
    if (b && (b.runId == null || b.runId === r.id)) breakdown = b;
  } catch (err) {
    // P1's breakdown failing must never stop an invoice: the stored run explains the same total.
    if (!(err instanceof HttpError)) console.error('Invoices: the pay breakdown failed; the invoice uses the run\'s figures', err);
  }
  return invoiceLinesFor(r, breakdown);
}

/** The next number of `year`'s sequence (meta `ext:invoices:seq:<YYYY>`, never below a number already used). */
function nextInvoiceNumber(db: Db, year: number): string {
  const key = `ext:invoices:seq:${year}`;
  const stored = Number(readMeta(db, key)) || 0;
  const prefix = formatInvoiceNumber(year, 0).slice(0, -6);
  const used = Number(get<{ m: number | null }>(db, `SELECT MAX(CAST(substr(number, ?) AS INTEGER)) AS m FROM invoices WHERE number LIKE ?`, [prefix.length + 1, `${prefix}%`])?.m ?? 0);
  const next = Math.max(stored, used) + 1;
  writeMeta(db, key, String(next));
  return formatInvoiceNumber(year, next);
}

const fingerprintOf = (db: Db, runId: number): string => get<{ f: string }>(db, `SELECT ${RUN_FINGERPRINT_SQL} AS f FROM payroll_runs p WHERE p.id = ?`, [runId])!.f;

/** Issues the invoice for one run (returns its id; the existing one's id when it already has one; null for no run). */
export function issueInvoiceForRun(db: Db, runId: number, at: Date = businessNow()): number | null {
  const existing = get<{ id: number }>(db, `SELECT id FROM invoices WHERE payroll_run_id = ?`, [runId]);
  if (existing) return existing.id;
  const r = getPayroll(db, runId);
  if (!r) return null;
  const profile = get<ProfileRow>(db, `${PROFILE_SELECT} WHERE id = ?`, [r.userId]);
  if (!profile) return null;
  const { lines, total } = linesForRun(db, r);
  const local = businessLocal(at);
  const number = nextInvoiceNumber(db, Number(local.slice(0, 4)));
  return run(
    db,
    `INSERT INTO invoices (payroll_run_id, user_id, number, version, issued_at, status, total, lines_json, supplier_json, customer_json, deem_at, run_fingerprint)
     VALUES (?, ?, ?, 1, ?, 'issued', ?, ?, ?, ?, ?, ?)`,
    [r.id, r.userId, number, at.toISOString(), total, JSON.stringify(lines), JSON.stringify(supplierParty(profile)), JSON.stringify(customerSnapshot(db)), invoiceDeadline(r.dueDate, local), fingerprintOf(db, r.id)],
  ).lastInsertRowid;
}

/**
 * A new version of an invoice from its run as it stands: the current version goes to invoice_versions; the new one is
 * 'issued' (the person accepts again) with a fresh deadline. `resolution` is the admin's "Fix and reissue".
 */
export function reissueInvoice(
  db: Db,
  invoiceId: number,
  at: Date,
  opts: { reason: string; resolution?: { note: string; by: number | null } },
  computed?: { pay: PayrollRunWithUser; lines: { lines: InvoiceLine[]; total: number } },
): void {
  const r = invoiceRow(db, 'WHERE i.id = ?', [invoiceId]);
  if (!r) throw notFound('Invoice');
  const pay = computed?.pay ?? getPayroll(db, r.payrollRunId);
  if (!pay) throw notFound('Payroll run');
  const profile = get<ProfileRow>(db, `${PROFILE_SELECT} WHERE id = ?`, [r.userId])!;
  const local = businessLocal(at);
  run(
    db,
    `INSERT OR REPLACE INTO invoice_versions (invoice_id, version, issued_at, status, total, lines_json, accepted_at, disputed_at, dispute_reason, dispute_lines, replaced_at, replaced_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.id, r.version, r.issuedAt, effectiveInvoiceStatus(r.status, deadlineOf(r), local), r.total, r.linesJson, r.acceptedAt, r.disputedAt, r.disputeReason, r.disputeLines, at.toISOString(), opts.reason],
  );
  const { lines, total } = computed?.lines ?? linesForRun(db, pay);
  const res = opts.resolution;
  run(
    db,
    `UPDATE invoices SET version = version + 1, issued_at = ?, status = 'issued', total = ?, lines_json = ?, supplier_json = ?, customer_json = ?,
       accepted_at = NULL, accepted_ip = NULL, disputed_at = NULL, dispute_reason = NULL, dispute_lines = NULL,
       resolved_at = ?, resolved_by = ?, resolution_note = ?, resolution_action = ?, deem_at = ?, run_fingerprint = ?,
       paid_override_reason = NULL, paid_override_by = NULL, paid_override_at = NULL
     WHERE id = ?`,
    [
      at.toISOString(), total, JSON.stringify(lines), JSON.stringify(supplierParty(profile)), JSON.stringify(customerSnapshot(db)),
      res ? at.toISOString() : null, res?.by ?? null, res?.note ?? null, res ? 'reissue' : null,
      invoiceDeadline(pay.dueDate, local), fingerprintOf(db, pay.id), r.id,
    ],
  );
}

export interface InvoiceSyncResult {
  issued: number;
  /** A new version for the person to check: what is paid changed. */
  reissued: number;
  /** The run changed but not what is paid (only "Not paid" lines or wording): brought up to date, status kept. */
  refreshed: number;
  deemed: number;
}

const REISSUE_REASON = 'The amounts changed after it was issued';

/** An invoice behind its run: the run (unpaid) was recalculated since, and the invoice is not held by a dispute. */
const isStale = (r: Pick<InvoiceRow, 'runStatus' | 'status' | 'runFingerprint' | 'currentFingerprint'>): boolean =>
  isUnpaid(r.runStatus) && r.status !== 'disputed' && runChanged(r);

/**
 * Brings stale invoices up to date with their runs (inside the caller's transaction). The same payment — the same total
 * and paid lines (sameInvoicePayment) — refreshes the lines in place and keeps the status, the acceptance and the
 * deadline (a cancellation on a week paid as the base changes nothing the person accepted). Anything else is a new
 * version for the person to check (reissueInvoice; it always gets at least 24 hours, so the person can accept it or
 * say something's wrong even when it comes on payday). One automatic audit row per reissue, one for all the refreshed
 * ones. A refresh of a version the person accepted (or that counted as accepted) keeps the lines they accepted in
 * invoice_refreshes first, so what they agreed to is never lost.
 */
function applyStale(db: Db, rows: readonly InvoiceRow[], at: Date): { reissued: number; refreshed: number } {
  const refreshed: InvoiceRow[] = [];
  let reissued = 0;
  for (const r of rows) {
    const pay = getPayroll(db, r.payrollRunId);
    if (!pay) continue;
    const next = linesForRun(db, pay);
    if (sameInvoicePayment({ total: r.total, lines: parseJson<InvoiceLine[]>(r.linesJson, []) }, next)) {
      const nextJson = JSON.stringify(next.lines);
      const status = effectiveInvoiceStatus(r.status, deadlineOf(r), businessLocal(at));
      // the person agreed to these lines (or they counted as agreed): keep them before the wording changes
      if (nextJson !== r.linesJson && isInvoicePayable(status)) {
        run(
          db,
          `INSERT INTO invoice_refreshes (invoice_id, number, version, status, accepted_at, lines_json, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            r.id, r.number, r.version, status,
            status === 'accepted'
              ? r.acceptedAt
              : status === 'deemed_accepted'
                ? fromBusinessLocal(deemedAcceptanceMoment(deadlineOf(r), businessLocal(new Date(r.issuedAt)))).toISOString()
                : r.resolvedAt,
            r.linesJson, at.toISOString(),
          ],
        );
      }
      run(db, `UPDATE invoices SET lines_json = ?, run_fingerprint = ? WHERE id = ?`, [nextJson, fingerprintOf(db, pay.id), r.id]);
      refreshed.push(r);
      continue;
    }
    reissueInvoice(db, r.id, at, { reason: REISSUE_REASON }, { pay, lines: next });
    reissued++;
    recordSystemEvent(db, { name: 'invoices.reissue', summary: `Reissued invoice ${r.number} for ${r.userName} (${formatWeek(r.weekStart)}): the amounts changed`, entity: 'invoice', entityId: r.id });
  }
  if (refreshed.length) {
    const one = refreshed.length === 1 ? refreshed[0]! : null;
    recordSystemEvent(db, {
      name: 'invoices.refresh',
      summary: one
        ? `Brought invoice ${one.number} for ${one.userName} (${formatWeek(one.weekStart)}) up to date with the week: what is paid did not change`
        : `Brought ${refreshed.length} invoices up to date with their weeks: what is paid did not change`,
      entity: 'invoice',
      entityId: one?.id ?? null,
      after: { invoiceIds: refreshed.map((r) => r.id) },
    });
  }
  return { reissued, refreshed: refreshed.length };
}

/** applyStale in its own transaction (or the caller's), then the response cache moves on. */
function syncStale(db: Db, rows: readonly InvoiceRow[], at: Date): { reissued: number; refreshed: number } {
  if (!rows.length) return { reissued: 0, refreshed: 0 };
  const out = db.isTransaction ? applyStale(db, rows, at) : transaction(db, () => applyStale(db, rows, at));
  if (out.reissued || out.refreshed) bumpDataVersion();
  return out;
}

/**
 * The job's work (also safe to call any time; idempotent): bring the invoices of changed unpaid runs up to date
 * (refreshed in place or reissued — never a disputed one: it is held for the office), issue an invoice for every
 * unpaid run of a field person that has none, then deem accepted the issued invoices past their deadline (an old
 * failed transfer invoiced today waits 24 hours like any late version). One audit row per batch (actor "Linear Hub").
 */
export function syncInvoices(db: Db, at: Date = businessNow()): InvoiceSyncResult {
  const result: InvoiceSyncResult = { issued: 0, reissued: 0, refreshed: 0, deemed: 0 };
  const local = businessLocal(at);
  transaction(db, () => {
    const stale = all<InvoiceRow>(
      db,
      `${INVOICE_SELECT} WHERE p.status IN ${UNPAID_SQL} AND i.status <> 'disputed' AND (i.run_fingerprint IS NULL OR i.run_fingerprint <> ${RUN_FINGERPRINT_SQL})
       ORDER BY p.week_start, i.id`,
    );
    const changed = applyStale(db, stale, at);
    result.reissued = changed.reissued;
    result.refreshed = changed.refreshed;

    const missing = all<{ id: number; weekStart: string }>(
      db,
      `SELECT p.id, p.week_start AS weekStart FROM payroll_runs p JOIN users u ON u.id = p.user_id
       LEFT JOIN invoices i ON i.payroll_run_id = p.id
       WHERE i.id IS NULL AND p.status IN ${UNPAID_SQL} AND u.role IN (${INVOICED_SQL})
       ORDER BY p.week_start, p.id`,
    );
    const issuedByWeek = new Map<string, number[]>();
    for (const m of missing) {
      const id = issueInvoiceForRun(db, m.id, at);
      if (id === null) continue;
      result.issued++;
      issuedByWeek.set(m.weekStart, [...(issuedByWeek.get(m.weekStart) ?? []), id]);
    }
    for (const [week, ids] of issuedByWeek) {
      recordSystemEvent(db, {
        name: 'invoices.issue',
        summary: `Issued ${ids.length === 1 ? '1 self-billing invoice' : `${ids.length} self-billing invoices`} for ${formatWeek(week)}`,
        entity: 'invoice',
        entityId: ids.length === 1 ? ids[0]! : null,
        after: { invoiceIds: ids },
      });
    }

    const due = all<{ id: number; weekStart: string; deemAt: string }>(
      db,
      `SELECT i.id, p.week_start AS weekStart, i.deem_at AS deemAt FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
       WHERE i.status = 'issued' AND i.deem_at <= ? ORDER BY p.week_start`,
      [local],
    );
    if (due.length) {
      result.deemed = run(db, `UPDATE invoices SET status = 'deemed_accepted' WHERE id IN (${placeholders(due.length)})`, due.map((d) => d.id)).changes;
      for (const [week, ids] of groupBy(due, (d) => d.weekStart)) {
        recordSystemEvent(db, {
          name: 'invoices.deem',
          summary: `${ids.length === 1 ? '1 invoice' : `${ids.length} invoices`} for ${formatWeek(week)} counted as accepted: not disputed by the deadline`,
          entity: 'invoice',
          entityId: ids.length === 1 ? ids[0]!.id : null,
          after: { invoiceIds: ids.map((d) => d.id) },
        });
      }
    }
  });
  if (result.issued || result.reissued || result.refreshed || result.deemed) bumpDataVersion();
  return result;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}

/** The invoices job: at start-up and every 15 minutes (unref'd). Returns a stop function. */
export function startInvoiceJobs(db: Db): () => void {
  const tick = () => {
    try {
      // the week that just closed gets its runs first (cheap when they exist), then their invoices
      ensurePayrollMaterialised(db);
      const r = syncInvoices(db);
      if (r.issued || r.reissued || r.refreshed || r.deemed) {
        console.log(`Invoices: ${r.issued} issued, ${r.reissued} reissued, ${r.refreshed} brought up to date, ${r.deemed} counted as accepted`);
      }
    } catch (err) {
      console.error('Invoices job failed; it runs again in 15 minutes', err);
    }
  };
  tick();
  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

// ───────────────────────────── reading ─────────────────────────────

/** Admin, the supplier, or the leader of the supplier's team (the payslip's rule). */
export function canViewInvoice(me: UserWithTeam, r: Pick<InvoiceRow, 'userId' | 'userTeamId'>): boolean {
  if (me.role === 'admin' || me.id === r.userId) return true;
  return me.role === 'leader' && me.teamId !== null && me.teamId === r.userTeamId;
}

function actionsFor(r: InvoiceRow, me: UserWithTeam, status: InvoiceStatus, local: string): InvoiceActions {
  const supplier = me.id === r.userId;
  const unpaid = isUnpaid(r.runStatus);
  return {
    accept: supplier && (status === 'issued' || status === 'disputed' || status === 'resolved'),
    dispute: supplier && canDisputeInvoice(status, deadlineOf(r), local, !unpaid),
    resolve: me.role === 'admin' && status === 'disputed',
    // a disputed invoice is held until the office answers it (Resolve), so it has no "Mark paid anyway"
    markPaidWithReason: me.role === 'admin' && unpaid && status !== 'disputed' && !isInvoicePayable(status),
  };
}

function previousVersions(db: Db, invoiceId: number): InvoiceVersionNote[] {
  return all<InvoiceVersionNote>(
    db,
    `SELECT version, issued_at AS issuedAt, total, status, replaced_at AS replacedAt, replaced_reason AS reason, dispute_reason AS disputeReason
     FROM invoice_versions WHERE invoice_id = ? ORDER BY version DESC`,
    [invoiceId],
  );
}

/**
 * The supplier block as the viewer may see it: the person and the office see it all; anyone else who may open the
 * invoice (the person's team leader) sees the name and VAT registration (public), not the home address or the UTR.
 */
function supplierFor(stored: InvoiceParty, me: UserWithTeam, r: Pick<InvoiceRow, 'userId'>): InvoiceParty {
  if (me.role === 'admin' || me.id === r.userId) return stored;
  return { name: stored.name, addressLines: [], postcode: null, utr: null, vatNumber: stored.vatNumber ?? null, withheld: true };
}

/** Whether the person had accepted a self-billing agreement (any version) by `localMoment` (naive London time). */
function agreementAcceptedBy(db: Db, userId: number, localMoment: string): boolean {
  const first = get<{ at: string | null }>(db, `SELECT MIN(accepted_at) AS at FROM self_billing_agreements WHERE user_id = ?`, [userId])?.at;
  return !!first && Date.parse(first) <= fromBusinessLocal(localMoment).getTime();
}

function toInvoice(db: Db, r: InvoiceRow, me: UserWithTeam, local: string): Invoice {
  const summary = summaryOf(r, local);
  const status = summary.status;
  const storedSupplier = parseJson<InvoiceParty>(r.supplierJson, { name: r.userName, addressLines: [], postcode: null, utr: null, vatNumber: null });
  const supplier = supplierFor(storedSupplier, me, r);
  const stored = parseJson<CustomerSnapshot | null>(r.customerJson, null) ?? customerSnapshot(db);
  const { signatory, ...customer } = stored;
  const acceptance: Invoice['acceptance'] = status === 'accepted' && r.acceptedAt
    ? { by: supplier.name, at: r.acceptedAt, deemed: false }
    : status === 'deemed_accepted'
      ? { by: supplier.name, at: deemedAcceptanceMoment(summary.deemedAcceptedAt, businessLocal(new Date(r.issuedAt))), deemed: true }
      : null;
  // deemed acceptance is a term of the agreement: say so when the person had not accepted one by then
  if (acceptance?.deemed && !agreementAcceptedBy(db, r.userId, acceptance.at)) acceptance.withoutAgreement = true;
  const invoice: Invoice = {
    ...summary,
    payrollRunId: r.payrollRunId,
    userId: r.userId,
    weekStart: r.weekStart,
    weekEnd: r.weekEnd,
    dueDate: r.dueDate,
    supplier,
    customer: customer as InvoiceParty,
    lines: parseJson<InvoiceLine[]>(r.linesJson, []),
    selfBillingNote: selfBillingNote(customer.name || BRAND.legalName),
    signatory: { name: signatory?.name ?? '', signatureUrl: signatureUrlOf(signatory?.signatureFile) },
    acceptance,
    dispute: r.disputedAt ? { reason: r.disputeReason ?? '', lines: parseJson<InvoiceDisputeLine[]>(r.disputeLines, []), at: r.disputedAt } : null,
    resolution: r.resolvedAt && r.resolutionAction
      ? { action: r.resolutionAction, note: r.resolutionNote ?? '', by: r.resolvedBy, byName: r.resolvedByName, at: r.resolvedAt }
      : null,
    runStatus: r.runStatus,
    paidDate: r.paidDate,
    paidOverride: r.paidOverrideAt && r.paidOverrideReason
      ? { reason: r.paidOverrideReason, by: r.paidOverrideBy, byName: r.paidOverrideByName, at: r.paidOverrideAt }
      : null,
    actions: actionsFor(r, me, status, local),
  };
  if (r.version > 1) invoice.previousVersions = previousVersions(db, r.id);
  if (me.id === r.userId) invoice.agreementAccepted = agreementAcceptedAt(db, r.userId) !== null;
  if (me.role === 'admin') {
    // what "Fix and reissue" would issue (the run as it stands) and whether it moved since this version
    invoice.runTotal = round2(r.runGross);
    invoice.figuresChanged = runChanged(r);
  }
  return invoice;
}

/** GET /invoices/:id and /invoices/by-run/:runId: 404 unknown, 403 not allowed (the payslip's rule). */
export function invoiceFor(db: Db, me: UserWithTeam, where: { id: number } | { runId: number }): Invoice {
  const r = 'id' in where ? invoiceRow(db, 'WHERE i.id = ?', [where.id]) : invoiceRow(db, 'WHERE i.payroll_run_id = ?', [where.runId]);
  if (!r) throw notFound('Invoice');
  if (!canViewInvoice(me, r)) throw forbidden('You cannot view this invoice');
  // the run changed since (a bonus added, a statement applied): show the invoice as it now stands, not the job's next tick
  const now = isStale(r) ? freshRow(db, r.id, businessNow()).row : r;
  return toInvoice(db, now, me, businessLocal());
}

/** GET /invoices: own; leader own team (and self); admin all — from `from` to `to` (pay weeks), newest first. */
export function listInvoices(db: Db, me: UserWithTeam, q: { from: string; to: string; userId: number | null; weekStart: string | null; status: InvoiceStatus | null }): InvoiceListRow[] {
  const where: string[] = ['p.week_start BETWEEN ? AND ?'];
  const params: (string | number)[] = [q.from, q.to];
  if (me.role === 'admin') {
    if (q.userId) where.push('i.user_id = ?'), params.push(q.userId);
  } else if (me.role === 'leader' && me.teamId !== null) {
    where.push('(u.team_id = ? OR i.user_id = ?)');
    params.push(me.teamId, me.id);
    if (q.userId) where.push('i.user_id = ?'), params.push(q.userId);
  } else {
    if (q.userId && q.userId !== me.id) throw forbidden('You can only view your own invoices');
    where.push('i.user_id = ?');
    params.push(me.id);
  }
  if (q.weekStart) where.push('p.week_start = ?'), params.push(q.weekStart);
  const local = businessLocal();
  const select = () => all<InvoiceRow>(db, `${INVOICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.week_start DESC, u.last_name, u.first_name`, params);
  let rows = select();
  const stale = rows.filter(isStale);
  if (stale.length) {
    syncStale(db, stale, businessNow());
    rows = select();
  }
  return rows
    .map((r): InvoiceListRow => ({
      ...summaryOf(r, local),
      payrollRunId: r.payrollRunId,
      userId: r.userId,
      userName: r.userName,
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      dueDate: r.dueDate,
      runStatus: r.runStatus,
    }))
    .filter((r) => !q.status || r.status === q.status);
}

/** Finance → Company → Disputed invoices (admin): every disputed invoice, oldest dispute first. */
export function listDisputes(db: Db): InvoiceDisputeRow[] {
  const local = businessLocal();
  const rows = all<InvoiceRow>(db, `${INVOICE_SELECT} WHERE i.status = 'disputed' ORDER BY i.disputed_at, i.id`);
  // the clients' statements that confirmed sales for each disputed week (P1's sale_confirmations): one grouped query
  const statements = new Map<string, { id: number; campaignCode: string | null }[]>();
  if (rows.length) {
    const users = [...new Set(rows.map((r) => r.userId))];
    for (const c of all<{ userId: number; weekStart: string; id: number; campaignCode: string | null }>(
      db,
      `SELECT DISTINCT sc.user_id AS userId, sc.week_start AS weekStart, sc.statement_id AS id, c.code AS campaignCode
       FROM sale_confirmations sc LEFT JOIN campaigns c ON c.id = sc.campaign_id
       WHERE sc.statement_id IS NOT NULL AND sc.user_id IN (${placeholders(users.length)}) ORDER BY c.code, sc.statement_id`,
      users,
    )) {
      const key = `${c.userId}|${c.weekStart}`;
      statements.set(key, [...(statements.get(key) ?? []), { id: c.id, campaignCode: c.campaignCode }]);
    }
  }
  return rows.map((r) => {
    const lines = parseJson<InvoiceLine[]>(r.linesJson, []);
    const picked = parseJson<InvoiceDisputeLine[]>(r.disputeLines, []);
    const ours: InvoiceDisputeRow['ours'] = { total: r.total, salesLogged: r.salesLogged ?? r.sales };
    if (r.salesConfirmed !== null) ours.salesConfirmed = r.salesConfirmed;
    return {
      invoice: summaryOf(r, local),
      userId: r.userId,
      userName: r.userName,
      weekStart: r.weekStart,
      dispute: { reason: r.disputeReason ?? '', lines: picked, at: r.disputedAt ?? r.issuedAt },
      ours,
      payrollRunId: r.payrollRunId,
      dueDate: r.dueDate,
      teamName: r.teamName,
      disputedLines: picked.flatMap((d) => {
        const l = lines[d.line];
        return l ? [{ line: d.line, description: l.description, amount: l.amount, paid: l.paid, ...(d.note ? { note: d.note } : {}) }] : [];
      }),
      figuresChanged: runChanged(r),
      runTotal: round2(r.runGross),
      statements: statements.get(`${r.userId}|${r.weekStart}`) ?? [],
    };
  });
}

/** STABLE hook: each run with its invoice summary (one grouped query; runs without one are returned as they were). */
export function withInvoiceSummaries<T extends PayrollRunWithUser>(db: Db, runs: T[], me: UserWithTeam): T[] {
  void me; // the runs are already scoped by the caller
  if (!runs.length) return runs;
  const ids = [...new Set(runs.map((r) => r.id))];
  const select = () => all<InvoiceRow>(db, `${INVOICE_SELECT} WHERE i.payroll_run_id IN (${placeholders(ids.length)})`, ids);
  let rows = select();
  if (!rows.length) return runs;
  // runs recalculated since their invoice was issued: the summary shows the invoice as it now stands
  const stale = rows.filter(isStale);
  if (stale.length) {
    syncStale(db, stale, businessNow());
    rows = select();
  }
  const local = businessLocal();
  const byRun = new Map(rows.map((r) => [r.payrollRunId, summaryOf(r, local)]));
  return runs.map((r) => {
    const invoice = byRun.get(r.id);
    return invoice ? { ...r, invoice } : r;
  });
}

// ───────────────────────────── the person's and the office's actions ─────────────────────────────

/**
 * An invoice whose unpaid run changed since it was issued is brought up to date before anyone reads or acts on it:
 * refreshed in place when what is paid is the same, else reissued (`reissued`: the person has a new version to check).
 */
function freshRow(db: Db, invoiceId: number, at: Date): { row: InvoiceRow; reissued: boolean } {
  const r = invoiceRow(db, 'WHERE i.id = ?', [invoiceId]);
  if (!r) throw notFound('Invoice');
  if (!isStale(r)) return { row: r, reissued: false };
  const out = syncStale(db, [r], at);
  return { row: invoiceRow(db, 'WHERE i.id = ?', [invoiceId])!, reissued: out.reissued > 0 };
}

const REISSUED_MESSAGE = 'The amounts changed, so this invoice was reissued. Check the new version and try again.';

function supplierRow(db: Db, me: UserWithTeam, invoiceId: number, at: Date): InvoiceRow {
  const peek = invoiceRow(db, 'WHERE i.id = ?', [invoiceId]);
  if (!peek) throw notFound('Invoice');
  if (!canViewInvoice(me, peek)) throw forbidden('You cannot view this invoice');
  if (peek.userId !== me.id) throw forbidden('Only the person the invoice is for can accept it or say something is wrong');
  const { row, reissued } = freshRow(db, invoiceId, at);
  if (reissued) throw new HttpError(409, REISSUED_MESSAGE, { code: 'invoice_reissued' });
  return row;
}

/** POST /invoices/:id/accept (the supplier): needs the current agreement; idempotent once accepted. */
export function acceptInvoice(db: Db, me: UserWithTeam, invoiceId: number, ip: string | null, at: Date = businessNow()): Invoice {
  const r = supplierRow(db, me, invoiceId, at);
  const status = effectiveInvoiceStatus(r.status, deadlineOf(r), businessLocal(at));
  if (status === 'accepted' || status === 'deemed_accepted') return toInvoice(db, r, me, businessLocal(at));
  if (!agreementAcceptedAt(db, me.id)) {
    throw new HttpError(409, 'Accept the self-billing agreement first: it is in Settings → Invoices.', { code: 'agreement_required' });
  }
  run(db, `UPDATE invoices SET status = 'accepted', accepted_at = ?, accepted_ip = ? WHERE id = ?`, [at.toISOString(), ip, r.id]);
  return invoiceFor(db, me, { id: r.id });
}

/** POST /invoices/:id/dispute (the supplier): before the deadline, while unpaid; the invoice is held for the office. */
export function disputeInvoice(db: Db, me: UserWithTeam, invoiceId: number, input: { reason: string; lines: InvoiceDisputeLine[] }, at: Date = businessNow()): Invoice {
  const r = supplierRow(db, me, invoiceId, at);
  const local = businessLocal(at);
  const status = effectiveInvoiceStatus(r.status, deadlineOf(r), local);
  if (status === 'disputed') throw conflict('You already said something is wrong with this invoice. The office will check it and reply.');
  if (!isUnpaid(r.runStatus)) throw conflict('This week has been paid. Speak to the office: a correction goes on a later week.');
  if (!canDisputeInvoice(status, deadlineOf(r), local, false)) {
    throw conflict(status === 'resolved'
      ? 'The office has already checked this invoice. Speak to the office if something is still wrong.'
      : `The time to dispute this invoice passed at ${invoiceDeadlineText(deadlineOf(r))}. Speak to the office: a correction can go on a later week.`);
  }
  const count = parseJson<InvoiceLine[]>(r.linesJson, []).length;
  const seen = new Set<number>();
  for (const l of input.lines) {
    if (l.line >= count) throw badRequest(`There is no line ${l.line + 1} on this invoice`);
    if (seen.has(l.line)) throw badRequest('Pick each line once');
    seen.add(l.line);
  }
  run(db, `UPDATE invoices SET status = 'disputed', disputed_at = ?, dispute_reason = ?, dispute_lines = ?, accepted_at = NULL, accepted_ip = NULL WHERE id = ?`, [
    at.toISOString(), input.reason, JSON.stringify(input.lines.map((l) => (l.note ? { line: l.line, note: l.note } : { line: l.line }))), r.id,
  ]);
  return invoiceFor(db, me, { id: r.id });
}

/**
 * POST /invoices/:id/resolve (admin), a disputed invoice only:
 *  - 'keep': it stands as issued; status 'resolved' (payable) with the note the person sees;
 *  - 'reissue': an unpaid run only. An optional correction is first added to the disputed week (pay_adjustments, kind
 *    'dispute', linked to the invoice) and the run recalculated; then a new version is issued from the run.
 */
export function resolveInvoice(
  db: Db,
  me: UserWithTeam,
  invoiceId: number,
  input: { action: 'reissue' | 'keep'; note: string; adjustment?: { amount: number; note?: string } | null },
  recalculate: (runId: number) => void,
  at: Date = businessNow(),
): Invoice {
  const r = invoiceRow(db, 'WHERE i.id = ?', [invoiceId]);
  if (!r) throw notFound('Invoice');
  if (r.status !== 'disputed') throw conflict('Only a disputed invoice can be resolved');
  if (input.action === 'keep') {
    if (input.adjustment) throw badRequest('A correction needs "Fix and reissue"');
    run(db, `UPDATE invoices SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?, resolution_action = 'keep' WHERE id = ?`, [
      at.toISOString(), me.id, input.note, r.id,
    ]);
    return invoiceFor(db, me, { id: r.id });
  }
  if (!isUnpaid(r.runStatus)) throw conflict('This week has been paid, so the invoice cannot be reissued. Choose Keep as it is and correct it in a later week.');
  const adj = input.adjustment;
  if (adj && (!Number.isFinite(adj.amount) || adj.amount === 0 || Math.abs(adj.amount) > MONEY_MAX)) throw badRequest('Enter the correction in pounds, e.g. 20 or -12.50');
  transaction(db, () => {
    if (adj) {
      run(
        db,
        `INSERT INTO pay_adjustments (user_id, target_week_start, source_week_start, kind, amount, note, invoice_id, created_by, created_at)
         VALUES (?, ?, ?, 'dispute', ?, ?, ?, ?, ?)`,
        [r.userId, r.weekStart, r.weekStart, round2(adj.amount), adj.note?.trim() || `Correction after the dispute on invoice ${r.number}`, r.id, me.id, at.toISOString()],
      );
      recalculate(r.payrollRunId);
    }
    reissueInvoice(db, r.id, at, { reason: 'Fixed and reissued by the office', resolution: { note: input.note, by: me.id } });
  });
  bumpDataVersion();
  return invoiceFor(db, me, { id: r.id });
}

// ───────────────────────────── Mark paid ─────────────────────────────

export const NOT_ACCEPTED_MESSAGE = 'This invoice is not accepted yet. Open the run to mark it paid with a reason.';
export const DISPUTED_MESSAGE = 'This invoice is disputed, so it is held until the office answers. Resolve it first in Finance → Company → Disputed invoices: Keep as it is, or Fix and reissue.';

/**
 * STABLE hook (POST /finance/payroll/:id/pay, admin, before the UPDATE): the run's invoice must be accepted, deemed
 * accepted or resolved — else `overrideReason` (3–500 characters) lets the admin pay anyway; it is stored on the invoice
 * and the audit row says so. A disputed invoice is held until the office resolves it (lead decision): 409
 * invoice_disputed even with a reason. A run whose pay changed since its invoice was issued gets a new version first;
 * while that version waits for the person, 409 invoice_reissued (or pay it with a reason). A change that leaves the
 * payment as it was only refreshes the invoice.
 */
export function assertInvoicePayable(db: Db, run_: PayrollRunWithUser, me: UserWithTeam, body: unknown): void {
  const peek = get<{ id: number }>(db, `SELECT id FROM invoices WHERE payroll_run_id = ?`, [run_.id]);
  if (!peek) return; // no invoice: the 1.2 rules
  const at = businessNow();
  const { row, reissued } = freshRow(db, peek.id, at);
  const status = effectiveInvoiceStatus(row.status, deadlineOf(row), businessLocal(at));
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).overrideReason : undefined;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || reason.length < 3 || reason.length > 500)) {
    throw badRequest('Give a reason of 3 to 500 characters for paying without an accepted invoice');
  }
  // payable as it now stands: accepted, counted as accepted (its deadline has passed) or kept by the office. A version
  // issued late (a statement applied on payday) waits for the person, or for the admin's reason, like any other.
  if (isInvoicePayable(status)) return;
  if (status === 'disputed') {
    throw new HttpError(409, DISPUTED_MESSAGE, { code: 'invoice_disputed', invoiceId: row.id, status, deemedAcceptedAt: deadlineOf(row) });
  }
  if (!reason) {
    const details = { code: reissued ? 'invoice_reissued' : 'invoice_not_accepted', invoiceId: row.id, status, deemedAcceptedAt: deadlineOf(row) };
    throw new HttpError(409, reissued ? `The amounts changed, so the invoice was reissued. ${NOT_ACCEPTED_MESSAGE}` : NOT_ACCEPTED_MESSAGE, details);
  }
  run(db, `UPDATE invoices SET paid_override_reason = ?, paid_override_by = ?, paid_override_at = ? WHERE id = ?`, [reason, me.id, at.toISOString(), row.id]);
}

/** The invoice behind a run, for the audit trail of POST /finance/payroll/:id/pay (null: none). */
export function invoiceAuditFacts(db: Db, runId: number): { id: number; number: string; status: InvoiceStatus; overrideReason: string | null } | null {
  const r = invoiceRow(db, 'WHERE i.payroll_run_id = ?', [runId]);
  if (!r) return null;
  return { id: r.id, number: r.number, status: summaryOf(r, businessLocal()).status, overrideReason: r.paidOverrideReason };
}
