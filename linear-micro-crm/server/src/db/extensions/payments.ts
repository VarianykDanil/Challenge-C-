/**
 * Release 1.4 — OWNED BY F payments-foundation (packages P and A add columns with addColumnIfMissing and never rename
 * or drop what is here). Paying people from Linear Hub.
 *
 *  - bank_accounts: one per person (user_id PK). The sort code and account number are encrypted with lib/crypto.ts
 *    (sort_code_enc, account_number_enc) and never leave the server except inside a bank file or a provider request;
 *    last4 / sort_code_last2 are what every screen shows. changed_at / changed_by: the last change and who made it;
 *    confirmed_by_admin_at / confirmed_by: when an administrator last confirmed them (NULL, or older than changed_at,
 *    means a payment to these details is held — lib/payments/bankDetails.ts).
 *  - payment_connections: a way to pay Matt set up (provider 'bank_file' | 'revolut' | 'wise' | 'truelayer'; tests and
 *    LM_PAYMENTS_FAKE=1 also 'fake'), mode 'test' | 'live' (every connection starts in 'test'; live needs the typed
 *    confirmation, recorded in live_confirmed_at / _by), settings_json (non-secret: the file format, a profile or account
 *    id), secrets_enc (the JSON of its secrets, encrypted; NULL once disconnected), status 'not_connected' | 'connected'
 *    | 'error', the last check and its error (plain words, secrets redacted), balance_pence (from the last test, when the
 *    provider shows one), created_at / _by, disconnected_at.
 *  - payment_batches: one payment run through a connection: provider and mode copied at creation, created / approved by
 *    whom and when, total_pence and count, status 'draft' | 'submitted' | 'processing' | 'completed' | 'partly_failed' |
 *    'failed' | 'cancelled', idempotency_key (UNIQUE, random, sent to the provider so a resubmit never pays twice),
 *    provider_ref, file_name, plus (F): skipped_json (the selected runs left out and why), file_enc (the bank file,
 *    encrypted: it holds account numbers), last_error, updated_at, cancelled_at / _by.
 *  - payment_items: one person's run in a batch: amount_pence (the run's gross converted once), payee_name and
 *    account_last4 (copied at creation), status 'queued' | 'submitted' | 'processing' | 'paid' | 'failed' | 'cancelled',
 *    provider_ref, failure_reason, submitted_at, paid_at, updated_at, plus (F) week_start (the run's week, so a run
 *    deleted and made again is still recognised), note (e.g. the run's pay changed after the money was sent) and live
 *    (0 for a test-mode batch: the provider's sandbox moves no money, so its items never mark a run paid).
 *    A partial UNIQUE index on payroll_run_id WHERE status NOT IN ('failed', 'cancelled') AND live = 1: a run can never
 *    be in two live payments. Review fixes (upgrade): payee_enc, the sort code and account number the item was APPROVED
 *    with (encrypted JSON): every send, resend, check and cancel uses them, never details changed since, so a resend
 *    after a timeout carries the same body with the same key; attempted_at, when Linear Hub first handed the item to
 *    its provider (NULL: never sent, so it can be cancelled here without asking anyone). No foreign key to payroll_runs or users: an unpaid run may be removed and made again by the pay
 *    rules, and payment history outlives both.
 *
 * Bank_accounts.reported_at / reported_note (the person said the details someone else typed
 * in are not theirs: held, every administrator told) and person_seen_at (when the person last said yes to, or reported,
 * a change someone else made). confirmed_by_admin_at / confirmed_by now hold ANY confirmation — by an administrator or,
 * for details someone else typed in, by the person — and never the one who made the change (lib/payments/bankDetails.ts).
 * The upgrade holds again, once, details a 1.4.0 administrator typed in and "confirmed" alone.
 * Demo seed (fresh databases only): obviously fake bank details (sort code 00-00-00, account number 0000 + the
 * person's id) for the field people and recruiters — every ninth person has none (to show "skipped: no bank details"),
 * and one changed theirs yesterday and waits for the admin's check (the Needs-attention item). No connection and no
 * payment: Matt sets those up. An existing demo database gains no bank details (they would be fake details on real
 * people Matt may have added); OWNER_NOTES says how to try it.
 * Rules: ./types.ts.
 */
import type { Db } from '../connection.ts';
import { encrypt } from '../../lib/crypto.ts';
import { recordSystemEvent } from '../../lib/audit/events.ts';
import { keepTwoApprovalsDefault } from '../../lib/payments/settings.ts';
import { addColumnIfMissing, columnsOf, metaFlag, setMetaFlag, type DbExtension, type SeedContext } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS bank_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  holder_name TEXT NOT NULL,
  sort_code_enc TEXT NOT NULL,
  account_number_enc TEXT NOT NULL,
  last4 TEXT NOT NULL,
  sort_code_last2 TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_admin_at TEXT,
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_at TEXT,
  reported_note TEXT,
  person_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT,
  status TEXT NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected', 'connected', 'error')),
  last_checked_at TEXT,
  last_error TEXT,
  balance_pence INTEGER,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  live_confirmed_at TEXT,
  live_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  disconnected_at TEXT,
  test_file_at TEXT,
  test_file_by INTEGER,
  test_file_result TEXT
);

CREATE TABLE IF NOT EXISTS payment_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES payment_connections(id),
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  total_pence INTEGER NOT NULL,
  count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'processing', 'completed', 'partly_failed', 'failed', 'cancelled')),
  file_name TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_ref TEXT,
  skipped_json TEXT,
  file_enc TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  downloaded_at TEXT,
  downloaded_by INTEGER,
  voided_at TEXT,
  voided_by INTEGER,
  void_reason TEXT,
  first_approved_at TEXT,
  first_approved_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status, created_at);

CREATE TABLE IF NOT EXISTS payment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  payroll_run_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  payee_name TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitted', 'processing', 'paid', 'failed', 'cancelled')),
  provider_ref TEXT,
  failure_reason TEXT,
  submitted_at TEXT,
  paid_at TEXT,
  updated_at TEXT NOT NULL,
  note TEXT,
  live INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0, 1)),
  payee_enc TEXT,
  attempted_at TEXT,
  freed_confirmed_at TEXT,
  freed_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payment_items_batch ON payment_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_items_user_week ON payment_items(user_id, week_start);
-- a payroll run is never in two live payments (failed and cancelled items free it again; test-mode items move no money)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_items_live_run ON payment_items(payroll_run_id) WHERE status NOT IN ('failed', 'cancelled') AND live = 1;
`;

/** The demo's bank details: obviously fake (00-00-00, 0000 + id), never a real account. */
export function demoAccountNumber(userId: number): string {
  return `0000${String(userId % 10_000).padStart(4, '0')}`;
}
export const DEMO_SORT_CODE = '000000';

/** Fresh demo seed: fake bank details for the people who are paid weekly (see the header). */
function seedDemoBankDetails(db: Db, ctx: SeedContext): void {
  const paid = ctx.users.filter((u) => (u.role === 'rep' || u.role === 'leader' || u.role === 'recruiter') && u.status === 'active');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by, confirmed_by_admin_at, confirmed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const admin = ctx.users.find((u) => u.role === 'admin')?.id ?? null;
  const now = Date.parse(ctx.nowIso);
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  // the demo rep (Jordan Lee, LM-0010) always has confirmed details, so his Settings card and his runs show the happy path
  const changer = paid.find((u, i) => i >= 3 && u.employeeId !== 'LM-0010' && i % 9 !== 8);
  paid.forEach((u, i) => {
    if (i % 9 === 8 && u.employeeId !== 'LM-0010') return; // no bank details yet
    const account = demoAccountNumber(u.id);
    const changedYesterday = u.id === changer?.id;
    const changedAt = changedYesterday ? at(1) : at(40 + (i % 7));
    insert.run(
      u.id, `${u.firstName} ${u.lastName}`.trim(), encrypt(DEMO_SORT_CODE), encrypt(account), account.slice(-4), DEMO_SORT_CODE.slice(-2),
      changedAt, u.id, changedYesterday ? at(30) : at(39 + (i % 7)), admin,
    );
  });
}

/**
 * MON-3, once: in 1.4.0 details an administrator typed in for someone counted as confirmed by that same administrator
 * (and an administrator's own change by themself). Nobody confirms their own change now, so those are held again until
 * the person or another administrator confirms them; the person is told. Recorded as one automatic audit row.
 */
function reholdSelfConfirmed(db: Db): number {
  if (metaFlag(db, 'ext:payments:bank-rehold')) return 0;
  const n = Number(db.prepare(
    `UPDATE bank_accounts SET confirmed_by_admin_at = NULL, confirmed_by = NULL
     WHERE confirmed_by IS NOT NULL AND changed_by IS NOT NULL AND confirmed_by = changed_by`,
  ).run().changes);
  setMetaFlag(db, 'ext:payments:bank-rehold');
  if (n > 0) {
    recordSystemEvent(db, {
      name: 'payments.bank_rehold',
      summary: `Bank details of ${n} ${n === 1 ? 'person' : 'people'} that one administrator typed in and confirmed alone now wait for the person or another administrator to confirm them`,
      entity: 'bank_account',
      after: { people: n },
    });
  }
  return n;
}

/**
 * MON-2, once: in 1.4.0 a bank file's download was only written to the audit trail. Its first download there becomes
 * the batch's downloaded_at, so a file downloaded then cancelled before this release still counts as sent (a new file
 * for those weeks within 7 days is refused until someone confirms the old one was not uploaded).
 */
function backfillDownloads(db: Db): number {
  if (metaFlag(db, 'ext:payments:downloads')) return 0;
  if (!columnsOf(db, 'audit_log').length) return 0;
  const n = Number(db.prepare(
    `UPDATE payment_batches SET
       downloaded_at = (SELECT MIN(a.at) FROM audit_log a WHERE a.action = 'GET /payments/batches/:id/file' AND a.entity = 'payment_batch' AND a.entity_id = payment_batches.id),
       downloaded_by = (SELECT a.user_id FROM audit_log a WHERE a.action = 'GET /payments/batches/:id/file' AND a.entity = 'payment_batch' AND a.entity_id = payment_batches.id ORDER BY a.at LIMIT 1)
     WHERE downloaded_at IS NULL AND mode = 'live'
       AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'GET /payments/batches/:id/file' AND a.entity = 'payment_batch' AND a.entity_id = payment_batches.id)`,
  ).run().changes);
  setMetaFlag(db, 'ext:payments:downloads');
  return n;
}

export const extension: DbExtension = {
  name: 'payments',
  sql: SQL,
  upgrade(db) {
    // 1.4.0 creates the tables above with the CREATE statements (payee_enc and attempted_at included); a database made
    // before the review fixes gains those two columns here
    const payee = addColumnIfMissing(db, 'payment_items', 'payee_enc', 'TEXT');
    const attempted = addColumnIfMissing(db, 'payment_items', 'attempted_at', 'TEXT');
    // MON-3: "these are not my details", and when the person last saw a change someone else made (the table is
    // always there after `sql`; a partial database handed to upgrade() alone is left as it is)
    const hasBank = columnsOf(db, 'bank_accounts').length > 0;
    const added = hasBank
      ? [
          addColumnIfMissing(db, 'bank_accounts', 'reported_at', 'TEXT'),
          addColumnIfMissing(db, 'bank_accounts', 'reported_note', 'TEXT'),
          addColumnIfMissing(db, 'bank_accounts', 'person_seen_at', 'TEXT'),
        ]
      : [];
    const reheld = hasBank && reholdSelfConfirmed(db) > 0 ? 'bank_accounts.rehold' : null;
    // the 1p test file (MON-6), downloads and void files (MON-2), two approvals (MONEY-MISSED-2)
    const more: (string | null)[] = [];
    if (columnsOf(db, 'payment_connections').length) {
      more.push(addColumnIfMissing(db, 'payment_connections', 'test_file_at', 'TEXT'));
      more.push(addColumnIfMissing(db, 'payment_connections', 'test_file_by', 'INTEGER'));
      more.push(addColumnIfMissing(db, 'payment_connections', 'test_file_result', 'TEXT'));
    }
    const hasBatches = columnsOf(db, 'payment_batches').includes('connection_id');
    if (hasBatches) {
      for (const [c, t] of [['downloaded_at', 'TEXT'], ['downloaded_by', 'INTEGER'], ['voided_at', 'TEXT'], ['voided_by', 'INTEGER'], ['void_reason', 'TEXT'], ['first_approved_at', 'TEXT'], ['first_approved_by', 'INTEGER']] as const) {
        more.push(addColumnIfMissing(db, 'payment_batches', c, t));
      }
      more.push(addColumnIfMissing(db, 'payment_items', 'freed_confirmed_at', 'TEXT'));
      more.push(addColumnIfMissing(db, 'payment_items', 'freed_by', 'INTEGER'));
      if (backfillDownloads(db) > 0) more.push('payment_batches.downloaded_at');
    }
    // items of payments approved before the column existed may have reached their provider: count them as sent
    if (attempted) {
      db.prepare(
        `UPDATE payment_items SET attempted_at = COALESCE(submitted_at, updated_at)
         WHERE attempted_at IS NULL AND batch_id IN (SELECT id FROM payment_batches WHERE approved_at IS NOT NULL)`,
      ).run();
    }
    // MONEY-MISSED-2: with two or more administrators using two-step, the "two approvals" default is stored, so it
    // never switches itself off later (an administrator leaving)
    const users = columnsOf(db, 'users');
    if (users.includes('totp_enabled_at') && users.includes('status') && keepTwoApprovalsDefault(db)) more.push('meta.ext:payments:two_approvals');
    return [payee, attempted, ...added, reheld, ...more].filter((c): c is string => c !== null);
  },
  seed(db, ctx) {
    seedDemoBankDetails(db, ctx);
  },
};
