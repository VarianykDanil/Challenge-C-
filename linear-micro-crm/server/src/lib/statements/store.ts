/**
 * Release 1.3 — OWNED BY P3 statements. Commission statements from PDF to pay:
 *
 *  1. readStatementPdf(buf): pdfjs text → lines → the table and the period (shared logic/statements.ts).
 *  2. storeStatement(db, …): the campaign (given, else from the sender's address, else from the client's name in the PDF),
 *     the column mapping (the campaign's saved template, else detected from the header words), the rows, the matches
 *     (the person's client fundraiser ID for that campaign, else their exact full name), the status.
 *  3. statementPlan(db, statement): per matched person and pay week, logged vs confirmed — what Apply sends to P1's
 *     applyConfirmedSales as ConfirmedSalesRow[] (whole-week figures: the days this statement speaks for that person —
 *     its period plus their own rows' days outside it — and the week's other days, confirmed by another applied
 *     statement for that person or else as logged). A day is never counted twice: a sign-up dated the day before the
 *     period replaces what the person logged that day, and another applied statement for any of the same days blocks
 *     Apply. Weeks where the statement has nothing for a person are not sent.
 *  4. applyStatement(db, id, actorId): calls applyConfirmedSales and records the allocation per person and week, the
 *     effect, and the campaign's columns (when it had none), in one savepoint. Paid runs and pay lines are never
 *     touched here: P1 turns a paid week's difference into an adjustment. A statement for exactly the same period as an
 *     applied one replaces it: P1 hands that one's correction lines still on unpaid weeks to the new statement first
 *     (applyConfirmedSales' replacesStatementId), so it updates them in place (one line per person, week and
 *     campaign), and people only the old one listed go back to their logged subs (kept on the applied record).
 *  Re-review fixes: a sign-up dated after today or far outside the period blocks Apply; a listed person's days with
 *  no row are reported and hold the statement for review.
 *
 * Status: 'failed' (no text / no table / not a PDF), 'needs_review' (something to fix; the campaign's columns not saved
 * yet; rows dated outside the period; an email Gmail could not confirm came from the sender; or it would replace an
 * applied statement), 'parsed' (ready — a statement from email in this state is applied at once), 'applied'. Times:
 * statements from email keep the email's date; uploads use the business clock.
 */
import {
  allocateConfirmedToWeeks,
  detectStatementColumns,
  findStatementTable,
  formatStatementPeriod,
  isValidISODate,
  mappingByHeader,
  matchPersonByName,
  normalisePersonName,
  parseStatementPeriod,
  statementLines,
  statementRowsFromTable,
  statementTotalConfirmed,
  statementWeekStarts,
  STATEMENT_MAX_PERIOD_DAYS,
  type ApplyResult,
  type ConfirmedSalesRow,
  type StatementColumnMapping,
  type StatementDetail,
  type StatementDropped,
  type StatementLayout,
  type StatementNotListed,
  type StatementPersonSummary,
  type StatementPersonWeek,
  type StatementRow,
  type StatementRowDraft,
  type StatementRowMatch,
  type StatementSource,
  type StatementStatus,
  type StatementSummary,
  type StatementTemplate,
} from '@lm/shared';
import { all, get, placeholders, run, transaction, type Db } from '../../db/connection.ts';
import { ensurePayrollMaterialised } from '../../db/maintenance.ts';
import { bumpDataVersion } from '../cache.ts';
import { addDays, diffDays, mondayOf, nowISO, todayISO } from '../dates.ts';
import { HttpError, conflict, notFound } from '../errors.ts';
import { applyConfirmedSales } from '../payRule.ts';
import { recordSystemEvent } from '../audit/events.ts';
import { removeStatementFileIfUnused, saveStatementFile, sha256Of } from './files.ts';
import { extractPdfItems, StatementReadError } from './pdf.ts';

// ───────────────────────────── reading the PDF ─────────────────────────────

/** The table as kept in statements.table_json. */
export interface StoredTable {
  headers: string[];
  rows: string[][];
  totals: string[] | null;
  preamble: string[];
}

export interface ParsedPdf {
  table: StoredTable | null;
  period: { start: string; end: string } | null;
  /** Every line's text (to find the client's name). */
  texts: string[];
  /** Why it could not be read, in plain words; null when the table was found. */
  failure: string | null;
}

export const NO_TEXT_MESSAGE = 'This PDF has no text in it (it may be a scan or a photo). Ask the client for the original PDF, not a scan.';
export const NO_TABLE_MESSAGE =
  'Linear Hub could not find the table of fundraisers in this PDF. It looks for headings such as Name, Fundraiser ID, Sign-ups, Cancelled or Paid.';

/** pdfjs text → the table and the period. Never throws: a PDF that cannot be read comes back with `failure`. */
export async function readStatementPdf(buf: Uint8Array): Promise<ParsedPdf> {
  let items;
  try {
    items = (await extractPdfItems(buf)).items;
  } catch (err) {
    const message = err instanceof StatementReadError ? err.message : 'Linear Hub could not read this PDF.';
    return { table: null, period: null, texts: [], failure: message };
  }
  const lines = statementLines(items);
  const texts = lines.map((l) => l.text);
  if (!lines.length) return { table: null, period: null, texts, failure: NO_TEXT_MESSAGE };
  const found = findStatementTable(lines);
  const period = parseStatementPeriod(found ? [...found.preamble, ...texts] : texts);
  if (!found) return { table: null, period, texts, failure: NO_TABLE_MESSAGE };
  return { table: { headers: found.headers, rows: found.rows, totals: found.totals, preamble: found.preamble }, period, texts, failure: null };
}

// ───────────────────────────── rows from the database ─────────────────────────────

interface StatementDb {
  id: number;
  campaignId: number | null;
  campaignCode: string | null;
  campaignName: string | null;
  campaignColor: string | null;
  source: StatementSource;
  messageId: string | null;
  receivedAt: string;
  filePath: string | null;
  fileName: string | null;
  fileSha256: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: StatementStatus;
  error: string | null;
  appliedAt: string | null;
  appliedBy: number | null;
  appliedByName: string | null;
  tableJson: string | null;
  mappingJson: string | null;
  mappingSource: 'template' | 'detected' | null;
  layout: StatementLayout | null;
  effectJson: string | null;
  sender: string | null;
  subject: string | null;
  supersededBy: number | null;
  /** Email only: 1 when Gmail confirmed the sender (DKIM / DMARC aligned with From), 0 when not; null for an upload. */
  senderVerified: number | null;
}

const STATEMENT_SELECT = `
  SELECT s.id, s.campaign_id AS campaignId, c.code AS campaignCode, c.name AS campaignName, c.color AS campaignColor,
         s.source, s.message_id AS messageId, s.received_at AS receivedAt, s.file_path AS filePath, s.file_name AS fileName,
         s.file_sha256 AS fileSha256, s.period_start AS periodStart, s.period_end AS periodEnd, s.status, s.error,
         s.applied_at AS appliedAt, s.applied_by AS appliedBy,
         CASE WHEN a.id IS NULL THEN NULL ELSE TRIM(a.first_name || ' ' || a.last_name) END AS appliedByName,
         s.table_json AS tableJson, s.mapping_json AS mappingJson, s.mapping_source AS mappingSource, s.layout,
         s.effect_json AS effectJson, s.sender, s.subject, s.superseded_by AS supersededBy, s.sender_verified AS senderVerified
    FROM statements s
    LEFT JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN users a ON a.id = s.applied_by`;

interface RowDb {
  id: number;
  statementId: number;
  raw: string;
  fundraiserRef: string | null;
  name: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  saleDate: string | null;
  confirmed: number;
  cancelled: number | null;
  amount: number | null;
  userId: number | null;
  userName: string | null;
  match: StatementRowMatch;
}

const ROW_SELECT = `
  SELECT r.id, r.statement_id AS statementId, r.raw, r.fundraiser_ref AS fundraiserRef, r.name, r.period_start AS periodStart,
         r.period_end AS periodEnd, r.sale_date AS saleDate, r.confirmed, r.cancelled, r.amount, r.user_id AS userId,
         CASE WHEN u.id IS NULL THEN NULL ELSE TRIM(u.first_name || ' ' || u.last_name) END AS userName, r.match
    FROM statement_rows r
    LEFT JOIN users u ON u.id = r.user_id`;

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function loadStatement(db: Db, id: number): StatementDb | null {
  return get<StatementDb>(db, `${STATEMENT_SELECT} WHERE s.id = ?`, [id]) ?? null;
}

function loadRows(db: Db, statementId: number): RowDb[] {
  return all<RowDb>(db, `${ROW_SELECT} WHERE r.statement_id = ? ORDER BY r.id`, [statementId]);
}

function toRow(r: RowDb): StatementRow {
  return {
    id: r.id,
    statementId: r.statementId,
    fundraiserRef: r.fundraiserRef,
    name: r.name,
    saleDate: r.saleDate,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    confirmed: r.confirmed,
    cancelled: r.cancelled,
    amount: r.amount,
    userId: r.userId,
    userName: r.userName,
    match: r.match,
    raw: parseJson<Record<string, string>>(r.raw, {}),
  };
}

// ───────────────────────────── templates, senders, campaigns ─────────────────────────────

export function loadTemplate(db: Db, campaignId: number | null): StatementTemplate | null {
  if (!campaignId) return null;
  const row = get<{ mapping: string; updatedAt: string; updatedBy: number | null }>(
    db,
    `SELECT mapping, updated_at AS updatedAt, updated_by AS updatedBy FROM statement_templates WHERE campaign_id = ?`,
    [campaignId],
  );
  return row ? { campaignId, mapping: parseJson<StatementColumnMapping>(row.mapping, {}), updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
}

export function saveTemplate(db: Db, campaignId: number, mapping: StatementColumnMapping, actorId: number | null): StatementTemplate {
  const updatedAt = nowISO();
  run(
    db,
    `INSERT INTO statement_templates (campaign_id, mapping, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(campaign_id) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [campaignId, JSON.stringify(mapping), updatedAt, actorId],
  );
  return { campaignId, mapping, updatedAt, updatedBy: actorId };
}

/** The campaigns a sender's address is listed for. */
export function campaignsForSender(db: Db, address: string | null | undefined): number[] {
  if (!address) return [];
  return all<{ id: number }>(db, `SELECT campaign_id AS id FROM campaign_statement_senders WHERE address = ? ORDER BY campaign_id`, [address.trim()]).map((r) => r.id);
}

/** A campaign code (2–6 characters of anything) as literal text in a RegExp. */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** The one campaign whose name (or code, as a word) the PDF's text mentions; null when none or several. */
export function campaignFromText(db: Db, texts: readonly string[], among?: readonly number[]): number | null {
  const campaigns = all<{ id: number; name: string; code: string }>(db, `SELECT id, name, code FROM campaigns ORDER BY id`).filter((c) => !among?.length || among.includes(c.id));
  const text = ` ${normalisePersonName(texts.slice(0, 40).join(' '))} `;
  const raw = texts.slice(0, 12).join(' ');
  const byName = campaigns.filter((c) => text.includes(` ${normalisePersonName(c.name)} `));
  if (byName.length === 1) return byName[0]!.id;
  const byCode = campaigns.filter((c) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(c.code)}([^A-Za-z0-9]|$)`).test(raw));
  if (!byName.length && byCode.length === 1) return byCode[0]!.id;
  return among?.length === 1 ? among[0]! : null;
}

// ───────────────────────────── storing a statement ─────────────────────────────

export interface StoreInput {
  parsed: ParsedPdf;
  file: { relPath: string; sha256: string } | null;
  fileName: string | null;
  source: StatementSource;
  messageId?: string | null;
  sender?: string | null;
  subject?: string | null;
  receivedAt: string;
  campaignId?: number | null;
  /** Email only: Gmail confirmed the message came from the sender's domain (lib/statements/mail.ts senderAuthenticated). */
  senderVerified?: boolean;
}

interface ReadOutcome {
  mapping: StatementColumnMapping;
  mappingSource: 'template' | 'detected';
  layout: StatementLayout;
  drafts: StatementRowDraft[];
  problems: string[];
}

/** The rows of a stored table under the campaign's template (or the detected columns). */
function readTable(db: Db, table: StoredTable, campaignId: number | null): ReadOutcome {
  const template = loadTemplate(db, campaignId);
  const mapping = template?.mapping ?? detectStatementColumns(table.headers, table.rows.slice(0, 12));
  const read = statementRowsFromTable(table, mapping);
  return { mapping, mappingSource: template ? 'template' : 'detected', layout: read.layout, drafts: read.drafts, problems: read.problems };
}

/** A period from the rows when the PDF states none: the row periods' span, else the sign-up dates' span. */
function periodFromDrafts(drafts: readonly StatementRowDraft[]): { start: string; end: string } | null {
  const starts = drafts.map((d) => d.periodStart ?? d.saleDate).filter((d): d is string => Boolean(d)).sort();
  const ends = drafts.map((d) => d.periodEnd ?? d.saleDate).filter((d): d is string => Boolean(d)).sort();
  if (!starts.length || !ends.length) return null;
  const start = starts[0]!;
  const end = ends[ends.length - 1]!;
  return diffDays(start, end) < STATEMENT_MAX_PERIOD_DAYS ? { start, end } : null;
}

function insertRows(db: Db, statementId: number, drafts: readonly StatementRowDraft[]): void {
  const insert = db.prepare(
    `INSERT INTO statement_rows (statement_id, raw, fundraiser_ref, name, period_start, period_end, sale_date, confirmed, cancelled, amount, user_id, match)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'none')`,
  );
  for (const d of drafts) {
    insert.run(statementId, JSON.stringify(d.raw), d.fundraiserRef, d.name, d.periodStart, d.periodEnd, d.saleDate, d.confirmed, d.cancelled, d.amount);
  }
}

/**
 * Stores a read statement (plain SQL: the caller holds the transaction — the demo seed's, or its own) and returns its
 * id. The rows are matched and the status set.
 */
export function storeStatement(db: Db, input: StoreInput): number {
  const { parsed } = input;
  let campaignId = input.campaignId ?? null;
  if (!campaignId) {
    const bySender = campaignsForSender(db, input.sender);
    campaignId = bySender.length === 1 ? bySender[0]! : campaignFromText(db, parsed.texts, bySender);
  }
  const outcome = parsed.table ? readTable(db, parsed.table, campaignId) : null;
  const period = parsed.period ?? (outcome ? periodFromDrafts(outcome.drafts) : null);
  const id = run(
    db,
    `INSERT INTO statements (campaign_id, source, message_id, received_at, file_path, file_name, file_sha256, period_start, period_end, status, error,
                             table_json, mapping_json, mapping_source, layout, sender, subject, sender_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      campaignId, input.source, input.messageId ?? null, input.receivedAt, input.file?.relPath ?? null, input.fileName, input.file?.sha256 ?? null,
      period?.start ?? null, period?.end ?? null, parsed.failure ? 'failed' : 'needs_review', parsed.failure,
      parsed.table ? JSON.stringify(parsed.table) : null, outcome ? JSON.stringify(outcome.mapping) : null, outcome?.mappingSource ?? null,
      outcome?.layout ?? null, input.sender ?? null, input.subject ?? null,
      input.source === 'email' ? (input.senderVerified ? 1 : 0) : null,
    ],
  ).lastInsertRowid;
  if (outcome) insertRows(db, id, outcome.drafts);
  autoMatch(db, [id]);
  refreshStatus(db, id);
  return id;
}

export interface IngestInput {
  buf: Buffer;
  fileName: string | null;
  source: StatementSource;
  messageId?: string | null;
  sender?: string | null;
  subject?: string | null;
  receivedAt: string;
  campaignId?: number | null;
  /** Email only: Gmail confirmed the sender (only then can it apply itself). */
  senderVerified?: boolean;
}

export interface IngestResult {
  statementId: number;
  /** True when this PDF (same bytes) or this email attachment was stored before; nothing new was written. */
  duplicate: boolean;
  status: StatementStatus;
  applied: boolean;
}

/** The statement already stored with these bytes or this email attachment, if any. */
export function existingStatement(db: Db, sha256: string, messageId?: string | null): number | null {
  const row = get<{ id: number }>(db, `SELECT id FROM statements WHERE file_sha256 = ? OR (? IS NOT NULL AND message_id = ?) ORDER BY id LIMIT 1`, [sha256, messageId ?? null, messageId ?? null]);
  return row?.id ?? null;
}

/**
 * A new statement PDF (an upload or an email attachment): read it, keep the file, store and match the rows. A statement
 * from email that is ready ('parsed': every row matched, the campaign's columns saved, every row inside its period, the
 * sender confirmed by Gmail, nothing applied for the same period) is applied at once (actor "Linear Hub").
 */
export async function ingestStatement(db: Db, input: IngestInput): Promise<IngestResult> {
  const sha = sha256Of(input.buf);
  const before = existingStatement(db, sha, input.messageId);
  if (before) return { statementId: before, duplicate: true, status: loadStatement(db, before)!.status, applied: false };
  const parsed = await readStatementPdf(input.buf);
  const again = existingStatement(db, sha, input.messageId); // another request may have stored it meanwhile
  if (again) return { statementId: again, duplicate: true, status: loadStatement(db, again)!.status, applied: false };
  const file = saveStatementFile(db, input.buf);
  const id = transaction(db, () => storeStatement(db, { ...input, parsed, file }));
  bumpDataVersion();
  let status = loadStatement(db, id)!.status;
  let applied = false;
  if (input.source === 'email' && status === 'parsed') {
    try {
      applyStatement(db, id, null);
      applied = true;
      status = 'applied';
    } catch (err) {
      console.error(`Statement ${id}: applying it automatically failed; it waits for the office`, err);
    }
  }
  return { statementId: id, duplicate: false, status, applied };
}

// ───────────────────────────── matching ─────────────────────────────

interface Person {
  id: number;
  firstName: string;
  lastName: string;
}

/** Matches rows of these statements that nobody picked by hand: the client ID for the campaign, else the exact full name. */
export function autoMatch(db: Db, statementIds: readonly number[]): number {
  if (!statementIds.length) return 0;
  const rows = all<{ id: number; campaignId: number | null; ref: string | null; name: string | null; userId: number | null; match: StatementRowMatch }>(
    db,
    `SELECT r.id, s.campaign_id AS campaignId, r.fundraiser_ref AS ref, r.name, r.user_id AS userId, r.match
       FROM statement_rows r JOIN statements s ON s.id = r.statement_id
      WHERE r.statement_id IN (${placeholders(statementIds.length)}) AND s.status <> 'applied' AND r.match <> 'manual'`,
    [...statementIds],
  );
  if (!rows.length) return 0;
  const campaignIds = [...new Set(rows.map((r) => r.campaignId).filter((c): c is number => c !== null))];
  const refs = new Map<string, number>();
  if (campaignIds.length) {
    for (const r of all<{ campaignId: number; ref: string; userId: number }>(
      db,
      `SELECT campaign_id AS campaignId, ref, user_id AS userId FROM user_client_refs WHERE campaign_id IN (${placeholders(campaignIds.length)})`,
      campaignIds,
    )) {
      refs.set(`${r.campaignId}|${r.ref.trim().toLowerCase()}`, r.userId);
    }
  }
  const people = all<Person>(db, `SELECT id, first_name AS firstName, last_name AS lastName FROM users u WHERE u.role <> 'client' ORDER BY id`);
  const update = db.prepare(`UPDATE statement_rows SET user_id = ?, match = ? WHERE id = ?`);
  let changed = 0;
  for (const r of rows) {
    const byRef = r.campaignId && r.ref ? (refs.get(`${r.campaignId}|${r.ref.trim().toLowerCase()}`) ?? null) : null;
    const userId = byRef ?? matchPersonByName(r.name, people);
    const match: StatementRowMatch = userId ? 'auto' : 'none';
    if (userId !== r.userId || match !== r.match) {
      update.run(userId, match, r.id);
      changed++;
    }
  }
  return changed;
}

/** Unapplied statements of these campaigns: match their rows again (after client IDs changed). */
export function rematchCampaigns(db: Db, campaignIds: readonly number[]): void {
  if (!campaignIds.length) return;
  const ids = all<{ id: number }>(
    db,
    `SELECT id FROM statements WHERE status <> 'applied' AND campaign_id IN (${placeholders(campaignIds.length)})`,
    [...campaignIds],
  ).map((r) => r.id);
  autoMatch(db, ids);
  for (const id of ids) refreshStatus(db, id);
}

/** Re-reads unapplied statements of a campaign from their stored tables (after its columns were saved), keeping picks. */
export function rereadCampaign(db: Db, campaignId: number): number {
  const ids = all<{ id: number }>(db, `SELECT id FROM statements WHERE status <> 'applied' AND campaign_id = ? AND table_json IS NOT NULL`, [campaignId]).map((r) => r.id);
  for (const id of ids) rereadStatement(db, id);
  return ids.length;
}

const pickKey = (r: { fundraiserRef: string | null; name: string | null; saleDate: string | null }) =>
  `${(r.fundraiserRef ?? '').toLowerCase()}|${normalisePersonName(r.name ?? '')}|${r.saleDate ?? ''}`;

function rereadStatement(db: Db, id: number): void {
  const st = loadStatement(db, id);
  if (!st || st.status === 'applied' || !st.tableJson) return;
  const table = parseJson<StoredTable | null>(st.tableJson, null);
  if (!table) return;
  const picks = new Map<string, number | null>();
  for (const r of loadRows(db, id)) if (r.match === 'manual') picks.set(pickKey(r), r.userId);
  const outcome = readTable(db, table, st.campaignId);
  run(db, `DELETE FROM statement_rows WHERE statement_id = ?`, [id]);
  insertRows(db, id, outcome.drafts);
  run(db, `UPDATE statements SET mapping_json = ?, mapping_source = ?, layout = ? WHERE id = ?`, [JSON.stringify(outcome.mapping), outcome.mappingSource, outcome.layout, id]);
  if (!st.periodStart) {
    const p = periodFromDrafts(outcome.drafts);
    if (p) run(db, `UPDATE statements SET period_start = ?, period_end = ? WHERE id = ?`, [p.start, p.end, id]);
  }
  if (picks.size) {
    const update = db.prepare(`UPDATE statement_rows SET user_id = ?, match = 'manual' WHERE id = ?`);
    for (const r of loadRows(db, id)) {
      const key = pickKey(r);
      if (picks.has(key)) update.run(picks.get(key) ?? null, r.id);
    }
  }
  autoMatch(db, [id]);
  refreshStatus(db, id);
}

// ───────────────────────────── what a statement means for pay ─────────────────────────────

export interface StatementPlan {
  people: StatementPersonSummary[];
  notListed: StatementNotListed[];
  /** People on the statement this one replaces who are not on this one (their weeks go back to the subs they logged). */
  dropped: StatementDropped[];
  rows: ConfirmedSalesRow[];
  /** Per person and week, this statement's own days (what statement_allocations keeps). */
  allocations: { userId: number; weekStart: string; logged: number; confirmed: number; weekConfirmed: number }[];
}

const maxIso = (a: string, b: string) => (a > b ? a : b);
const minIso = (a: string, b: string) => (a < b ? a : b);

/** A run of days (inclusive). */
interface Span {
  start: string;
  end: string;
}

const inSpans = (d: string, spans: readonly Span[]) => spans.some((x) => d >= x.start && d <= x.end);
const spansMeet = (a: readonly Span[], b: readonly Span[]) => a.some((x) => b.some((y) => x.start <= y.end && y.start <= x.end));

interface DatedRow {
  saleDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/** A row's own days: its sign-up date, else its own period (the statement's when it states none). */
function rowSpan(r: DatedRow, P: Span): Span {
  if (r.saleDate) return { start: r.saleDate, end: r.saleDate };
  return { start: r.periodStart ?? P.start, end: r.periodEnd ?? P.end };
}

/** True when a row's own days reach outside the statement's period (a sign-up dated before it, a longer row period). */
export function rowOutsidePeriod(r: DatedRow, P: Span): boolean {
  const x = rowSpan(r, P);
  return x.start < P.start || x.end > P.end;
}

/**
 * The days a statement speaks for: its period and the own days of each of `rows` that reach outside it. For one
 * person's rows, the days it speaks for that person — so a sign-up dated the day before the period replaces what that
 * person logged that day (never adds to it), and says nothing about anyone else's sales that day.
 */
function spansOf(P: Span, rows: readonly DatedRow[]): Span[] {
  const out: Span[] = [P];
  for (const r of rows) if (rowOutsidePeriod(r, P)) out.push(rowSpan(r, P));
  return out;
}

/** The Mondays of every week the spans touch. */
function weeksOf(spans: readonly Span[]): string[] {
  const out = new Set<string>();
  for (const x of spans) for (let m = mondayOf(x.start); m <= x.end; m = addDays(m, 7)) out.add(m);
  return [...out].sort();
}

/** The rows that count for someone: matched, or still waiting for a pick (not the ones marked "not one of ours"). */
const countingRows = <T extends { userId: number | null; match: StatementRowMatch }>(rows: readonly T[]) => rows.filter((r) => r.userId !== null || r.match === 'none');

interface AppliedLink {
  id: number;
  receivedAt: string;
  appliedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/** The applied statement a statement replaces: the same campaign and exactly the same period (not this one). */
export function replacedStatement(db: Db, st: { id: number; campaignId: number | null; periodStart: string | null; periodEnd: string | null; status: StatementStatus }): AppliedLink | null {
  if (!st.campaignId || !st.periodStart || !st.periodEnd) return null;
  if (st.status === 'applied') {
    // an applied statement: the one it replaced when it was applied
    return get<AppliedLink>(db, `SELECT id, received_at AS receivedAt, applied_at AS appliedAt, period_start AS periodStart, period_end AS periodEnd FROM statements WHERE superseded_by = ? ORDER BY id DESC LIMIT 1`, [st.id]) ?? null;
  }
  return (
    get<AppliedLink>(
      db,
      `SELECT id, received_at AS receivedAt, applied_at AS appliedAt, period_start AS periodStart, period_end AS periodEnd FROM statements
        WHERE campaign_id = ? AND status = 'applied' AND superseded_by IS NULL AND id <> ? AND period_start = ? AND period_end = ?
        ORDER BY id DESC LIMIT 1`,
      [st.campaignId, st.id, st.periodStart, st.periodEnd],
    ) ?? null
  );
}

/** Another applied statement of the campaign, with the days it speaks for. */
interface Neighbour {
  id: number;
  period: Span;
  /** Its period and every row's own days outside it. */
  spans: Span[];
  /** Per person, their rows' own days outside its period. */
  extra: Map<number, Span[]>;
}

/**
 * The other applied statements of the campaign that speak for any day from `from` to `to`: not replaced, not this one,
 * and not the one this one replaces (exactly the same period). Two grouped queries.
 */
function appliedNeighbours(db: Db, st: StatementDb, from: string, to: string): Neighbour[] {
  if (!st.campaignId) return [];
  const list = all<{ id: number; start: string; end: string }>(
    db,
    `SELECT s.id, s.period_start AS start, s.period_end AS end FROM statements s
      WHERE s.campaign_id = ? AND s.status = 'applied' AND s.superseded_by IS NULL AND s.id <> ?
        AND s.period_start IS NOT NULL AND s.period_end IS NOT NULL
        AND NOT (s.period_start IS ? AND s.period_end IS ?)
        AND ((s.period_start <= ? AND s.period_end >= ?)
             OR EXISTS (SELECT 1 FROM statement_rows r WHERE r.statement_id = s.id
                         AND COALESCE(r.sale_date, r.period_start, s.period_start) <= ? AND COALESCE(r.sale_date, r.period_end, s.period_end) >= ?))`,
    [st.campaignId, st.id, st.periodStart, st.periodEnd, to, from, to, from],
  );
  if (!list.length) return [];
  const out = new Map<number, Neighbour>(list.map((o) => [o.id, { id: o.id, period: { start: o.start, end: o.end }, spans: [{ start: o.start, end: o.end }], extra: new Map() }]));
  for (const r of all<{ statementId: number; userId: number | null; saleDate: string | null; periodStart: string | null; periodEnd: string | null }>(
    db,
    `SELECT r.statement_id AS statementId, r.user_id AS userId, r.sale_date AS saleDate, r.period_start AS periodStart, r.period_end AS periodEnd
       FROM statement_rows r JOIN statements s ON s.id = r.statement_id
      WHERE r.statement_id IN (${placeholders(list.length)})
        AND (COALESCE(r.sale_date, r.period_start, s.period_start) < s.period_start OR COALESCE(r.sale_date, r.period_end, s.period_end) > s.period_end)`,
    list.map((o) => o.id),
  )) {
    const n = out.get(r.statementId)!;
    const x = rowSpan(r, n.period);
    n.spans.push(x);
    if (r.userId !== null) n.extra.set(r.userId, [...(n.extra.get(r.userId) ?? []), x]);
  }
  return [...out.values()];
}

/**
 * Per matched person and pay week: logged vs confirmed, and the whole-week figures Apply sends to pay.
 *
 * For each person the statement speaks for its period and their own rows' days (a sign-up dated outside the period
 * counts on its own day, in place of what they logged that day). A week's other days count as another applied
 * statement confirmed them for that person, else as logged. A week where the statement has nothing for the person
 * (nothing logged, nothing confirmed on its days) is not sent. When the statement replaces an applied one for the same
 * period, every week that one sent is sent again, and people it listed who are not on this one go back to their logged
 * subs (`dropped`).
 */
export function statementPlan(db: Db, st: StatementDb, rows: readonly RowDb[]): StatementPlan {
  const empty: StatementPlan = { people: [], notListed: [], dropped: [], rows: [], allocations: [] };
  if (!st.campaignId || !st.periodStart || !st.periodEnd) return empty;
  const P: Span = { start: st.periodStart, end: st.periodEnd };
  const matched = rows.filter((r) => r.userId !== null);
  const byPerson = new Map<number, RowDb[]>();
  for (const r of matched) byPerson.set(r.userId!, [...(byPerson.get(r.userId!) ?? []), r]);

  // the statement this one replaces: every (person, week) it sent is sent again
  const replaced = replacedStatement(db, st);
  const replacedWeeks = new Map<number, Map<string, number>>(); // userId → week → what it confirmed
  if (replaced) {
    for (const a of all<{ userId: number; weekStart: string; confirmed: number }>(
      db,
      `SELECT user_id AS userId, week_start AS weekStart, confirmed FROM statement_allocations WHERE statement_id = ?`,
      [replaced.id],
    )) {
      const m = replacedWeeks.get(a.userId) ?? new Map<string, number>();
      m.set(a.weekStart, a.confirmed);
      replacedWeeks.set(a.userId, m);
    }
  }

  // every week the statement (or the one it replaces) touches
  const touched = spansOf(P, matched);
  for (const m of replacedWeeks.values()) for (const w of m.keys()) touched.push({ start: w, end: addDays(w, 6) });
  const rangeFrom = mondayOf(touched.reduce((a, x) => minIso(a, x.start), P.start));
  const rangeTo = addDays(mondayOf(touched.reduce((a, x) => maxIso(a, x.end), P.end)), 6);

  // Subs logged for the campaign per person and day, for every week the statement touches (one grouped query).
  const logged = new Map<number, Map<string, number>>();
  const names = new Map<number, string>();
  for (const g of all<{ userId: number; date: string; sales: number; name: string }>(
    db,
    `SELECT g.user_id AS userId, g.date, SUM(g.sales) AS sales, TRIM(u.first_name || ' ' || u.last_name) AS name
       FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN users u ON u.id = g.user_id
      WHERE e.campaign_id = ? AND g.date BETWEEN ? AND ? AND u.role <> 'client'
      GROUP BY g.user_id, g.date`,
    [st.campaignId, rangeFrom, rangeTo],
  )) {
    let m = logged.get(g.userId);
    if (!m) logged.set(g.userId, (m = new Map()));
    m.set(g.date, g.sales);
    names.set(g.userId, g.name);
  }
  const loggedBetween = (userId: number, from: string, to: string) => {
    let n = 0;
    for (const [date, sales] of logged.get(userId) ?? []) if (date >= from && date <= to) n += sales;
    return n;
  };

  // What other applied statements of the campaign confirmed for the same weeks (their own days only).
  const neighbours = appliedNeighbours(db, st, rangeFrom, rangeTo);
  const otherAlloc = new Map<string, number>(); // `${statementId}|${userId}|${week}` → confirmed
  if (neighbours.length) {
    for (const a of all<{ statementId: number; userId: number; weekStart: string; confirmed: number }>(
      db,
      `SELECT statement_id AS statementId, user_id AS userId, week_start AS weekStart, confirmed FROM statement_allocations
        WHERE statement_id IN (${placeholders(neighbours.length)})`,
      neighbours.map((o) => o.id),
    )) {
      otherAlloc.set(`${a.statementId}|${a.userId}|${a.weekStart}`, a.confirmed);
    }
  }

  /** One person's week: their logged subs on the statement's days for them, what it confirmed, and the whole week. */
  const weekOf = (userId: number, w: string, mine: readonly Span[], ownConfirmed: number | null): StatementPersonWeek => {
    let ownLogged = 0;
    let outside = 0;
    const used = new Set<number>();
    for (let d = w; d <= addDays(w, 6); d = addDays(d, 1)) {
      const sales = logged.get(userId)?.get(d) ?? 0;
      if (inSpans(d, mine)) {
        ownLogged += sales;
        continue;
      }
      // another applied statement that speaks for this person on that day keeps its own figure for the week
      const other = neighbours.find((o) => otherAlloc.has(`${o.id}|${userId}|${w}`) && (inSpans(d, [o.period]) || inSpans(d, o.extra.get(userId) ?? [])));
      if (other) {
        if (!used.has(other.id)) {
          used.add(other.id);
          outside += otherAlloc.get(`${other.id}|${userId}|${w}`)!;
        }
      } else outside += sales;
    }
    const confirmed = ownConfirmed ?? ownLogged; // null: not on this statement, so as logged
    return { weekStart: w, logged: ownLogged, confirmed, cancelled: Math.max(0, ownLogged - confirmed), weekConfirmed: confirmed + outside };
  };

  const people: StatementPersonSummary[] = [];
  const out: ConfirmedSalesRow[] = [];
  const allocations: StatementPlan['allocations'] = [];
  for (const [userId, list] of [...byPerson].sort((a, b) => a[0] - b[0])) {
    const mine = spansOf(P, list);
    const confirmedByWeek = new Map<string, number>();
    const addConfirmed = (w: string, n: number) => confirmedByWeek.set(w, (confirmedByWeek.get(w) ?? 0) + n);
    // per-sub rows: each sign-up counts in its own week
    for (const r of list) if (r.saleDate) addConfirmed(mondayOf(r.saleDate), r.confirmed);
    // totals rows: the row period's total spread over its weeks, cancellations off the latest week first
    const groups = new Map<string, { start: string; end: string; confirmed: number }>();
    for (const r of list.filter((x) => !x.saleDate)) {
      const x = rowSpan(r, P);
      const g = groups.get(`${x.start}|${x.end}`) ?? { ...x, confirmed: 0 };
      g.confirmed += r.confirmed;
      groups.set(`${x.start}|${x.end}`, g);
    }
    for (const g of groups.values()) {
      const weeks = statementWeekStarts(g.start, g.end).map((w) => ({ weekStart: w, logged: loggedBetween(userId, maxIso(g.start, w), minIso(g.end, addDays(w, 6))) }));
      for (const a of allocateConfirmedToWeeks(weeks, g.confirmed)) addConfirmed(a.weekStart, a.confirmed);
    }
    const before = replacedWeeks.get(userId);
    const weeks: StatementPersonWeek[] = [];
    for (const w of [...new Set([...weeksOf(mine), ...confirmedByWeek.keys(), ...(before?.keys() ?? [])])].sort()) {
      const wk = weekOf(userId, w, mine, confirmedByWeek.get(w) ?? 0);
      // nothing on this statement for the person that week (and nothing to undo): pay is left as it is
      if (wk.logged === 0 && wk.confirmed === 0 && !before?.has(w)) continue;
      weeks.push(wk);
      allocations.push({ userId, weekStart: w, logged: wk.logged, confirmed: wk.confirmed, weekConfirmed: wk.weekConfirmed });
      out.push({ userId, campaignId: st.campaignId, weekStart: w, confirmed: wk.weekConfirmed, statementRowIds: list.map((r) => r.id) });
    }
    people.push({
      userId,
      userName: list[0]!.userName ?? names.get(userId) ?? 'Someone',
      logged: weeks.reduce((n, x) => n + x.logged, 0),
      confirmed: weeks.reduce((n, x) => n + x.confirmed, 0),
      cancelled: weeks.reduce((n, x) => n + x.cancelled, 0),
      weeks,
    });
  }
  people.sort((a, b) => a.userName.localeCompare(b.userName));

  // On the statement this one replaces but not on this one: back to what they logged (and no allocation of ours).
  const dropped: StatementDropped[] = [];
  const droppedIds = [...replacedWeeks.keys()].filter((id) => !byPerson.has(id));
  if (droppedIds.length) {
    const who = new Map(all<{ id: number; name: string }>(db, `SELECT id, TRIM(first_name || ' ' || last_name) AS name FROM users WHERE id IN (${placeholders(droppedIds.length)})`, droppedIds).map((u) => [u.id, u.name]));
    for (const userId of droppedIds.sort((a, b) => a - b)) {
      if (!who.has(userId)) continue; // a person deleted since
      const before = replacedWeeks.get(userId)!;
      let n = 0;
      for (const w of [...before.keys()].sort()) {
        const wk = weekOf(userId, w, [P], null);
        n += wk.logged;
        // P1 words their line "Not on BCN's corrected statement: back to the 22 subs logged" (re-review fix)
        out.push({ userId, campaignId: st.campaignId, weekStart: w, confirmed: wk.weekConfirmed, statementRowIds: [], notOnStatement: true });
      }
      dropped.push({ userId, userName: who.get(userId)!, logged: n, confirmedBefore: [...before.values()].reduce((a, b) => a + b, 0) });
    }
    dropped.sort((a, b) => a.userName.localeCompare(b.userName));
  }

  // Who logged sales in the period but is on no row — only once every row is matched (an unmatched row may be them).
  const notListed: StatementNotListed[] = [];
  for (const [userId] of rows.some((r) => r.match === 'none') ? [] : logged) {
    if (byPerson.has(userId) || replacedWeeks.has(userId)) continue;
    const n = loggedBetween(userId, P.start, P.end);
    if (n > 0) notListed.push({ userId, userName: names.get(userId) ?? 'Someone', logged: n });
  }
  notListed.sort((a, b) => a.userName.localeCompare(b.userName));
  return { people, notListed, dropped, rows: out, allocations };
}

// ───────────────────────────── blockers, warnings, status ─────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How far outside its period a row's own days may reach before Apply is blocked (re-review fix): a sign-up dated the
 * day before is normal, a date months away is a typo'd year or a US-format date.
 */
export const STATEMENT_DATE_SLACK_DAYS = 31;

/** "Thu 14 Oct 2027": a day with its year (a far date must show it). */
function dayWithYear(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

/** "w/c 28 Sep" (with the year when it is not this year's). */
function weekLabel(monday: string, today = todayISO()): string {
  const d = new Date(`${monday.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return `w/c ${monday}`;
  return `w/c ${d.getDate()} ${MON[d.getMonth()]}${monday.slice(0, 4) === today.slice(0, 4) ? '' : ` ${d.getFullYear()}`}`;
}

/**
 * Rows whose own dates cannot be right (re-review fix): a sign-up dated after today, or a row reaching more than
 * STATEMENT_DATE_SLACK_DAYS outside the statement's period. Apply is blocked until the dates are checked (a row can be
 * marked as not one of ours); otherwise the confirmation would be written for a week far away and take that week over.
 */
function implausibleDates(st: StatementDb, rows: readonly RowDb[], today = todayISO()): string[] {
  if (!st.periodStart || !st.periodEnd) return [];
  const P: Span = { start: st.periodStart, end: st.periodEnd };
  const counting = countingRows(rows);
  const isFuture = (r: RowDb) => (r.saleDate ?? r.periodStart ?? '') > today;
  const future = counting.filter(isFuture);
  const far = counting.filter((r) => {
    if (isFuture(r)) return false;
    const x = rowSpan(r, P);
    return x.start < addDays(P.start, -STATEMENT_DATE_SLACK_DAYS) || x.end > addDays(P.end, STATEMENT_DATE_SLACK_DAYS);
  });
  const say = (list: readonly RowDb[], why: string): string => {
    const r = list[0]!;
    const who = r.userName ?? r.name ?? r.fundraiserRef ?? 'someone';
    const when = r.saleDate ? dayWithYear(r.saleDate) : formatStatementPeriod(r.periodStart, r.periodEnd);
    if (list.length === 1) {
      return `${r.saleDate ? `A sign-up for ${who} is dated` : `A row for ${who} covers`} ${when}, ${why}. Check the dates with the PDF, or mark the row as not one of ours.`;
    }
    const what = list.every((x) => x.saleDate) ? `${list.length} sign-ups are dated` : `${list.length} rows have dates`;
    return `${what} ${why} (the first: ${who}, ${when}). Check the dates with the PDF, or mark the rows as not one of ours.`;
  };
  const out: string[] = [];
  if (future.length) out.push(say(future, 'after today'));
  if (far.length) out.push(say(far, `more than ${STATEMENT_DATE_SLACK_DAYS} days outside the statement's period (${formatStatementPeriod(P.start, P.end)})`));
  return out;
}

/** A listed person's sales on days in the statement's period that none of their rows covers. */
export interface SilentDays {
  userId: number;
  userName: string;
  /** The Mondays of the weeks those days are in. */
  weeks: string[];
  logged: number;
}

/**
 * Re-review fix: someone listed on a totals statement whose rows (each with its own period) leave some of the
 * statement's days out. Those days count as 0 confirmed, so every sale they logged then counts as cancelled — the
 * client may mean that, or may have left a row out. Apply still works; a warning says which weeks, and the statement
 * never applies itself (refreshStatus). A per-sub statement lists each successful sub, so a week with none of theirs
 * is read as 0 on purpose and is not reported. One grouped query, only when a row has a period of its own.
 */
export function silentDays(db: Db, st: StatementDb, rows: readonly RowDb[]): SilentDays[] {
  if (!st.campaignId || !st.periodStart || !st.periodEnd) return [];
  const P: Span = { start: st.periodStart, end: st.periodEnd };
  const byPerson = new Map<number, RowDb[]>();
  for (const r of rows) if (r.userId !== null) byPerson.set(r.userId, [...(byPerson.get(r.userId) ?? []), r]);
  const gaps = new Map<number, Span[]>();
  for (const [userId, list] of byPerson) {
    if (list.some((r) => r.saleDate) || !list.some((r) => r.periodStart || r.periodEnd)) continue;
    const spans = list.map((r) => rowSpan(r, P));
    const out: Span[] = [];
    for (let d = P.start; d <= P.end; d = addDays(d, 1)) {
      if (inSpans(d, spans)) continue;
      const last = out[out.length - 1];
      if (last && addDays(last.end, 1) === d) last.end = d;
      else out.push({ start: d, end: d });
    }
    if (out.length) gaps.set(userId, out);
  }
  if (!gaps.size) return [];
  const ids = [...gaps.keys()];
  const found = new Map<number, { name: string; logged: number; weeks: Set<string> }>();
  for (const g of all<{ userId: number; date: string; sales: number; name: string }>(
    db,
    `SELECT g.user_id AS userId, g.date, SUM(g.sales) AS sales, TRIM(u.first_name || ' ' || u.last_name) AS name
       FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN users u ON u.id = g.user_id
      WHERE e.campaign_id = ? AND g.date BETWEEN ? AND ? AND g.user_id IN (${placeholders(ids.length)})
      GROUP BY g.user_id, g.date HAVING SUM(g.sales) > 0`,
    [st.campaignId, P.start, P.end, ...ids],
  )) {
    if (!inSpans(g.date, gaps.get(g.userId)!)) continue;
    const f = found.get(g.userId) ?? { name: g.name, logged: 0, weeks: new Set<string>() };
    f.logged += Number(g.sales);
    f.weeks.add(mondayOf(g.date));
    found.set(g.userId, f);
  }
  return [...found]
    .map(([userId, f]) => ({ userId, userName: f.name, logged: f.logged, weeks: [...f.weeks].sort() }))
    .sort((a, b) => a.userName.localeCompare(b.userName));
}

/** Why Apply is not possible yet, in plain words. */
function blockersFor(db: Db, st: StatementDb, rows: readonly RowDb[], problems: readonly string[]): string[] {
  if (st.status === 'applied') return ['This statement is already applied.'];
  if (!st.tableJson) return [st.error ?? NO_TABLE_MESSAGE];
  const out: string[] = [];
  if (!st.campaignId) out.push('Pick the campaign this statement is for.');
  if (!st.periodStart || !st.periodEnd) out.push('Set the period the statement covers (the PDF does not say).');
  out.push(...problems);
  if (!rows.length) out.push('The table has no rows Linear Hub could read. Check the columns.');
  const unmatched = rows.filter((r) => r.match === 'none').length;
  if (unmatched) out.push(`${plural(unmatched, 'row is', 'rows are')} not matched to anyone yet: pick the person, or mark the row as not one of ours.`);
  else if (rows.length && !rows.some((r) => r.userId !== null)) out.push('Every row is marked as not one of ours, so there is nothing to apply.');
  out.push(...implausibleDates(st, rows));
  if (st.campaignId && st.periodStart && st.periodEnd) {
    const P: Span = { start: st.periodStart, end: st.periodEnd };
    const mine = spansOf(P, countingRows(rows));
    const from = mine.reduce((a, x) => minIso(a, x.start), P.start);
    const to = mine.reduce((a, x) => maxIso(a, x.end), P.end);
    const which = [st.campaignCode, 'statement'].filter(Boolean).join(' ');
    // another applied statement for some of the same days: the two would both count them (exactly the same period is a
    // replacement, not an overlap)
    for (const o of appliedNeighbours(db, st, from, to)) {
      if (spansMeet([P], [o.period])) {
        out.push(`Its period overlaps the ${which} for ${formatStatementPeriod(o.period.start, o.period.end)} that is already applied. Check the dates.`);
        break;
      }
      if (spansMeet(mine, o.spans)) {
        out.push(`Some of its dates are already covered by the ${which} for ${formatStatementPeriod(o.period.start, o.period.end)}, which is applied, so they would count twice. Check the dates.`);
        break;
      }
    }
  }
  return out;
}

/** Rows whose own days reach outside the statement's period (not the ones marked "not one of ours"). */
function outsidePeriodCount(st: { periodStart: string | null; periodEnd: string | null }, rows: readonly RowDb[]): number {
  if (!st.periodStart || !st.periodEnd) return 0;
  const P = { start: st.periodStart, end: st.periodEnd };
  return countingRows(rows).filter((r) => rowOutsidePeriod(r, P)).length;
}

/**
 * Sets the status from what the statement still needs ('applied' and 'failed' stay as they are). 'parsed' (ready, and
 * an email in that state applies itself) needs: nothing blocking, the campaign's saved columns, every row inside the
 * period, for an email Gmail's confirmation that it came from the sender, no applied statement it would replace, and
 * no listed person with sales on days the statement has no row for them (silentDays).
 */
export function refreshStatus(db: Db, id: number): StatementStatus {
  const st = loadStatement(db, id);
  if (!st) return 'failed';
  if (st.status === 'applied' || st.status === 'failed') return st.status;
  const rows = loadRows(db, id);
  const table = parseJson<StoredTable | null>(st.tableJson, null);
  const problems = table ? statementRowsFromTable(table, parseJson<StatementColumnMapping>(st.mappingJson, {})).problems : [];
  const blockers = blockersFor(db, st, rows, problems);
  const ready =
    !blockers.length &&
    st.mappingSource === 'template' &&
    outsidePeriodCount(st, rows) === 0 &&
    (st.source !== 'email' || st.senderVerified === 1) &&
    !replacedStatement(db, st) &&
    !silentDays(db, st, rows).length;
  const status: StatementStatus = ready ? 'parsed' : 'needs_review';
  if (status !== st.status) run(db, `UPDATE statements SET status = ? WHERE id = ?`, [status, id]);
  return status;
}

// ───────────────────────────── reading for the API ─────────────────────────────

export interface StatementFilters {
  campaignId?: number | null;
  status?: StatementStatus | null;
}

const SUMMARY_SELECT = `
  SELECT s.id, s.campaign_id AS campaignId, c.code AS campaignCode, c.name AS campaignName, c.color AS campaignColor, s.source,
         s.received_at AS receivedAt, s.file_name AS fileName, s.period_start AS periodStart, s.period_end AS periodEnd, s.status,
         COALESCE(r.n, 0) AS rowCount, COALESCE(r.matched, 0) AS matchedCount, COALESCE(r.unmatched, 0) AS unmatchedCount,
         s.error, s.applied_at AS appliedAt, s.applied_by AS appliedBy,
         CASE WHEN a.id IS NULL THEN NULL ELSE TRIM(a.first_name || ' ' || a.last_name) END AS appliedByName, s.sender,
         s.sender_verified AS senderVerified, s.superseded_by AS supersededBy
    FROM statements s
    LEFT JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN users a ON a.id = s.applied_by
    LEFT JOIN (SELECT statement_id, COUNT(*) AS n, SUM(user_id IS NOT NULL) AS matched, SUM(match = 'none') AS unmatched
                 FROM statement_rows GROUP BY statement_id) r ON r.statement_id = s.id`;

type SummaryDb = Omit<StatementSummary, 'senderVerified'> & { senderVerified: number | null };

const toSummary = (r: SummaryDb): StatementSummary => ({ ...r, senderVerified: r.source === 'email' && r.senderVerified !== null ? r.senderVerified === 1 : null });

export function listStatements(db: Db, f: StatementFilters = {}): StatementSummary[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.campaignId) {
    where.push('s.campaign_id = ?');
    params.push(f.campaignId);
  }
  if (f.status) {
    where.push('s.status = ?');
    params.push(f.status);
  }
  return all<SummaryDb>(db, `${SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.received_at DESC, s.id DESC LIMIT 500`, params).map(toSummary);
}

export function statementSummary(db: Db, id: number): StatementSummary | null {
  const row = get<SummaryDb>(db, `${SUMMARY_SELECT} WHERE s.id = ?`, [id]);
  return row ? toSummary(row) : null;
}

/** "Thu 15 Oct" for a timestamp or a date. */
export function statementDayLabel(iso: string | null | undefined): string {
  if (!iso) return 'an earlier day';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}

/** The sender's organisation for a sentence: the campaign's name, else the sender's domain. */
const senderName = (st: StatementDb) => st.campaignName ?? st.sender?.split('@')[1] ?? 'the client';

function warningsFor(db: Db, st: StatementDb, table: StoredTable | null, rows: readonly RowDb[], plan: StatementPlan, replaced: AppliedLink | null): string[] {
  const out: string[] = [];
  const applied = st.status === 'applied';
  if (!applied && st.mappingSource === 'detected' && table) {
    out.push(`Linear Hub read the columns itself. Check them below: applying saves them for ${st.campaignCode ?? 'this campaign'}, so its next statements apply themselves.`);
  }
  if (!applied && st.source === 'email' && st.senderVerified !== 1) {
    out.push(
      `Gmail could not confirm that this email really came from ${senderName(st)} (anyone can put a sender's address on an email), so it does not apply itself. Check it with the PDF before you press Apply.`,
    );
  }
  if (table) {
    const total = statementTotalConfirmed(table.headers, table.totals, parseJson<StatementColumnMapping>(st.mappingJson, {}));
    const sum = rows.reduce((n, r) => n + r.confirmed, 0);
    if (total !== null && total !== sum) out.push(`The statement's total says ${plural(total, 'sub')}; the rows add up to ${sum}. Check that every row was read.`);
  }
  const outside = outsidePeriodCount(st, rows);
  if (outside) {
    const period = formatStatementPeriod(st.periodStart, st.periodEnd);
    const what = rows.some((r) => r.saleDate)
      ? `${plural(outside, 'sign-up is', 'sign-ups are')} dated outside the statement's period (${period})`
      : `${plural(outside, 'row covers', 'rows cover')} days outside the statement's period (${period})`;
    out.push(
      applied
        ? `${what}. They counted on their own days, in place of what those people logged on those days.`
        : `${what}. They count on their own days, in place of what those people logged on those days, so it does not apply itself: check the dates with the PDF.`,
    );
  }
  if (replaced && !applied) {
    const which = [st.campaignCode, 'statement'].filter(Boolean).join(' ');
    out.push(
      `This replaces the ${which} for ${formatStatementPeriod(replaced.periodStart, replaced.periodEnd)} applied on ${statementDayLabel(replaced.appliedAt)}. Applying it corrects pay to these figures instead: a correction already waiting on an unpaid week is changed, not added to.`,
    );
  }
  if (plan.dropped.length) {
    const names = plan.dropped.map((d) => d.userName).join(', ');
    out.push(
      applied
        ? `${plural(plan.dropped.length, 'person was', 'people were')} on the statement this replaced but not on this one (${names}): their weeks went back to the subs they logged.`
        : `${plural(plan.dropped.length, 'person is', 'people are')} on the statement this replaces but not on this one (${names}): their weeks go back to the subs they logged.`,
    );
  }
  if (!applied) {
    const silent = silentDays(db, st, rows);
    const sales = [st.campaignCode, 'sales'].filter(Boolean).join(' ');
    const weeks = (x: SilentDays) => x.weeks.map((w) => weekLabel(w)).join(', ');
    if (silent.length === 1) {
      const x = silent[0]!;
      out.push(`${x.userName} logged ${x.logged} ${x.logged === 1 ? sales.replace(/sales$/, 'sale') : sales} on days this statement has no row for them (${weeks(x)}): they count as cancelled. Check with the PDF before you press Apply.`);
    } else if (silent.length > 1) {
      const list = silent.slice(0, 4).map((x) => `${x.userName}: ${x.logged} in ${weeks(x)}`).join('; ');
      out.push(`${silent.length} people logged ${sales} on days this statement has no row for them (${list}${silent.length > 4 ? '; …' : ''}): they count as cancelled. Check with the PDF before you press Apply.`);
    }
  }
  if (plan.notListed.length) {
    const sales = [st.campaignCode, 'sales'].filter(Boolean).join(' ');
    out.push(`${plural(plan.notListed.length, 'person', 'people')} logged ${sales} in this period but ${plan.notListed.length === 1 ? 'is' : 'are'} not on the statement; their pay does not change.`);
  }
  return out;
}

/** An applied statement's people as they were when it was applied (statement_allocations), whatever the gauges say now. */
function appliedPeople(db: Db, statementId: number): StatementPersonSummary[] {
  const byPerson = new Map<number, StatementPersonSummary>();
  for (const a of all<{ userId: number; userName: string; weekStart: string; logged: number; confirmed: number; weekConfirmed: number }>(
    db,
    `SELECT a.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, a.week_start AS weekStart, a.logged, a.confirmed, a.week_confirmed AS weekConfirmed
       FROM statement_allocations a JOIN users u ON u.id = a.user_id WHERE a.statement_id = ? ORDER BY a.user_id, a.week_start`,
    [statementId],
  )) {
    const p = byPerson.get(a.userId) ?? { userId: a.userId, userName: a.userName, logged: 0, confirmed: 0, cancelled: 0, weeks: [] };
    const cancelled = Math.max(0, a.logged - a.confirmed);
    p.weeks.push({ weekStart: a.weekStart, logged: a.logged, confirmed: a.confirmed, cancelled, weekConfirmed: a.weekConfirmed });
    p.logged += a.logged;
    p.confirmed += a.confirmed;
    p.cancelled += cancelled;
    byPerson.set(a.userId, p);
  }
  return [...byPerson.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}

/** The later statement that replaced an applied one. */
function replacedByLink(db: Db, st: StatementDb): AppliedLink | null {
  if (!st.supersededBy) return null;
  return get<AppliedLink>(db, `SELECT id, received_at AS receivedAt, applied_at AS appliedAt, period_start AS periodStart, period_end AS periodEnd FROM statements WHERE id = ?`, [st.supersededBy]) ?? null;
}

/**
 * Runs `fn` (P1's applyConfirmedSales; given `replacesStatementId` when this statement replaces an applied one, P1
 * hands that one's corrections still waiting on an unpaid week to this statement and updates each line in place —
 * "2 cancelled: paid for 22, confirmed 20" — instead of adding a second, contradictory one; P3 never writes
 * pay_adjustments itself) inside one savepoint with whatever `after` writes; `preview` rolls everything back (the pay
 * preview). P1 materialises last week's runs only outside a transaction, so that is done first.
 */
function withReplacement<T>(db: Db, preview: boolean, fn: () => T, after?: (out: T) => void): T {
  ensurePayrollMaterialised(db, todayISO());
  db.exec('SAVEPOINT p3_apply');
  try {
    const out = fn();
    after?.(out);
    if (preview) db.exec('ROLLBACK TO p3_apply');
    db.exec('RELEASE p3_apply');
    return out;
  } catch (err) {
    db.exec('ROLLBACK TO p3_apply');
    db.exec('RELEASE p3_apply');
    throw err;
  }
}

/** The statement page's data: rows, matches, logged vs confirmed per person, P1's pay effect, and what is left to do. */
export function statementDetail(db: Db, id: number): StatementDetail {
  const st = loadStatement(db, id);
  if (!st) throw notFound('Statement');
  const rows = loadRows(db, id);
  const table = parseJson<StoredTable | null>(st.tableJson, null);
  const mapping = parseJson<StatementColumnMapping>(st.mappingJson, {});
  const problems = table ? statementRowsFromTable(table, mapping).problems : [];
  const applied = st.status === 'applied';
  // an applied statement keeps the people it dropped next to P1's effect (re-review fix: they used to vanish from it)
  const stored = applied ? parseJson<(ApplyResult & { dropped?: StatementDropped[] }) | null>(st.effectJson, null) : null;
  const plan: StatementPlan = applied
    ? { people: appliedPeople(db, id), notListed: [], dropped: stored?.dropped ?? [], rows: [], allocations: [] }
    : statementPlan(db, st, rows);
  const blockers = blockersFor(db, st, rows, problems);
  const replaced = replacedStatement(db, st);
  let effect: ApplyResult | null = null;
  const warnings = warningsFor(db, st, table, rows, plan, replaced);
  if (applied) {
    if (stored) {
      const { dropped: _dropped, ...result } = stored;
      effect = result;
    }
  } else if (plan.rows.length && !blockers.length) {
    try {
      effect = replaced
        ? withReplacement(db, true, () => applyConfirmedSales(db, plan.rows, { statementId: id, actorId: null, dryRun: true, replacesStatementId: replaced.id }))
        : applyConfirmedSales(db, plan.rows, { statementId: id, actorId: null, dryRun: true });
    } catch (err) {
      console.error(`Statement ${id}: the pay preview failed`, err);
      warnings.push(`The pay effect could not be worked out (${err instanceof Error ? err.message : 'unknown problem'}). Applying shows it.`);
    }
  }
  const summary = statementSummary(db, id)!;
  return {
    ...summary,
    rows: rows.map(toRow),
    effect,
    template: loadTemplate(db, st.campaignId),
    subject: st.subject,
    table: table ? { headers: table.headers, rows: table.rows, mapping, mappingSource: st.mappingSource ?? 'detected', layout: st.layout ?? 'totals' } : null,
    people: plan.people,
    notListed: plan.notListed,
    dropped: plan.dropped,
    blockers: applied ? [] : blockers,
    warnings,
    replaces: replaced,
    replacedBy: replacedByLink(db, st),
    outsidePeriodCount: outsidePeriodCount(st, rows),
  };
}

/** The stored statement row the file route needs. */
export function statementFileInfo(db: Db, id: number): { filePath: string | null; fileName: string | null; campaignCode: string | null; periodStart: string | null; periodEnd: string | null } | null {
  const st = loadStatement(db, id);
  return st ? { filePath: st.filePath, fileName: st.fileName, campaignCode: st.campaignCode, periodStart: st.periodStart, periodEnd: st.periodEnd } : null;
}

// ───────────────────────────── changes ─────────────────────────────

function editable(db: Db, id: number): StatementDb {
  const st = loadStatement(db, id);
  if (!st) throw notFound('Statement');
  if (st.status === 'applied') throw conflict('This statement is already applied, so it cannot change. Corrections go on the next pay run as adjustments.');
  return st;
}

/**
 * Pick the person for a row (null: not one of ours). The other rows of the statement nobody matched yet that are
 * written the same way (the same name and fundraiser ID — a per-sign-up statement lists a person once per sub) get the
 * same pick. Remembers the row's client ID for that person when it is new.
 */
export function setRowMatch(db: Db, statementId: number, rowId: number, userId: number | null): { row: StatementRow; rememberedRef: string | null; alsoMatched: number } {
  const st = editable(db, statementId);
  const row = get<RowDb>(db, `${ROW_SELECT} WHERE r.id = ? AND r.statement_id = ?`, [rowId, statementId]);
  if (!row) throw notFound('Statement row');
  if (userId !== null) {
    const person = get<{ id: number; role: string }>(db, `SELECT id, role FROM users WHERE id = ?`, [userId]);
    if (!person || person.role === 'client') throw notFound('Person');
  }
  let rememberedRef: string | null = null;
  let alsoMatched = 0;
  transaction(db, () => {
    run(db, `UPDATE statement_rows SET user_id = ?, match = 'manual' WHERE id = ?`, [userId, rowId]);
    const key = pickKey({ ...row, saleDate: null });
    const same = loadRows(db, statementId).filter((r) => r.id !== rowId && r.match === 'none' && pickKey({ ...r, saleDate: null }) === key);
    for (const r of same) run(db, `UPDATE statement_rows SET user_id = ?, match = 'manual' WHERE id = ?`, [userId, r.id]);
    alsoMatched = same.length;
    const ref = row.fundraiserRef?.trim();
    if (userId !== null && ref && st.campaignId) {
      const taken = get<{ userId: number }>(db, `SELECT user_id AS userId FROM user_client_refs WHERE campaign_id = ? AND ref = ?`, [st.campaignId, ref]);
      const has = get<{ ref: string }>(db, `SELECT ref FROM user_client_refs WHERE campaign_id = ? AND user_id = ?`, [st.campaignId, userId]);
      if (!taken && !has) {
        run(db, `INSERT INTO user_client_refs (user_id, campaign_id, ref) VALUES (?, ?, ?)`, [userId, st.campaignId, ref]);
        rememberedRef = ref;
      }
    }
    if (rememberedRef && st.campaignId) rematchCampaigns(db, [st.campaignId]);
    else refreshStatus(db, statementId);
  });
  bumpDataVersion();
  return { row: toRow(get<RowDb>(db, `${ROW_SELECT} WHERE r.id = ?`, [rowId])!), rememberedRef, alsoMatched };
}

export interface PatchInput {
  campaignId?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

/** The campaign or period the PDF did not say (before it is applied). A new campaign re-reads the rows with its columns. */
export function patchStatement(db: Db, id: number, input: PatchInput): void {
  const st = editable(db, id);
  if (!st.tableJson && input.campaignId === undefined) throw conflict('This statement could not be read, so there is nothing to change. Discard it, or ask the client for another copy.');
  const start = input.periodStart === undefined ? st.periodStart : input.periodStart;
  const end = input.periodEnd === undefined ? st.periodEnd : input.periodEnd;
  if ((start === null) !== (end === null)) throw new HttpError(400, 'Give both the first and the last day of the period.');
  if (start && end) {
    if (!isValidISODate(start) || !isValidISODate(end)) throw new HttpError(400, 'The period needs real dates.');
    if (start > end) throw new HttpError(400, 'The period must start on or before its last day.');
    if (diffDays(start, end) >= STATEMENT_MAX_PERIOD_DAYS) throw new HttpError(400, `A statement period can be up to ${STATEMENT_MAX_PERIOD_DAYS} days long.`);
  }
  if (input.campaignId) {
    const exists = get<{ id: number }>(db, `SELECT id FROM campaigns WHERE id = ?`, [input.campaignId]);
    if (!exists) throw notFound('Campaign');
  }
  transaction(db, () => {
    const campaignChanged = input.campaignId !== undefined && input.campaignId !== st.campaignId;
    run(db, `UPDATE statements SET campaign_id = ?, period_start = ?, period_end = ? WHERE id = ?`, [
      input.campaignId === undefined ? st.campaignId : input.campaignId, start, end, id,
    ]);
    if (campaignChanged) {
      run(db, `UPDATE statement_rows SET user_id = NULL, match = 'none' WHERE statement_id = ? AND match = 'auto'`, [id]);
      rereadStatement(db, id);
    } else refreshStatus(db, id);
  });
  bumpDataVersion();
}

/** Discards a statement that is not applied (its rows go too; the file when no other statement uses it). */
export function deleteStatement(db: Db, id: number): void {
  const st = editable(db, id);
  transaction(db, () => {
    run(db, `DELETE FROM statements WHERE id = ?`, [id]);
  });
  removeStatementFileIfUnused(db, st.filePath);
  bumpDataVersion();
}

/**
 * A one-line account of an apply, for the audit trail and the job log. The people a replacement dropped are counted
 * too ("1 person back to the subs they logged"): their pay change is in the total.
 */
export function applySentence(
  st: { campaignCode: string | null; periodStart: string | null; periodEnd: string | null },
  people: readonly StatementPersonSummary[],
  effect: ApplyResult | null,
  dropped: readonly StatementDropped[] = [],
): string {
  const cancelled = people.reduce((s, p) => s + p.cancelled, 0);
  const diff = effect?.totalDifference ?? 0;
  const money = diff === 0 ? 'no change to pay' : `${diff < 0 ? '−' : '+'}£${Math.abs(diff).toFixed(2)} on the next pay runs`;
  const back = dropped.length ? `, ${plural(dropped.length, 'person', 'people')} back to the subs they logged` : '';
  return `${st.campaignCode ?? 'Statement'} ${formatStatementPeriod(st.periodStart, st.periodEnd)}: ${plural(people.length, 'person', 'people')}${back}, ${plural(cancelled, 'cancelled sub')}, ${money}`;
}

/**
 * Applies a statement to pay: P1's applyConfirmedSales with every matched person's whole-week figures (paid weeks
 * become adjustments on the next unpaid run), then the allocation, the effect and the campaign's columns are kept — all
 * in one savepoint, so a failure leaves nothing half done. A statement for exactly the same period as an applied one
 * replaces it: that one's corrections still on unpaid weeks are handed over first (withReplacement), so each person ends
 * with one correction line per week and campaign. actorId null = automatic (Linear Hub).
 */
export function applyStatement(db: Db, id: number, actorId: number | null): StatementDetail {
  const st = loadStatement(db, id);
  if (!st) throw notFound('Statement');
  if (st.status === 'applied') throw conflict('This statement is already applied.');
  const rows = loadRows(db, id);
  const table = parseJson<StoredTable | null>(st.tableJson, null);
  const mapping = parseJson<StatementColumnMapping>(st.mappingJson, {});
  const blockers = blockersFor(db, st, rows, table ? statementRowsFromTable(table, mapping).problems : []);
  if (blockers.length) throw conflict(blockers[0]!);
  const plan = statementPlan(db, st, rows);
  const replaced = replacedStatement(db, st);
  const at = nowISO();
  const effect = withReplacement(
    db,
    false,
    () => applyConfirmedSales(db, plan.rows, { statementId: id, actorId, replacesStatementId: replaced?.id ?? null }),
    (result) => {
      run(db, `DELETE FROM statement_allocations WHERE statement_id = ?`, [id]);
      const insert = db.prepare(
        `INSERT INTO statement_allocations (statement_id, user_id, campaign_id, week_start, logged, confirmed, week_confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of plan.allocations) insert.run(id, a.userId, st.campaignId, a.weekStart, a.logged, a.confirmed, a.weekConfirmed);
      // a statement sent again for the same period replaces the one applied before
      if (replaced) run(db, `UPDATE statements SET superseded_by = ? WHERE id = ?`, [id, replaced.id]);
      if (st.mappingSource !== 'template' && table && st.campaignId) {
        saveTemplate(db, st.campaignId, mappingByHeader(table.headers, mapping), actorId);
        run(db, `UPDATE statements SET mapping_source = 'template' WHERE id = ?`, [id]);
      }
      // the people it dropped are kept with the effect, so the applied page still explains their part of the total
      const kept = plan.dropped.length ? { ...result, dropped: plan.dropped } : result;
      run(db, `UPDATE statements SET status = 'applied', applied_at = ?, applied_by = ?, effect_json = ?, error = NULL WHERE id = ?`, [at, actorId, JSON.stringify(kept), id]);
    },
  );
  bumpDataVersion();
  if (actorId === null) {
    recordSystemEvent(db, { name: 'statements.apply', summary: `Applied a statement automatically: ${applySentence(st, plan.people, effect, plan.dropped)}`, entity: 'statement', entityId: id });
  }
  return statementDetail(db, id);
}
