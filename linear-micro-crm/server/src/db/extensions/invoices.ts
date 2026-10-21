/**
 * Release 1.3 — OWNED BY P2 invoices (laid down by r3-foundation: tables and columns are the contract; P2 adds data
 * steps, seed rows and further columns with addColumnIfMissing).
 *
 *  - self_billing_agreements: who accepted which version of the self-billing agreement, when and from which IP; one row
 *    per (person, version). A person accepts once before their first invoice can be accepted.
 *  - invoices: one self-billing invoice per payroll run (payroll_run_id UNIQUE; removed with the run — an unpaid run
 *    that stops being payable takes its invoice with it), number "LM-SB-<YYYY>-<6 digits>" UNIQUE, status 'issued' |
 *    'accepted' | 'deemed_accepted' | 'disputed' | 'resolved', version (1, then 2… after "Fix and reissue"), the lines
 *    and both parties as issued (JSON snapshots, so a later profile edit never rewrites an issued invoice), acceptance,
 *    dispute (reason, the disputed lines as JSON) and resolution.
 *  - users columns (the supplier block): address_line1, address_line2, address_town, postcode, utr (optional),
 *    vat_number (optional; none → "Not VAT registered").
 *  - meta: `ext:invoices:company` (Settings → Company as JSON: legal name, address, company number, signatory name,
 *    signature image path under server/data/uploads/) and `ext:invoices:seq:<YYYY>` (the number sequence).
 * Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';
import { addColumnIfMissing } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS self_billing_agreements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  ip TEXT,
  PRIMARY KEY (user_id, version)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id INTEGER NOT NULL UNIQUE REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  issued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  total REAL NOT NULL DEFAULT 0,
  lines_json TEXT NOT NULL DEFAULT '[]',
  supplier_json TEXT,
  customer_json TEXT,
  accepted_at TEXT,
  accepted_ip TEXT,
  disputed_at TEXT,
  dispute_reason TEXT,
  dispute_lines TEXT,
  resolved_at TEXT,
  resolved_by INTEGER,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
`;

export const extension: DbExtension = {
  name: 'invoices',
  sql: SQL,
  upgrade(db) {
    return [
      addColumnIfMissing(db, 'users', 'address_line1', 'TEXT'),
      addColumnIfMissing(db, 'users', 'address_line2', 'TEXT'),
      addColumnIfMissing(db, 'users', 'address_town', 'TEXT'),
      addColumnIfMissing(db, 'users', 'postcode', 'TEXT'),
      addColumnIfMissing(db, 'users', 'utr', 'TEXT'),
      addColumnIfMissing(db, 'users', 'vat_number', 'TEXT'),
    ].filter((name): name is string => name !== null);
  },
};
