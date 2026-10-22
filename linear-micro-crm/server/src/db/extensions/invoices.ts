/**
 * Release 1.3 — OWNED BY P2 invoices (laid down by r3-foundation: tables and columns are the contract; P2 adds data
 * steps, seed rows and further columns with addColumnIfMissing).
 *
 *  - self_billing_agreements: who accepted which version of the self-billing agreement, when and from which IP; one row
 *    per (person, version). A person accepts once before their first invoice can be accepted.
 *  - invoices: one self-billing invoice per payroll run (payroll_run_id UNIQUE; removed with the run — an unpaid run
 *    that stops being payable takes its invoice with it), number "LM-SB-<YYYY>-<6 digits>" UNIQUE, status 'issued' |
 *    'accepted' | 'deemed_accepted' | 'disputed' | 'resolved', version (1, then 2… after a reissue), the lines
 *    and both parties as issued (JSON snapshots, so a later profile edit never rewrites an accepted invoice), acceptance,
 *    dispute (reason, the disputed lines as JSON) and resolution.
 *    P2 adds (addColumnIfMissing, so a database created at the foundation commit upgrades too):
 *      deem_at            the deadline, naive Europe/London time ("2026-10-22T12:00:00"): 12:00 the day before payday;
 *                         a version issued later than a day before that gets until 12:00 the next day, but never past
 *                         00:00 on payday (shared invoiceDeadline);
 *      run_fingerprint    the run's figures when the lines were last written (lib/invoices.ts RUN_FINGERPRINT_SQL): a
 *                         different value later means the run was recalculated: the invoice is refreshed in place when
 *                         what is paid is the same, else reissued;
 *      resolution_action  'reissue' | 'keep' (the office's answer to a dispute);
 *      paid_override_reason / _by / _at: the run was marked paid before the invoice was accepted, and why.
 *  - invoice_versions (P2): each replaced version (its lines, total, status and dispute) when an invoice is reissued.
 *  - invoice_voids (P2): an invoice removed with its run (an unpaid week with nothing payable any more, or a deleted
 *    account) is kept here by the trigger invoices_keep_void — number, person, week's run, last version, status,
 *    total and lines — so every number ever issued is accounted for (no silent gap in the sequence).
 *  - users columns (the supplier block): address_line1, address_line2, address_town, postcode, utr (optional),
 *    vat_number (optional; none → "Not VAT registered").
 *  - meta: `ext:invoices:company` (Settings → Company as JSON: legal name, address, company number, signatory name,
 *    signature file under uploads/) and `ext:invoices:seq:<YYYY>` (the number sequence).
 *
 * Demo seed (fresh databases only): supplier details for the field people, the agreement accepted by everyone who has
 * worked a recent week (but the newest trainees), and an invoice for each field person's run of the last six completed
 * weeks and for every older unpaid run (failed transfers), each issued the Monday after its week — so the first job
 * tick has nothing to issue — paid weeks accepted or deemed accepted, one dispute the office kept as it was, and last week's (payday this
 * Friday) a mix of accepted, still to accept and two disputes waiting for the office. Jordan Lee (the demo rep) has
 * last week's invoice still to accept. Only this extension's tables, meta keys and users columns are written.
 * Rules: ./types.ts.
 */
import { SELF_BILLING_AGREEMENT_VERSION, effectiveInvoiceStatus, invoiceDeadline, isInvoicedRole, type InvoiceLine } from '@lm/shared';
import type { Db } from '../connection.ts';
import { addDays, mondayOf } from '../../lib/dates.ts';
import { businessLocal, fromBusinessLocal, issueInvoiceForRun } from '../../lib/invoices.ts';
import type { DbExtension, SeedContext } from './types.ts';
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

CREATE TABLE IF NOT EXISTS invoice_voids (
  invoice_id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  payroll_run_id INTEGER,
  user_id INTEGER,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  total REAL NOT NULL,
  lines_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  voided_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS invoices_keep_void BEFORE DELETE ON invoices
BEGIN
  INSERT OR REPLACE INTO invoice_voids (invoice_id, number, payroll_run_id, user_id, version, status, total, lines_json, issued_at, voided_at, reason)
  VALUES (OLD.id, OLD.number, OLD.payroll_run_id, OLD.user_id, OLD.version, OLD.status, OLD.total, OLD.lines_json, OLD.issued_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'Removed with its pay run: nothing was payable for the week any more, or the account was deleted');
END;

CREATE TABLE IF NOT EXISTS invoice_versions (
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  status TEXT NOT NULL,
  total REAL NOT NULL,
  lines_json TEXT NOT NULL,
  accepted_at TEXT,
  disputed_at TEXT,
  dispute_reason TEXT,
  dispute_lines TEXT,
  replaced_at TEXT NOT NULL,
  replaced_reason TEXT NOT NULL,
  PRIMARY KEY (invoice_id, version)
);
`;

// ───────────────────────────── demo data ─────────────────────────────

const STREETS = [
  'Oak Road', 'Victoria Street', 'Clarendon Road', 'Brook Lane', 'Mill Street', 'Church Road', 'Park Avenue', 'Albert Road',
  'Station Road', 'Moss Lane', 'Elm Grove', 'Queens Road', 'Grange Avenue', 'Hall Lane', 'Wellington Road', 'Beech Street',
];
/** A postcode area (and a few districts) per demo city, so the demo addresses look local. */
const POSTCODE_AREAS: Record<string, string[]> = {
  Manchester: ['M14', 'M20', 'M21', 'M19', 'M4', 'M15', 'M16', 'M40'],
  Salford: ['M5', 'M6', 'M7'],
  Stockport: ['SK1', 'SK2', 'SK4'],
  Bolton: ['BL1', 'BL3'],
  Oldham: ['OL1', 'OL8'],
  Bury: ['BL9'],
  Rochdale: ['OL11', 'OL16'],
  Wigan: ['WN1', 'WN5'],
  Sale: ['M33'],
  Altrincham: ['WA14', 'WA15'],
  Preston: ['PR1', 'PR2'],
  'Ashton-under-Lyne': ['OL6', 'OL7'],
  Leigh: ['WN7'],
};
const INWARD = 'ABDEFGHJLNPQRSTUWXYZ';

/** The demo disputes' words: what a person might say about last week's invoice (their claim, not a fact). */
function disputeReason(kind: 'sales' | 'days', run: { sales: number; daysWorked: number }): string {
  if (kind === 'sales') return `I made ${run.sales + 2} sales last week, not ${run.sales}. Two sign-ups from Saturday are missing.`;
  return `I worked ${run.daysWorked + 1} days, not ${run.daysWorked}. I covered the Thursday shift at the Arndale.`;
}

const at = (date: string, hh: number, mm: number): Date => fromBusinessLocal(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);

function seedInvoices(db: Db, ctx: SeedContext): void {
  const rng = ctx.rng(7302);
  const now = new Date(ctx.nowIso);
  const nowLocal = businessLocal(now);
  const field = ctx.users.filter((u) => isInvoicedRole(u.role));
  if (!field.length) return;
  const fieldIds = new Set(field.map((u) => u.id));

  // ── supplier details: an address for everyone, a UTR for most (Not VAT registered: none are) ──
  const cityOf = new Map((db.prepare(`SELECT id, city FROM users`).all() as { id: number; city: string | null }[]).map((r) => [r.id, r.city]));
  const setProfile = db.prepare(`UPDATE users SET address_line1 = ?, address_line2 = ?, address_town = ?, postcode = ?, utr = ? WHERE id = ?`);
  for (const u of field) {
    const town = cityOf.get(u.id) ?? 'Manchester';
    const areas = POSTCODE_AREAS[town] ?? POSTCODE_AREAS.Manchester!;
    const postcode = `${rng.pick(areas)} ${rng.int(1, 9)}${INWARD[rng.int(0, INWARD.length - 1)]}${INWARD[rng.int(0, INWARD.length - 1)]}`;
    const flat = rng.chance(0.25) ? `Flat ${rng.int(1, 24)}` : null;
    const utr = rng.chance(0.8) ? String(rng.int(1, 9)) + Array.from({ length: 9 }, () => String(rng.int(0, 9))).join('') : null;
    setProfile.run(`${rng.int(2, 180)} ${rng.pick(STREETS)}`, flat, town, postcode, utr, u.id);
  }

  // ── the agreement: everyone but trainees who started in the last five weeks ──
  const recent = addDays(mondayOf(ctx.today), -35);
  const acceptedAgreement = new Set<number>();
  const insertAgreement = db.prepare(`INSERT OR IGNORE INTO self_billing_agreements (user_id, version, accepted_at, ip) VALUES (?, ?, ?, ?)`);
  for (const u of field) {
    if (u.position === 'trainee' && u.startDate >= recent) continue;
    const day = u.startDate > addDays(ctx.today, -45) ? u.startDate : addDays(ctx.today, -45 + rng.int(0, 4));
    insertAgreement.run(u.id, SELF_BILLING_AGREEMENT_VERSION, at(day, rng.int(9, 20), rng.int(0, 59)).toISOString(), '192.168.1.' + rng.int(20, 200));
    acceptedAgreement.add(u.id);
  }

  // ── invoices: the field people's runs of the last six completed weeks, and every older unpaid run (failed transfers:
  //    they still owe money, so the first job tick would otherwise invoice them today), issued the Monday after each week ──
  const firstWeek = addDays(mondayOf(ctx.today), -42);
  const runs = db.prepare(
    `SELECT p.id, p.user_id AS userId, p.week_start AS weekStart, p.week_end AS weekEnd, p.due_date AS dueDate, p.status,
            p.paid_date AS paidDate, p.sales, p.days_worked AS daysWorked
     FROM payroll_runs p WHERE p.week_start >= ? OR p.status IN ('pending', 'failed') ORDER BY p.week_start, p.user_id`,
  ).all(firstWeek) as { id: number; userId: number; weekStart: string; weekEnd: string; dueDate: string; status: string; paidDate: string | null; sales: number; daysWorked: number }[];
  const jordan = ctx.users.find((u) => u.employeeId === 'LM-0010');
  const amelia = ctx.users.find((u) => u.employeeId === 'LM-0002');
  const lastWeek = runs.length ? runs[runs.length - 1]!.weekStart : null;
  // two disputes on last week's invoices: field reps other than the demo rep, with sales on the week
  const disputers = runs
    .filter((r) => r.weekStart === lastWeek && r.status === 'pending' && fieldIds.has(r.userId) && r.userId !== jordan?.id && r.sales > 0 && acceptedAgreement.has(r.userId))
    .map((r) => r.id);
  const disputeRuns = new Map<number, 'sales' | 'days'>();
  if (disputers.length) disputeRuns.set(disputers[Math.min(2, disputers.length - 1)]!, 'sales');
  if (disputers.length > 4) disputeRuns.set(disputers[disputers.length - 2]!, 'days');
  // one dispute in an earlier, paid week that the office kept as it was
  const keptRun = runs.find((r) => r.weekStart === addDays(lastWeek ?? firstWeek, -14) && (r.status === 'paid' || r.status === 'late') && fieldIds.has(r.userId) && r.userId !== jordan?.id && r.sales > 0);

  const accept = db.prepare(`UPDATE invoices SET status = 'accepted', accepted_at = ?, accepted_ip = ? WHERE id = ?`);
  const deem = db.prepare(`UPDATE invoices SET status = 'deemed_accepted' WHERE id = ?`);
  const dispute = db.prepare(`UPDATE invoices SET status = 'disputed', disputed_at = ?, dispute_reason = ?, dispute_lines = ? WHERE id = ?`);
  const keep = db.prepare(
    `UPDATE invoices SET status = 'resolved', disputed_at = ?, dispute_reason = ?, dispute_lines = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?, resolution_action = 'keep' WHERE id = ?`,
  );
  const owner = ctx.users.find((u) => u.position === 'owner');
  const linesOf = db.prepare(`SELECT lines_json AS l FROM invoices WHERE id = ?`);
  const commissionLine = (invoiceId: number): number => {
    const lines = JSON.parse((linesOf.get(invoiceId) as { l: string }).l) as InvoiceLine[];
    const i = lines.findIndex((l) => l.kind === 'commission');
    return i >= 0 ? i : 0;
  };
  const baseLine = (invoiceId: number): number => {
    const lines = JSON.parse((linesOf.get(invoiceId) as { l: string }).l) as InvoiceLine[];
    const i = lines.findIndex((l) => l.kind === 'base');
    return i >= 0 ? i : 0;
  };

  for (const r of runs) {
    if (!fieldIds.has(r.userId)) continue;
    const issueDay = addDays(r.weekEnd, 1); // Monday after the week
    const issuedAt = at(issueDay, 7, rng.int(0, 40));
    if (issuedAt.getTime() > now.getTime()) continue;
    const id = issueInvoiceForRun(db, r.id, issuedAt);
    if (id === null) continue;
    const deadline = invoiceDeadline(r.dueDate, businessLocal(issuedAt));
    const open = effectiveInvoiceStatus('issued', deadline, nowLocal) === 'issued';
    const agreed = acceptedAgreement.has(r.userId);
    // a daytime moment 0–2 days after issue (08:00–21:59), never after the deadline nor after "now", never before issue
    const daytime = (maxDays: number) => {
      const t = at(addDays(issueDay, rng.int(0, maxDays)), rng.int(8, 21), rng.int(0, 59)).getTime();
      const cap = Math.min(fromBusinessLocal(deadline).getTime() - 3_600_000, now.getTime() - 600_000);
      return new Date(Math.max(issuedAt.getTime() + 3_600_000, Math.min(t, cap))).toISOString();
    };
    const acceptedAt = () => daytime(2);
    const ip = () => `10.0.${rng.int(0, 9)}.${rng.int(2, 250)}`;

    if (disputeRuns.has(r.id)) {
      const kind = disputeRuns.get(r.id)!;
      const line = kind === 'sales' ? commissionLine(id) : baseLine(id);
      dispute.run(daytime(2), disputeReason(kind, r), JSON.stringify([{ line, note: kind === 'sales' ? `${r.sales + 2} sales` : `${r.daysWorked + 1} days` }]), id);
      continue;
    }
    if (keptRun && r.id === keptRun.id) {
      const t = at(addDays(issueDay, 1), 19, rng.int(0, 59)).toISOString();
      const resolvedAt = at(addDays(issueDay, 2), 10, rng.int(0, 59)).toISOString();
      keep.run(
        t, `I think I made ${r.sales + 1} sales, not ${r.sales}.`, JSON.stringify([{ line: commissionLine(id) }]), resolvedAt, owner?.id ?? null,
        `We checked the week's gauges with your team leader: ${r.sales} sales were logged, so the invoice stands. Log every sale on the day so nothing is missed.`,
        id,
      );
      continue;
    }
    if (open) {
      // last week: payday this Friday. Jordan (the demo rep) still has his to accept; Amelia has accepted hers.
      if (r.userId === jordan?.id || !agreed) continue;
      if (r.userId === amelia?.id || rng.chance(0.45)) accept.run(acceptedAt(), ip(), id);
      continue;
    }
    // earlier weeks: accepted, or deemed accepted (not disputed by the deadline)
    if (agreed && rng.chance(0.72)) accept.run(acceptedAt(), ip(), id);
    else deem.run(id);
  }
}

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
      // P2: on its own table (so a database created at the foundation commit gets them too)
      addColumnIfMissing(db, 'invoices', 'deem_at', 'TEXT'),
      addColumnIfMissing(db, 'invoices', 'run_fingerprint', 'TEXT'),
      addColumnIfMissing(db, 'invoices', 'resolution_action', 'TEXT'),
      addColumnIfMissing(db, 'invoices', 'paid_override_reason', 'TEXT'),
      addColumnIfMissing(db, 'invoices', 'paid_override_by', 'INTEGER'),
      addColumnIfMissing(db, 'invoices', 'paid_override_at', 'TEXT'),
    ].filter((name): name is string => name !== null);
  },
  seed: seedInvoices,
};
