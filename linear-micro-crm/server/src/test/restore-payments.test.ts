/**
 * REL-4: before a restore, list what Linear Hub would forget about money (payments approved or sent, bank files made,
 * bank details changed, pay runs marked paid after the backup) and go ahead only on a typed confirmation. The restored
 * database then carries a warning for the office.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { backupNow, restoreDatabase, RESTORE_TYPED_WORD } from '../lib/backup.ts';
import { configureAppSecret, encrypt } from '../lib/crypto.ts';
import { RESTORE_WARNING_META, describeLosses, paymentLosses } from '../lib/restoreCheck.ts';
import { buildFixture } from './helpers.ts';

let tmp: string;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-restore-pay-'));
  const key = path.join(tmp, 'key');
  writeFileSync(key, `${'c'.repeat(64)}\n`);
  configureAppSecret(key);
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function setup(): { db: Db; dbPath: string; backups: string; rep: number; rep2: number } {
  const dir = path.join(tmp, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'linear.sqlite');
  const db = openDb(dbPath);
  createSchema(db);
  const f = buildFixture(db);
  return { db, dbPath, backups: path.join(dir, 'backups'), rep: f.users.rep, rep2: f.users.repA2 };
}

const now = new Date().toISOString();
function payRun(db: Db, userId: number, week: string, status: string): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, gross, due_date, status, reference, paid_date) VALUES (?, ?, ?, 450, ?, ?, ?, ?)`,
    [userId, week, week, week, status, `REF-${userId}-${week}`, status === 'paid' ? week : null],
  ).lastInsertRowid;
}
function bankDetails(db: Db, userId: number, changedAt: string): void {
  run(
    db,
    `INSERT INTO bank_accounts (user_id, holder_name, sort_code_enc, account_number_enc, last4, sort_code_last2, changed_at, changed_by)
     VALUES (?, 'Test Person', ?, ?, '0001', '00', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET account_number_enc = excluded.account_number_enc, last4 = excluded.last4, changed_at = excluded.changed_at`,
    [userId, encrypt('000000'), encrypt('00000001'), changedAt, userId],
  );
}
function livePayment(db: Db, runId: number, userId: number, week: string): void {
  const conn = run(db, `INSERT INTO payment_connections (provider, name, mode, created_at) VALUES ('bank_file', 'Test bank file', 'live', ?)`, [now]).lastInsertRowid;
  const batch = run(
    db,
    `INSERT INTO payment_batches (connection_id, provider, mode, created_at, approved_at, total_pence, count, status, file_name, idempotency_key, updated_at)
     VALUES (?, 'bank_file', 'live', ?, ?, 45000, 1, 'submitted', 'linear-pay-test.csv', ?, ?)`,
    [conn, now, now, `key-${runId}`, now],
  ).lastInsertRowid;
  run(
    db,
    `INSERT INTO payment_items (batch_id, payroll_run_id, user_id, week_start, amount_pence, payee_name, account_last4, status, updated_at, live)
     VALUES (?, ?, ?, ?, 45000, 'Test Person', '0001', 'submitted', ?, 1)`,
    [batch, runId, userId, week, now],
  );
}

test('nothing forgotten: an ordinary yes is enough and no warning is stored', async () => {
  const s = setup();
  payRun(s.db, s.rep, '2026-10-05', 'paid');
  const r = await backupNow(s.db, { dir: s.backups, now: new Date('2026-10-19T01:00:00Z') });
  s.db.close();
  const asked: Array<{ typed?: string }> = [];
  const done = await restoreDatabase({ dbPath: s.dbPath, candidate: r.path, port: 1, confirm: async (_q, o) => (asked.push(o ?? {}), true), log: () => {} });
  assert.equal(done.status, 'restored');
  assert.deepEqual(asked, [{}]);
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT 1 FROM meta WHERE key = ?`).get(RESTORE_WARNING_META), undefined);
  db.close();
});

test('payments, a bank file, a bank details change and a run marked paid after the backup: listed, and only RESTORE typed goes ahead', async () => {
  const s = setup();
  bankDetails(s.db, s.rep2, '2026-10-01T09:00:00.000Z');
  const r = await backupNow(s.db, { dir: s.backups, now: new Date('2026-10-19T01:00:00Z') });
  // after the backup: a week paid through a bank file, someone's bank details changed, a run marked paid by hand
  const week = '2026-10-12';
  const paid = payRun(s.db, s.rep, week, 'pending');
  livePayment(s.db, paid, s.rep, week);
  payRun(s.db, s.rep2, week, 'paid');
  bankDetails(s.db, s.rep2, '2026-10-20T09:00:00.000Z');
  s.db.close();

  const losses = paymentLosses(s.dbPath, r.path);
  assert.equal(losses.approved.length, 1);
  assert.equal(losses.sent.count, 1);
  assert.equal(losses.sent.pence, 45000);
  assert.deepEqual(losses.bankFiles.map((f) => f.fileName), ['linear-pay-test.csv']);
  assert.equal(losses.bankDetails.length, 1);
  assert.equal(losses.paidRuns.count, 1);
  const text = describeLosses(losses).join('\n');
  assert.match(text, /1 payment approved after the backup \(£450\.00/);
  assert.match(text, /1 bank file made: linear-pay-test\.csv/);
  assert.match(text, /1 bank details change: Rita Rep\. The backup has their OLD bank details/);
  assert.match(text, /1 pay run marked paid \(£450\.00\): Rita Rep/);
  assert.match(text, /could be paid twice/);

  // a plain yes is not enough: the question asks for the typed word, and anything else cancels
  const lines: string[] = [];
  const asked: Array<{ typed?: string }> = [];
  const cancelled = await restoreDatabase({
    dbPath: s.dbPath,
    candidate: r.path,
    port: 1,
    confirm: async (_q, o) => (asked.push(o ?? {}), false),
    log: (l) => lines.push(l),
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(asked, [{ typed: RESTORE_TYPED_WORD }]);
  assert.match(lines.join('\n'), /Restoring it makes Linear Hub forget them/);

  const done = await restoreDatabase({ dbPath: s.dbPath, candidate: r.path, port: 1, confirm: async (_q, o) => o?.typed === RESTORE_TYPED_WORD, log: () => {} });
  assert.equal(done.status, 'restored');
  if (done.status !== 'restored') return;
  assert.equal(done.losses.total, 5);
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  try {
    const warning = JSON.parse((db.prepare(`SELECT value FROM meta WHERE key = ?`).get(RESTORE_WARNING_META) as { value: string }).value);
    assert.equal(warning.sent, 1);
    assert.equal(warning.bankDetails, 1);
    assert.equal(warning.backup, path.basename(r.path));
  } finally {
    db.close();
  }
});
