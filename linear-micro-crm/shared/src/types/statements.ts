/**
 * Release 1.3 — P3 statements contracts (laid down by r3-foundation; OWNED BY P3, which may add fields and types).
 *
 * Owner's decision 4 (quote): "Cancellations: a rep may log 18 sales but the charity pays for only 16 (2 cancelled). The
 * charities email Matt commission statements as PDF ATTACHMENTS with a table of exact payments per fundraiser. Linear
 * Hub reads Matt's Gmail with an APP PASSWORD (IMAP), picks up each charity's statement automatically, and corrects the
 * NEXT payment of each person, with a breakdown."
 *
 * Endpoints (server/src/routes/statements.ts, mounted at /statements, owned by P3; admin only):
 *  - GET    /statements?campaignId=&status=      → StatementSummary[]
 *  - GET    /statements/:id                      → StatementDetail (rows, matches and P1's applyConfirmedSales dry run)
 *  - GET    /statements/:id/file                 → the stored PDF (application/pdf)
 *  - PATCH  /statements/:id  StatementPatchInput → StatementDetail (the campaign or period the PDF did not say)
 *  - DELETE /statements/:id                      → 204 (discard a statement that is not applied)
 *  - POST   /statements/upload                   → 201 StatementSummary (manual upload; same parse path)
 *  - POST   /statements/:id/apply                → StatementDetail (P1 applyConfirmedSales, not a dry run)
 *  - PUT    /statements/:id/rows/:rowId  StatementRowMatchInput → StatementRow (pick the person for an unmatched row)
 *  - POST   /statements/check-now                → CheckNowResult (runs the mail job once)
 *  - GET    /statements/mail, PUT /statements/mail MailSettingsInput → MailSettings (the app password is write-only)
 *  - POST   /statements/mail/test                → MailTestResult
 *  - GET    /statements/senders, PUT /statements/senders StatementSender[] → StatementSender[]
 *  - GET    /statements/templates/:campaignId, PUT … StatementColumnMapping → StatementTemplate
 *  - GET    /statements/client-refs?userId=, PUT /statements/client-refs/:userId ClientRef[] → ClientRef[]
 * Job: server/src/lib/statements/job.ts `startStatementJob(db)` (called from index.ts by the foundation): every
 * 15 minutes while the server runs; EXAMINE (read-only), never flags, moves or deletes mail. PDFs are stored under
 * server/data/statements/ (git-ignored). Automatic steps are audited with actor "Linear Hub" (P9's
 * lib/audit/events.ts recordSystemEvent).
 * Tables (server/src/db/extensions/statements.ts): campaign_statement_senders, statement_templates, statements,
 * statement_rows, user_client_refs, statement_allocations; meta `ext:statements:mail` (address, encrypted app
 * password, last check, last error, last seen UID).
 */
import type { ApplyResult } from './pay.ts';

/** Largest statement PDF the upload (and the mail job) accepts: 20 MB. */
export const STATEMENT_MAX_BYTES = 20 * 1024 * 1024;
/** How often the mail job looks for new statements while the server runs. */
export const STATEMENT_CHECK_EVERY_MINUTES = 15;
/** On the first check (no message seen yet), how far back the job looks in Gmail. */
export const STATEMENT_FIRST_CHECK_DAYS = 60;
/** A statement period longer than this is treated as a reading mistake (a quarter, at most). */
export const STATEMENT_MAX_PERIOD_DAYS = 92;

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
  /** P3: the admin's name; null with `appliedBy` null for an automatic apply ("Linear Hub"). */
  appliedByName?: string | null;
  /** P3: rows still waiting for someone to pick the person (match 'none'). */
  unmatchedCount?: number;
  /** P3: the campaign's colour, for the list's chip. */
  campaignColor?: string | null;
  /** P3: the sender's address, for a statement that came by email. */
  sender?: string | null;
  /**
   * P3: for a statement that came by email, whether Gmail confirmed it really came from the sender's domain (DKIM or
   * DMARC passed, aligned with the From address). Only a confirmed email applies itself. null for an upload.
   */
  senderVerified?: boolean | null;
  /** P3: the later statement for exactly the same period that replaced this applied one (null when it was not replaced). */
  supersededBy?: number | null;
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
  /** 'auto' (client ID or exact name), 'manual' (picked by the office; userId null = "not one of ours"), 'none'. */
  match: StatementRowMatch;
  /** The cells as read, keyed by the table's headers. */
  raw: Record<string, string>;
  /**
   * P3, PUT /statements/:id/rows/:rowId only: the row's fundraiser ID, saved as the picked person's client ID at that
   * campaign because they had none ("Linear Hub will match FR-2041 to Jordan Lee from now on"); null otherwise.
   */
  rememberedRef?: string | null;
  /**
   * P3, PUT /statements/:id/rows/:rowId only: how many other unmatched rows of the statement, written the same way (the
   * same name and fundraiser ID), got the same pick.
   */
  alsoMatched?: number;
}

export interface StatementDetail extends StatementSummary {
  rows: StatementRow[];
  /** P1's applyConfirmedSales dry run (null when nothing is matched yet); for an applied statement, what applying did. */
  effect: ApplyResult | null;
  template: StatementTemplate | null;
  /** P3: the email subject, for a statement that came by email. */
  subject?: string | null;
  /** P3: the table as read from the PDF and the column mapping used. */
  table?: StatementTable | null;
  /** P3: logged vs confirmed per matched person and pay week (what Apply sends to pay). */
  people?: StatementPersonSummary[];
  /** P3: people who logged sales for the campaign in the period but are not on the statement (nothing changes for them). */
  notListed?: StatementNotListed[];
  /** P3: why Apply is not possible yet, in plain words ([] when it is). */
  blockers?: string[];
  /** P3: things worth a look that do not stop Apply ("The statement's total says 41 subs; the rows add up to 40"). */
  warnings?: string[];
  /**
   * P3: the applied statement this one replaces (the same campaign and exactly the same period): for an unapplied one,
   * the statement Apply will replace; for an applied one, the statement it replaced. null when none.
   */
  replaces?: StatementLink | null;
  /** P3: for a replaced statement, the later one that replaced it. */
  replacedBy?: StatementLink | null;
  /**
   * P3: people on the statement this one replaces who are not on this one: Apply puts their weeks back to the subs they
   * logged (they appear in `effect` too).
   */
  dropped?: StatementDropped[];
  /** P3: rows dated (or with a period) outside the statement's period; they count in their own weeks. */
  outsidePeriodCount?: number;
}

/** P3: another statement, as a link ("Replaced by the statement received Thu 22 Oct"). */
export interface StatementLink {
  id: number;
  receivedAt: string;
  appliedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/** P3: someone on the statement being replaced who is not on the new one. */
export interface StatementDropped {
  userId: number;
  userName: string;
  /** Subs they logged on the period's days. */
  logged: number;
  /** What the replaced statement confirmed for them. */
  confirmedBefore: number;
}

/** P3: the table as read from the PDF (header cells and body rows), kept so a new column mapping re-reads it. */
export interface StatementTable {
  headers: string[];
  rows: string[][];
  mapping: StatementColumnMapping;
  /** 'template': the campaign's saved columns; 'detected': read from the header words. */
  mappingSource: 'template' | 'detected';
  /** One row per fundraiser with counts ('totals') or one row per sign-up with its date ('per-sub'). */
  layout: StatementLayout;
}

export type StatementLayout = 'totals' | 'per-sub';

/** P3: one person's pay week inside a statement's period: what they logged and what the client confirmed. */
export interface StatementPersonWeek {
  /** Monday of the pay week. */
  weekStart: string;
  /** Subs logged in gauges for the campaign on the period's days of that week. */
  logged: number;
  /** Subs the client confirmed for those days (a period total is spread over its weeks, cancellations latest week first). */
  confirmed: number;
  /** max(0, logged − confirmed). */
  cancelled: number;
  /**
   * What goes to pay for the whole week (ConfirmedSalesRow.confirmed): `confirmed` plus the week's subs on days outside
   * this period (confirmed by another applied statement, else as logged).
   */
  weekConfirmed: number;
}

export interface StatementPersonSummary {
  userId: number;
  userName: string;
  logged: number;
  confirmed: number;
  cancelled: number;
  weeks: StatementPersonWeek[];
}

export interface StatementNotListed {
  userId: number;
  userName: string;
  logged: number;
}

/** P3: PATCH /statements/:id — fix what the PDF did not say (only before it is applied). */
export interface StatementPatchInput {
  campaignId?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface StatementRowMatchInput {
  /** The person this row is about; null = "not one of ours" (left out when the statement is applied). */
  userId: number | null;
}

/** Which column holds what (0-based column index or the header text). */
export interface StatementColumnMapping {
  ref?: number | string;
  name?: number | string;
  /** P3: sign-ups before cancellations; confirmed = gross − cancelled when there is no paid count. */
  gross?: number | string;
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
  /** P3: when a check last stored a new statement. */
  lastFetchAt?: string | null;
  /** P3: how often the job checks while the server runs (15). */
  checkEveryMinutes?: number;
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
  /** Messages from the statement senders looked at. */
  checked: number;
  /** New PDF statements stored. */
  fetched: number;
  /** Of those, read without a problem (status parsed, needs_review or applied). */
  parsed: number;
  /** Of those, applied automatically (every row matched and the campaign's columns saved). */
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
