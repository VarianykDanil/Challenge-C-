/**
 * Release 1.3.1 fix (1.3 final pay check): a self-billed invoice's lines carry the pay breakdown's note — why a line
 * is what it is ("7 logged, 1 cancelled by CHN", "not yet confirmed by BCN", a correction's "1 cancelled by BCN: paid
 * for 10, confirmed 9") — so the invoice the person accepts or disputes says it too. An invoice's stored lines are its
 * record: one issued before this fix (no notes) is never rewritten for it; the next version carries the notes, and the
 * version it replaces is kept as it was.
 *
 * The demo seed, with the business clock at Fri 23 Oct 2026, 15:00 London (as the owner runs it).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Invoice, InvoiceLine, PayLine, WeekPayBreakdown } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { restampInvoiceFingerprints, syncInvoices } from '../lib/invoices.ts';
import { applyConfirmedSales } from '../lib/payRule.ts';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

const NOW = new Date('2026-10-23T15:00:00');
setBusinessClock(NOW);

let srv: TestServer;
let admin: TestClient;

before(async () => {
  srv = await startTestServer({ seed: true, today: '2026-10-23' });
  admin = await srv.login('admin');
});
after(async () => {
  await srv.close();
  setBusinessClock(null);
});

interface OpenInvoice { id: number; runId: number; userId: number; weekStart: string }
/** The invoices of unpaid runs, as issued for their run as it stands. */
const openInvoices = () =>
  all<OpenInvoice>(
    srv.db,
    `SELECT i.id, i.payroll_run_id AS runId, p.user_id AS userId, p.week_start AS weekStart
     FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
     WHERE p.status IN ('pending', 'failed') AND i.status <> 'disputed' ORDER BY i.id`,
  );
const breakdownOf = async (i: OpenInvoice) => (await admin.get(`/pay/breakdown?userId=${i.userId}&weekStart=${i.weekStart}`)).json as WeekPayBreakdown;
const storedLines = (id: number) => get<{ l: string }>(srv.db, `SELECT lines_json AS l FROM invoices WHERE id = ?`, [id])!.l;
/** A note the description does not already say (a bonus's note is its description: "Bonus: top seller"). */
const shownNote = (l: PayLine) => (l.note?.trim() && !l.label.includes(l.note.trim()) ? l.note : undefined);

test('an invoice issued from the breakdown carries each line\'s note, as GET /pay/breakdown has it', async () => {
  let compared = 0;
  const seen: string[] = [];
  for (const i of openInvoices()) {
    const b = await breakdownOf(i);
    const inv = (await admin.get(`/invoices/by-run/${i.runId}`)).json as Invoice;
    if (b.runId !== i.runId || inv.lines.length !== b.lines.length) continue; // an invoice from the stored run's figures
    assert.deepEqual(inv.lines.map((l) => l.note), b.lines.map(shownNote), `invoice ${inv.number} (${i.weekStart})`);
    compared++;
    for (const l of inv.lines) if (l.note) seen.push(l.note);
  }
  assert.ok(compared > 5, `compared ${compared} invoices`);
  assert.ok(seen.some((n) => /\d+ logged, \d+ cancelled by [A-Z]+/.test(n)), `a cancellation note: ${JSON.stringify(seen.slice(0, 5))}`);
});

test('an invoice stored without notes is never rewritten for them; its next version carries them and the old one is kept as it was', async () => {
  // an invoice whose breakdown has a note, issued as 1.3 issued it (no notes)
  let target: { i: OpenInvoice; withNotes: InvoiceLine[] } | null = null;
  for (const i of openInvoices()) {
    const lines = JSON.parse(storedLines(i.id)) as InvoiceLine[];
    if (lines.some((l) => l.note)) {
      target = { i, withNotes: lines };
      break;
    }
  }
  assert.ok(target, 'an open invoice with a note');
  const { i } = target!;
  const asIssuedBefore = JSON.stringify(target!.withNotes.map(({ note: _note, ...l }) => l));
  run(srv.db, `UPDATE invoices SET lines_json = ? WHERE id = ?`, [asIssuedBefore, i.id]);
  srv.resetCache();
  const before = get<{ version: number; status: string }>(srv.db, `SELECT version, status FROM invoices WHERE id = ?`, [i.id])!;

  // the job runs (start-up, every 15 minutes): the run has not changed, so the invoice is left exactly as it was
  syncInvoices(srv.db, NOW);
  assert.equal(storedLines(i.id), asIssuedBefore, 'an issued invoice is not rewritten to add notes');
  const shown = (await admin.get(`/invoices/by-run/${i.runId}`)).json as Invoice;
  assert.ok(shown.lines.every((l) => !('note' in l)), 'and it reads as before');
  assert.equal(shown.version, before.version);

  // the week changes (a £5 bonus): a new version, from the breakdown, with the notes
  const bonus = await admin.post('/pay/bonuses', { userId: i.userId, weekStart: i.weekStart, amount: 5, note: 'Thank you for covering Saturday' });
  assert.equal(bonus.status, 201, JSON.stringify(bonus.json));
  syncInvoices(srv.db, NOW);
  const next = (await admin.get(`/invoices/by-run/${i.runId}`)).json as Invoice;
  assert.equal(next.version, before.version + 1, 'a new version');
  const b = await breakdownOf(i);
  assert.deepEqual(next.lines.map((l) => l.note), b.lines.map(shownNote), 'the new version carries the notes');
  assert.ok(next.lines.some((l) => l.note));
  const kept = get<{ l: string }>(srv.db, `SELECT lines_json AS l FROM invoice_versions WHERE invoice_id = ? AND version = ?`, [i.id, before.version])!.l;
  assert.equal(kept, asIssuedBefore, 'the version it replaced is kept exactly as it was issued');
});

/** An open invoice with a "not yet confirmed by <CODE>" note, the line's campaign and its logged number. */
function unconfirmedLine(): { i: OpenInvoice; campaignId: number; logged: number; code: string } | undefined {
  for (const i of openInvoices()) {
    const lines = JSON.parse(storedLines(i.id)) as InvoiceLine[];
    const l = lines.find((x) => x.note && /^not yet confirmed by /i.test(x.note) && x.campaignId && x.quantity != null);
    if (l) return { i, campaignId: l.campaignId!, logged: l.quantity!, code: l.note!.replace(/^not yet confirmed by /i, '').trim() };
  }
  return undefined;
}

test('a statement that confirms exactly what was logged clears "not yet confirmed" on the open invoice, in place', async () => {
  const t = unconfirmedLine();
  assert.ok(t, 'an open invoice with a "not yet confirmed" line');
  const { i, campaignId, logged, code } = t!;
  const before = get<{ version: number; status: string; total: number }>(srv.db, `SELECT version, status, total FROM invoices WHERE id = ?`, [i.id])!;
  const r = applyConfirmedSales(srv.db, [{ userId: i.userId, campaignId, weekStart: i.weekStart, confirmed: logged }], { statementId: null, actorId: null });
  assert.ok(r, 'applied');
  const sync = syncInvoices(srv.db, NOW);
  assert.ok(sync.refreshed >= 1, `refreshed in place: ${JSON.stringify(sync)}`);
  srv.resetCache();
  const inv = (await admin.get(`/invoices/by-run/${i.runId}`)).json as Invoice;
  assert.equal(inv.version, before.version, 'the same version: what is paid did not change');
  assert.equal(inv.status, before.status, 'and the same status');
  assert.equal(inv.total, before.total);
  const line = inv.lines.find((l) => l.campaignId === campaignId && l.quantity === logged);
  assert.ok(line, 'the line is still there');
  assert.ok(!line!.note || !new RegExp(`not yet confirmed by ${code}`, 'i').test(line!.note), `the note no longer says it is unconfirmed: ${line!.note}`);
  const b = await breakdownOf(i);
  assert.deepEqual(inv.lines.map((l) => l.note), b.lines.map(shownNote), 'the invoice reads as the breakdown does');
  assert.deepEqual(syncInvoices(srv.db, NOW), { issued: 0, reissued: 0, refreshed: 0, deemed: 0 }, 'and the next run changes nothing');
});

test('a disputed invoice: a same-number statement is not "the figures have changed"', async () => {
  const t = unconfirmedLine();
  assert.ok(t, 'another open invoice with a "not yet confirmed" line');
  const { i, campaignId, logged } = t!;
  run(srv.db, `UPDATE invoices SET status = 'disputed', dispute_reason = 'Checking the week', disputed_at = ? WHERE id = ?`, [NOW.toISOString(), i.id]);
  applyConfirmedSales(srv.db, [{ userId: i.userId, campaignId, weekStart: i.weekStart, confirmed: logged }], { statementId: null, actorId: null });
  syncInvoices(srv.db, NOW);
  srv.resetCache();
  const inv = (await admin.get(`/invoices/by-run/${i.runId}`)).json as Invoice & { figuresChanged?: boolean };
  assert.equal(inv.status, 'disputed', 'held for the office');
  assert.notEqual(inv.figuresChanged, true, 'the figures did not change');
});

test('upgrade: invoices stamped before 1.3.1 are restamped once, so none is rewritten at start-up for the new stamp', () => {
  // an up-to-date invoice whose week has confirmations, stamped the old way (figures only)
  const row = get<{ id: number; runId: number; fp: string; lines: string }>(
    srv.db,
    `SELECT i.id, i.payroll_run_id AS runId, i.run_fingerprint AS fp, i.lines_json AS lines FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
     WHERE p.status IN ('pending', 'failed') AND i.status <> 'disputed' AND instr(i.run_fingerprint, '#') > 0 ORDER BY i.id LIMIT 1`,
  );
  assert.ok(row, 'an open invoice whose week has confirmations');
  const old = row!.fp.split('#')[0]!;
  run(srv.db, `UPDATE invoices SET run_fingerprint = ? WHERE id = ?`, [old, row!.id]);
  assert.equal(restampInvoiceFingerprints(srv.db) >= 1, true, 'restamped');
  assert.equal(get<{ f: string }>(srv.db, `SELECT run_fingerprint AS f FROM invoices WHERE id = ?`, [row!.id])!.f, row!.fp, 'to the new stamp');
  assert.equal(restampInvoiceFingerprints(srv.db), 0, 'once');
  const refreshesBefore = get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM invoice_refreshes`)!.n;
  syncInvoices(srv.db, NOW);
  assert.equal(storedLines(row!.id), row!.lines, 'its lines are left as issued');
  assert.equal(get<{ n: number }>(srv.db, `SELECT COUNT(*) AS n FROM invoice_refreshes`)!.n, refreshesBefore, 'no refresh record');
  // an out-of-date one (its figures differ from the run's) is left for the job to bring up to date, as before
  run(srv.db, `UPDATE invoices SET run_fingerprint = ? WHERE id = ?`, ['0|0|0|0.00|0.00|0.00|0.00|0.00|0.00||-1|-1|0.00', row!.id]);
  restampInvoiceFingerprints(srv.db);
  assert.equal(get<{ f: string }>(srv.db, `SELECT run_fingerprint AS f FROM invoices WHERE id = ?`, [row!.id])!.f, '0|0|0|0.00|0.00|0.00|0.00|0.00|0.00||-1|-1|0.00');
});
