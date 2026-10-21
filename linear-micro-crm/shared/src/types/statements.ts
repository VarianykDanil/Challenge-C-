/**
 * Release 1.3 — P3 statements contracts (laid down by r3-foundation; OWNED BY P3, which may add fields and types).
 *
 * Owner's decision 4 (quote): "Cancellations: a rep may log 18 sales but the charity pays for only 16 (2 cancelled). The
 * charities email Matt commission statements as PDF ATTACHMENTS with a table of exact payments per fundraiser. Linear
 * Hub reads Matt's Gmail with an APP PASSWORD (IMAP), picks up each charity's statement automatically, and corrects the
 * NEXT payment of each person, with a breakdown."
 *
 * Endpoints (server/src/routes/statements.ts, mounted at /statements, owned by P3; admin only; stubs: reads empty,
 * writes 501):
 *  - GET  /statements?campaignId=&status=      → StatementSummary[]
 *  - GET  /statements/:id                      → StatementDetail (rows, matches and P1's applyConfirmedSales dry run)
 *  - GET  /statements/:id/file                 → the stored PDF (application/pdf)
 *  - POST /statements/upload                   → 201 StatementSummary (manual upload; same parse path)
 *  - POST /statements/:id/apply                → StatementDetail (P1 applyConfirmedSales, not a dry run)
 *  - PUT  /statements/:id/rows/:rowId  StatementRowMatchInput → StatementRow (pick the person for an unmatched row)
 *  - POST /statements/check-now                → CheckNowResult (runs the mail job once)
 *  - GET  /statements/mail, PUT /statements/mail MailSettingsInput → MailSettings (the app password is write-only)
 *  - POST /statements/mail/test                → MailTestResult
 *  - GET  /statements/senders, PUT /statements/senders StatementSender[] → StatementSender[]
 *  - GET  /statements/templates/:campaignId, PUT … StatementColumnMapping → StatementTemplate
 *  - GET  /statements/client-refs?userId=, PUT /statements/client-refs/:userId ClientRef[] → ClientRef[]
 * Job: server/src/lib/statements/job.ts `startStatementJob(db)` (called from index.ts by the foundation): every
 * 15 minutes while the server runs; EXAMINE (read-only), never flags, moves or deletes mail. PDFs are stored under
 * server/data/statements/ (git-ignored). Automatic steps are audited with actor "Linear Hub" (P9's
 * lib/audit/events.ts recordSystemEvent).
 * Tables (server/src/db/extensions/statements.ts): campaign_statement_senders, statement_templates, statements,
 * statement_rows, user_client_refs; meta `ext:statements:mail` (address, encrypted app password, last check, last
 * error, last seen UID).
 */
import type { ApplyResult } from './pay.ts';

export type StatementSource = 'email' | 'upload';
export type StatementStatus = 'parsed' | 'needs_review' | 'applied' | 'failed';
export type StatementRowMatch = 'auto' | 'manual' | 'none';

export interface StatementSummary {
  id: number;
  campaignId: number | null;
  campaignCode: string | null;
  campaignName: string | null;
  source: StatementSource;
  receivedAt: string;
  fileName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: StatementStatus;
  /** Rows parsed from the statement's table. */
  rowCount: number;
  /** Rows matched to a person (auto or manual). */
  matchedCount: number;
  error: string | null;
  appliedAt: string | null;
  appliedBy: number | null;
}

export interface StatementRow {
  id: number;
  statementId: number;
  /** The client's own fundraiser ID, when the table has one. */
  fundraiserRef: string | null;
  name: string | null;
  /** Per-sub rows: the sale date; totals rows: null (the period is the statement's). */
  saleDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  confirmed: number;
  cancelled: number | null;
  amount: number | null;
  userId: number | null;
  userName?: string | null;
  match: StatementRowMatch;
  /** The cells as read, keyed by the table's headers. */
  raw: Record<string, string>;
}

export interface StatementDetail extends StatementSummary {
  rows: StatementRow[];
  /** P1's applyConfirmedSales dry run (null when nothing is matched yet). */
  effect: ApplyResult | null;
  template: StatementTemplate | null;
}

export interface StatementRowMatchInput {
  userId: number | null;
}

/** Which column holds what (0-based column index or the header text). */
export interface StatementColumnMapping {
  ref?: number | string;
  name?: number | string;
  confirmed?: number | string;
  cancelled?: number | string;
  amount?: number | string;
  date?: number | string;
  status?: number | string;
  period?: number | string;
}

export interface StatementTemplate {
  campaignId: number;
  mapping: StatementColumnMapping;
  updatedAt: string;
  updatedBy: number | null;
}

/** GET /statements/mail — never contains the app password. */
export interface MailSettings {
  address: string | null;
  hasPassword: boolean;
  enabled: boolean;
  lastCheckAt: string | null;
  /** In plain words: "Wrong app password", "IMAP is off in Gmail", "App passwords are not allowed on this account". */
  lastError: string | null;
}

export interface MailSettingsInput {
  address?: string | null;
  /** Write-only; stored encrypted with the app-secret key (lib/crypto.ts). '' removes it. */
  appPassword?: string;
  enabled?: boolean;
}

export interface MailTestResult {
  ok: boolean;
  message: string;
}

export interface CheckNowResult {
  checked: number;
  fetched: number;
  parsed: number;
  applied: number;
  errors: string[];
}

export interface StatementSender {
  campaignId: number;
  address: string;
}

/** Team → person → "Client IDs": the person's fundraiser ID at each client. */
export interface ClientRef {
  userId: number;
  campaignId: number;
  ref: string;
}
