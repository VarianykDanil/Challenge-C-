/**
 * Release 1.3.1 UI review (UI-7, UI-19): the demo seed's invoices at any time of the week.
 *
 *  - Jordan Lee (the demo rep) always has last week's invoice to accept, also on a demo seeded after its Monday
 *    deadline (12:00 Thursday) and over the weekend: his is then issued at seed time, so the 24-hour rule keeps it open.
 *  - The seeded "sales" dispute names what is wrong on the line it points at, not a whole-week sales figure pinned on a
 *    commission line that was not paid.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { all, get } from '../db/connection.ts';
import { setBusinessClock } from '../lib/dates.ts';
import { startTestServer, type Json } from './helpers.ts';

const LAST_WEEK = '2026-10-12';

after(() => setBusinessClock(null));

async function seededAt(local: string, today: string) {
  setBusinessClock(new Date(local)); // TZ=Europe/London in the server test script
  return startTestServer({ seed: true, today });
}

for (const [label, local, today] of [
  ['Thursday 13:00, after the Monday deadline', '2026-10-22T13:00:00', '2026-10-22'],
  ['Friday 15:00 (payday)', '2026-10-23T15:00:00', '2026-10-23'],
  ['Sunday 20:00', '2026-10-25T20:00:00', '2026-10-25'],
] as const) {
  test(`demo seed on ${label}: Jordan still has last week's invoice to accept`, async () => {
    const demo = await seededAt(local, today);
    try {
      const jordan = await demo.login('rep');
      const mine = await jordan.get('/finance/me');
      const last = mine.json.runs.find((r: Json) => r.weekStart === LAST_WEEK);
      assert.ok(last, 'last week has a run');
      assert.equal(last.status, 'pending');
      assert.equal(last.invoice.status, 'issued', JSON.stringify(last.invoice));
      const row = get<{ issuedAt: string; deemAt: string }>(demo.db, `SELECT issued_at AS issuedAt, deem_at AS deemAt FROM invoices WHERE payroll_run_id = ?`, [last.id])!;
      const now = new Date(local).getTime();
      assert.ok(Date.parse(row.issuedAt) < now, 'issued before the seed ran');
      assert.ok(row.deemAt > local, `still open: deadline ${row.deemAt} is after ${local}`);
      // every acceptance and dispute in the demo still comes after its version was issued
      assert.equal(get<{ n: number }>(demo.db, `SELECT COUNT(*) AS n FROM invoices WHERE (accepted_at IS NOT NULL AND accepted_at < issued_at) OR (disputed_at IS NOT NULL AND disputed_at < issued_at)`)!.n, 0);
      // his is the newest invoice and has the last number (never a number below one issued before it)
      const newest = get<{ id: number }>(demo.db, `SELECT id FROM invoices ORDER BY issued_at DESC LIMIT 1`)!.id;
      const lastNumber = get<{ id: number }>(demo.db, `SELECT id FROM invoices ORDER BY number DESC LIMIT 1`)!.id;
      assert.equal(newest, last.invoice.id);
      assert.equal(lastNumber, last.invoice.id);
      // the accept flow works from the demo as seeded
      const ok = await jordan.post(`/invoices/${last.invoice.id}/accept`, {});
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
    } finally {
      await demo.close();
    }
  });
}

test('demo seed on Wednesday: Jordan\'s invoice is still the one issued on Monday morning', async () => {
  const demo = await seededAt('2026-10-21T15:00:00', '2026-10-21');
  try {
    const r = get<{ issuedAt: string; status: string }>(demo.db, `SELECT i.issued_at AS issuedAt, i.status FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
      JOIN users u ON u.id = p.user_id WHERE u.employee_id = 'LM-0010' AND p.week_start = ?`, [LAST_WEEK])!;
    assert.equal(r.status, 'issued');
    assert.equal(new Date(r.issuedAt).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), '2026-10-19', 'the Monday after the week');
  } finally {
    await demo.close();
  }
});

test('demo seed: the sales dispute says what is missing on the line it points at', async () => {
  const demo = await seededAt('2026-10-23T15:00:00', '2026-10-23');
  try {
    const rows = all<{ reason: string; lines: string; json: string }>(demo.db, `SELECT dispute_reason AS reason, dispute_lines AS lines, lines_json AS json FROM invoices WHERE status = 'disputed'`);
    assert.equal(rows.length, 2);
    const sales = rows.find((r) => /sales last week/.test(r.reason));
    assert.ok(sales, 'one sales dispute');
    const [picked] = JSON.parse(sales.lines) as { line: number; note?: string }[];
    const line = (JSON.parse(sales.json) as { kind: string; description: string }[])[picked!.line]!;
    assert.equal(line.kind, 'commission');
    assert.doesNotMatch(picked!.note ?? '', /^\d+ sales$/, 'not the whole week\'s sales figure on one campaign\'s line');
    assert.equal(picked!.note, '2 sign-ups missing');
  } finally {
    await demo.close();
  }
});
