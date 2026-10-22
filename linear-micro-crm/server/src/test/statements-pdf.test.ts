/**
 * Release 1.3 — P3 statements: real PDFs (drawn with jsPDF, read back with pdfjs-dist) through the statement reader —
 * a weekly totals statement, a multi-page per-sign-up statement with its header repeated, statements Linear Hub cannot
 * read (not a PDF, damaged, a scan with no text, a letter with no table, password-protected), and the demo seed's
 * statements, whose PDFs must read back exactly as the seed stored them.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { configureStatementsDir } from '../lib/statements/files.ts';
import { DEMO_STATEMENTS_META_KEY, ensureStatementFile } from '../lib/statements/demo.ts';
import { configurePdfReadTimeout, extractPdfItems, looksLikePdf, stopPdfWorker } from '../lib/statements/pdf.ts';
import { renderStatementPdf, type StatementPdfSpec } from '../lib/statements/render.ts';
import { NO_TABLE_MESSAGE, NO_TEXT_MESSAGE, readStatementPdf } from '../lib/statements/store.ts';
import { setBusinessClock, todayISO } from '../lib/dates.ts';

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lm-statements-pdf-'));
  configureStatementsDir(dir);
});
after(() => {
  configureStatementsDir(null);
  rmSync(dir, { recursive: true, force: true });
});

export function bcnSpec(over: Partial<StatementPdfSpec> = {}): StatementPdfSpec {
  return {
    title: 'Breast Cancer Now',
    subtitle: 'Face-to-face fundraising: commission statement',
    lines: ['Agency: Linear MCR Limited', 'Period: 05/10/2026 to 11/10/2026', 'Statement no. BCN-F2F-20261005'],
    headers: ['Fundraiser ID', 'Fundraiser name', 'Sign-ups', 'Cancelled', 'Paid subs', 'Amount'],
    rows: [
      ['FR-2041', 'Jordan Lee', '18', '2', '16', '£1,920.00'],
      ['FR-2044', "Sam O'Brien", '12', '0', '12', '£1,440.00'],
      ['FR-2047', 'Chloe Whitfield', '7', '1', '6', '£720.00'],
    ],
    totals: ['Total', '', '37', '3', '34', '£4,080.00'],
    notes: ['Paid subs are sign-ups whose first Direct Debit was collected.'],
    widths: [70, 150, 60, 60, 60, 80],
    right: [false, false, true, true, true, true],
    createdAt: '2026-10-14T08:00:00.000Z',
    color: '#EC4899',
    ...over,
  };
}

test('a weekly totals statement reads back: header, rows, the total line, the period', async () => {
  const pdf = await renderStatementPdf(bcnSpec());
  assert.ok(looksLikePdf(pdf));
  const parsed = await readStatementPdf(pdf);
  assert.equal(parsed.failure, null);
  assert.deepEqual(parsed.table!.headers, bcnSpec().headers);
  assert.deepEqual(parsed.table!.rows, bcnSpec().rows);
  assert.deepEqual(parsed.table!.totals, bcnSpec().totals);
  assert.deepEqual(parsed.period, { start: '2026-10-05', end: '2026-10-11' });
  assert.ok(parsed.texts.includes('Breast Cancer Now'));
});

test('the same spec always draws the same bytes (fixed creation date and file ID)', async () => {
  const a = await renderStatementPdf(bcnSpec());
  const b = await renderStatementPdf(bcnSpec());
  assert.equal(Buffer.compare(a, b), 0);
});

test('a 3-page per-sign-up statement: every row read once, the repeated headers and page footers skipped', async () => {
  const rows: string[][] = [];
  for (let i = 1; i <= 130; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    rows.push([`${day}/09/2026`, `CHN-2609-${String(i).padStart(4, '0')}`, i % 3 ? 'Ruby Fletcher' : 'Noah Simmons', i % 10 === 0 ? 'Cancelled' : 'Active']);
  }
  const spec = bcnSpec({
    title: "Children's Hospice North",
    subtitle: 'Agency sign-ups and cancellations',
    lines: ['Prepared for Linear MCR Limited', 'Statement for September 2026'],
    headers: ['Sign-up date', 'Supporter ref', 'Fundraiser', 'Status'],
    rows,
    totals: null,
    widths: [90, 110, 170, 100],
    right: undefined,
  });
  const parsed = await readStatementPdf(await renderStatementPdf(spec));
  assert.equal(parsed.failure, null);
  assert.deepEqual(parsed.table!.headers, spec.headers);
  assert.equal(parsed.table!.rows.length, 130);
  assert.deepEqual(parsed.table!.rows, rows);
  assert.deepEqual(parsed.period, { start: '2026-09-01', end: '2026-09-30' });
});

test('statements Linear Hub cannot read come back with the reason in plain words', async () => {
  assert.equal((await readStatementPdf(Buffer.from('Hello, this is not a PDF'))).failure, 'This file is not a PDF.');
  assert.match((await readStatementPdf(Buffer.from('%PDF-1.7\n1 0 obj garbage'))).failure!, /damaged|could not read/);
  const { jsPDF } = await import('jspdf');
  const scan = new jsPDF();
  scan.rect(20, 20, 100, 100, 'F'); // a picture, no text
  assert.equal((await readStatementPdf(Buffer.from(scan.output('arraybuffer')))).failure, NO_TEXT_MESSAGE);
  const letter = await renderStatementPdf(bcnSpec({ headers: [], rows: [], totals: null, lines: ['Amount paid: £14,850.00'] }));
  assert.equal((await readStatementPdf(letter)).failure, NO_TABLE_MESSAGE);
  const locked = new jsPDF({ encryption: { userPassword: 'secret', ownerPassword: 'owner', userPermissions: ['print'] } });
  locked.text('Fundraiser ID   Fundraiser name   Paid subs', 20, 20);
  assert.match((await readStatementPdf(Buffer.from(locked.output('arraybuffer')))).failure!, /password-protected/);
});

test('the demo seed: three statements whose PDFs, drawn on first open, read back exactly as stored', async () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    seed(db, todayISO());
    const rows = db.prepare(`SELECT s.id, c.code, s.status, s.table_json AS tableJson, s.period_start AS ps, s.period_end AS pe, s.file_path AS file, s.error
                               FROM statements s LEFT JOIN campaigns c ON c.id = s.campaign_id ORDER BY s.id`).all() as {
      id: number; code: string; status: string; tableJson: string | null; ps: string | null; pe: string | null; file: string | null; error: string | null;
    }[];
    assert.deepEqual(rows.map((r) => [r.code, r.status]), [['BCN', 'needs_review'], ['CHN', 'needs_review'], ['CHN', 'failed']]);
    assert.ok(rows.every((r) => r.file === null), 'seeding writes no files');
    assert.ok(db.prepare(`SELECT value FROM meta WHERE key = ?`).get(DEMO_STATEMENTS_META_KEY));
    for (const r of rows) {
      const pdf = await ensureStatementFile(db, r.id);
      assert.ok(pdf && looksLikePdf(pdf), `statement ${r.id} has a PDF`);
      const parsed = await readStatementPdf(pdf!);
      if (r.status === 'failed') {
        assert.equal(parsed.failure, r.error);
        continue;
      }
      const stored = JSON.parse(r.tableJson!) as { headers: string[]; rows: string[][]; totals: string[] | null };
      assert.deepEqual(parsed.table!.headers, stored.headers, `${r.code} headers`);
      assert.deepEqual(parsed.table!.rows, stored.rows, `${r.code} rows`);
      assert.deepEqual(parsed.table!.totals, stored.totals, `${r.code} total line`);
      assert.deepEqual(parsed.period, { start: r.ps, end: r.pe }, `${r.code} period`);
      const again = db.prepare(`SELECT file_path AS file, file_sha256 AS sha FROM statements WHERE id = ?`).get(r.id) as { file: string; sha: string };
      assert.ok(again.file && again.sha, 'the drawn file is kept and recorded');
      assert.equal(Buffer.compare((await ensureStatementFile(db, r.id))!, pdf!), 0, 'the second open reads the stored file');
    }
  } finally {
    db.close();
  }
});

test('the demo statements leave the office off: the owners are not on field pay (seeded on Wed 21 Oct 2026, when they sold for CHN)', () => {
  const db = openDb(':memory:');
  setBusinessClock(new Date('2026-10-21T15:00:00'));
  try {
    createSchema(db);
    seed(db, '2026-10-21');
    const admins = (db.prepare(`SELECT first_name || ' ' || last_name AS name FROM users WHERE role = 'admin'`).all() as { name: string }[]).map((a) => a.name);
    const chn = db.prepare(`SELECT s.id, s.table_json AS tableJson FROM statements s JOIN campaigns c ON c.id = s.campaign_id WHERE c.code = 'CHN' AND s.table_json IS NOT NULL`).get() as { id: number; tableJson: string };
    // they did log CHN sales in the statement's four weeks…
    const sold = db.prepare(
      `SELECT COUNT(*) AS n FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN campaigns c ON c.id = e.campaign_id JOIN users u ON u.id = g.user_id
        WHERE c.code = 'CHN' AND u.role = 'admin' AND g.sales > 0 AND g.date BETWEEN (SELECT period_start FROM statements WHERE id = ?) AND (SELECT period_end FROM statements WHERE id = ?)`,
    ).get(chn.id, chn.id) as { n: number };
    assert.ok(sold.n > 0, 'the fixture case: the owners have CHN gauges in the period');
    // …but the client's statement lists the field team only
    for (const name of admins) assert.ok(!chn.tableJson.includes(name), `${name} is not on the CHN statement`);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM statement_rows r JOIN users u ON u.id = r.user_id WHERE u.role = 'admin'`).get() as { n: number }).n, 0);
  } finally {
    setBusinessClock(null);
    db.close();
  }
});

test('a PDF that takes too long to read: its worker thread is ended and the next PDF reads in a fresh one', async () => {
  const pdf = await renderStatementPdf(bcnSpec());
  // a cold worker (a thread to start and pdfjs to load: tens of milliseconds) can never answer within 1 ms
  await stopPdfWorker();
  configurePdfReadTimeout(1);
  try {
    await assert.rejects(extractPdfItems(pdf), /^StatementReadError: Reading this PDF took too long/);
  } finally {
    configurePdfReadTimeout(null);
  }
  const parsed = await readStatementPdf(pdf);
  assert.equal(parsed.failure, null, 'a fresh worker reads the next PDF');
  assert.equal(parsed.table!.rows.length, bcnSpec().rows.length);
});
