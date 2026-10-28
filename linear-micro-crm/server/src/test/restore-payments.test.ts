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

// Review of REL-4: the comparison used to fail open (any SQL error gave "nothing lost", so a plain yes was enough).
test('when the money records cannot be compared, restore says so and still needs RESTORE typed', async () => {
  const s = setup();
  const r = await backupNow(s.db, { dir: s.backups, now: new Date('2026-10-19T01:00:00Z') });
  // the live database's payments table is not what this version expects (a damaged or half-upgraded database)
  s.db.exec('ALTER TABLE payment_items RENAME COLUMN live TO live_gone');
  s.db.close();

  const losses = paymentLosses(s.dbPath, r.path);
  assert.ok(losses.unknown, 'the failure is reported, not hidden');
  assert.equal(losses.total, 0);
  const text = describeLosses(losses).join('\n');
  assert.match(text, /could not compare the money records/);
  assert.match(text, /check each payment against the bank statement/i);

  const asked: Array<{ typed?: string }> = [];
  const cancelled = await restoreDatabase({ dbPath: s.dbPath, candidate: r.path, port: 1, confirm: async (_q, o) => (asked.push(o ?? {}), false), log: () => {} });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(asked, [{ typed: RESTORE_TYPED_WORD }], 'a plain yes is not enough');

  const done = await restoreDatabase({ dbPath: s.dbPath, candidate: r.path, port: 1, confirm: async (_q, o) => o?.typed === RESTORE_TYPED_WORD, log: () => {} });
  assert.equal(done.status, 'restored');
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  try {
    const warning = JSON.parse((db.prepare(`SELECT value FROM meta WHERE key = ?`).get(RESTORE_WARNING_META) as { value: string }).value);
    assert.equal(warning.unknown, true, 'the office is warned in the app too');
  } finally {
    db.close();
  }
});

test('an unreadable live database also needs RESTORE typed (nothing tells what it held)', async () => {
  const s = setup();
  const r = await backupNow(s.db, { dir: s.backups, now: new Date('2026-10-19T01:00:00Z') });
  s.db.close();
  writeFileSync(s.dbPath, 'this is not a database any more');
  for (const suffix of ['-wal', '-shm']) rmSync(s.dbPath + suffix, { force: true });
  const losses = paymentLosses(s.dbPath, r.path);
  assert.ok(losses.unknown);
  assert.match(describeLosses(losses).join('\n'), /could not compare the money records/);
});

// Release check of 1.5.0: a backup made after a bank file was approved, then the file downloaded and marked paid (the
// run paid after its due date, so 'late'), was restored with no warning: the check counted only runs 'paid', compared
// bank files by name (approval names them) and never by download (MON-2: a downloaded file counts as sent), and did not
// count payments that moved from sent to paid. The week could then be paid again.
const PASSPHRASE = 'tidy-otter-copper-maple-river';
type Kind = 'sqlite' | 'lhbk';

async function backupAs(s: ReturnType<typeof setup>, kind: Kind): Promise<string> {
  const dir = path.dirname(s.dbPath);
  const offsiteDir = path.join(dir, 'cloud-drive');
  const passFile = path.join(dir, 'passphrase.txt');
  mkdirSync(offsiteDir, { recursive: true });
  writeFileSync(passFile, `${PASSPHRASE}\n`, { mode: 0o600 });
  const r = await backupNow(s.db, {
    dir: s.backups,
    now: new Date('2026-10-19T01:00:00Z'),
    offsite: kind === 'lhbk' ? { dir: offsiteDir, passphraseFile: passFile, includeVideos: false, kdfN: 2 ** 12 } : null,
  });
  if (kind === 'sqlite') return r.path;
  assert.equal(r.offsiteError, null);
  return r.offsite!.path;
}

/** A live bank file for one run, approved and named (the state approval leaves it in), not downloaded yet. */
function approvedFile(db: Db, runId: number, userId: number, week: string): { batch: number; item: number } {
  const conn = run(db, `INSERT INTO payment_connections (provider, name, mode, created_at) VALUES ('bank_file', 'Test bank file', 'live', ?)`, [now]).lastInsertRowid;
  const batch = run(
    db,
    `INSERT INTO payment_batches (connection_id, provider, mode, created_at, approved_at, total_pence, count, status, file_name, idempotency_key, updated_at)
     VALUES (?, 'bank_file', 'live', ?, ?, 8000, 1, 'submitted', 'linear-pay-week.csv', ?, ?)`,
    [conn, now, now, `key-file-${runId}`, now],
  ).lastInsertRowid;
  const item = run(
    db,
    `INSERT INTO payment_items (batch_id, payroll_run_id, user_id, week_start, amount_pence, payee_name, account_last4, status, updated_at, live)
     VALUES (?, ?, ?, ?, 8000, 'Test Person', '0001', 'submitted', ?, 1)`,
    [batch, runId, userId, week, now],
  ).lastInsertRowid;
  return { batch, item };
}

/** Restores the backup twice: once cancelled (to read what it lists and asks), then with RESTORE typed. */
async function restoreBoth(s: ReturnType<typeof setup>, candidate: string) {
  const lines: string[] = [];
  const asked: Array<{ typed?: string }> = [];
  const cancelled = await restoreDatabase({
    dbPath: s.dbPath,
    candidate,
    port: 1,
    confirm: async (_q, o) => (asked.push(o ?? {}), false),
    passphrase: async () => PASSPHRASE,
    secretFile: null,
    log: (l) => lines.push(l),
  });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  const done = await restoreDatabase({
    dbPath: s.dbPath,
    candidate,
    port: 1,
    confirm: async (_q, o) => o?.typed === RESTORE_TYPED_WORD,
    passphrase: async () => PASSPHRASE,
    secretFile: null,
    log: () => {},
  });
  assert.equal(done.status, 'restored', JSON.stringify(done));
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  let warning: Record<string, unknown> | null;
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(RESTORE_WARNING_META) as { value: string } | undefined;
    warning = row ? JSON.parse(row.value) : null;
  } finally {
    db.close();
  }
  return { asked, text: lines.join('\n'), done, warning };
}

for (const kind of ['sqlite', 'lhbk'] as const) {
  test(`${kind} backup: a week marked paid after its due date ('late') after the backup is listed, and needs RESTORE typed`, async () => {
    const s = setup();
    const week = '2026-10-12';
    const runId = payRun(s.db, s.rep, week, 'pending');
    const candidate = await backupAs(s, kind);
    run(s.db, `UPDATE payroll_runs SET status = 'late', paid_date = '2026-10-20' WHERE id = ?`, [runId]);
    s.db.close();

    const r = await restoreBoth(s, candidate);
    assert.deepEqual(r.asked, [{ typed: RESTORE_TYPED_WORD }], 'a plain yes is not enough');
    assert.match(r.text, /1 pay run marked paid \(£450\.00\): Remy Rep/);
    assert.ok(r.done.status === 'restored' && r.done.losses.paidRuns.count === 1);
    assert.equal(r.warning?.paidRuns, 1);
  });

  test(`${kind} backup: a bank file downloaded and marked paid after the backup is listed, and needs RESTORE typed`, async () => {
    const s = setup();
    const week = '2026-10-12';
    const runId = payRun(s.db, s.rep, week, 'pending');
    const f = approvedFile(s.db, runId, s.rep, week);
    const candidate = await backupAs(s, kind);
    // after the backup: the file is downloaded (so it may be at the bank), then marked paid; the run was due before
    run(s.db, `UPDATE payment_batches SET downloaded_at = ?, status = 'completed' WHERE id = ?`, ['2026-10-19T09:00:00.000Z', f.batch]);
    run(s.db, `UPDATE payment_items SET status = 'paid', paid_at = ? WHERE id = ?`, ['2026-10-20T09:00:00.000Z', f.item]);
    run(s.db, `UPDATE payroll_runs SET status = 'late', paid_date = '2026-10-20' WHERE id = ?`, [runId]);
    s.db.close();

    const r = await restoreBoth(s, candidate);
    assert.deepEqual(r.asked, [{ typed: RESTORE_TYPED_WORD }], 'a plain yes is not enough');
    assert.match(r.text, /1 bank file downloaded after the backup[^\n]*: linear-pay-week\.csv/);
    assert.match(r.text, /1 payment to people sent to the bank or paid \(£80\.00\): Remy Rep/);
    assert.match(r.text, /1 pay run marked paid \(£450\.00\): Remy Rep/);
    assert.doesNotMatch(r.text, /approved after the backup/, 'the backup had the approval');
    assert.doesNotMatch(r.text, /bank file made/, 'the backup had the file');
    if (r.done.status !== 'restored') return;
    assert.equal(r.done.losses.downloaded.length, 1);
    assert.equal(r.done.losses.sent.count, 1);
    assert.equal(r.done.losses.paidRuns.count, 1);
    assert.equal(r.done.losses.total, 3);
    assert.equal(r.warning?.downloaded, 1);
    assert.equal(r.warning?.sent, 1);
  });
}

test('a 1.4 backup (no downloaded_at column): a download after it counts, one in its audit trail does not', async () => {
  const s = setup();
  const week = '2026-10-12';
  const runId = payRun(s.db, s.rep, week, 'pending');
  const f = approvedFile(s.db, runId, s.rep, week);
  const r = await backupNow(s.db, { dir: s.backups, now: new Date('2026-10-19T01:00:00Z') });
  run(s.db, `UPDATE payment_batches SET downloaded_at = ? WHERE id = ?`, ['2026-10-19T09:00:00.000Z', f.batch]);
  s.db.close();
  const bk = new DatabaseSync(r.path);
  try {
    bk.exec('ALTER TABLE payment_batches DROP COLUMN downloaded_at');
  } finally {
    bk.close();
  }
  const lost = paymentLosses(s.dbPath, r.path);
  assert.equal(lost.unknown, null);
  assert.deepEqual(lost.downloaded.map((d) => d.fileName), ['linear-pay-week.csv']);
  assert.equal(lost.total, 1);

  // 1.4 wrote the download only to the audit trail; 1.5's upgrade turns that into downloaded_at after the restore
  const bk2 = new DatabaseSync(r.path);
  try {
    bk2.prepare(`INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary) VALUES (?, NULL, 'GET /payments/batches/:id/file', 'payment_batch', ?, 'Downloaded')`).run('2026-10-18T09:00:00.000Z', f.batch);
  } finally {
    bk2.close();
  }
  const kept = paymentLosses(s.dbPath, r.path);
  assert.equal(kept.downloaded.length, 0);
  assert.equal(kept.total, 0);
});
