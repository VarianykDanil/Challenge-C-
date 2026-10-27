/**
 * Backups (p10): a consistent, self-contained copy that opens and checks out; rotation over synthetic names; the
 * schedule rules; and restore's guard rails (refuses while the database is open in another process, on any port, or
 * a server holds the port; otherwise swaps the files and keeps the old database as .before-restore).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { addGauge, buildFixture, startTestServer } from '../test/helpers.ts';
import {
  BACKUP_FILE_RE,
  PARTIAL_FILE_RE,
  backupFileName,
  backupNow,
  backupStatus,
  databaseInUse,
  lastBackupMeta,
  listBackups,
  needsBootBackup,
  needsNightlyBackup,
  planRotation,
  restoreDatabase,
  restoreKeyNotes,
  rotate,
  scheduleBackups,
} from './backup.ts';
import { addDays, mondayOf } from './dates.ts';
import { secretFingerprint } from './crypto.ts';

let tmp: string;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-backup-test-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A fixture database in its own folder: live.sqlite (WAL, like the server's) and an app-secret. */
function fixtureDb(name: string): { dir: string; dbPath: string; db: DatabaseSync; secret: string } {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'live.sqlite');
  const db = openDb(dbPath);
  createSchema(db);
  buildFixture(db, '2026-10-19');
  const secret = path.join(dir, 'app-secret');
  writeFileSync(secret, 'fixture-secret-0123456789abcdef\n', { mode: 0o600 });
  return { dir, dbPath, db, secret };
}

const count = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe('backupNow', () => {
  test('writes a consistent, self-contained copy that passes integrity_check with the same users', async () => {
    const f = fixtureDb('copy');
    const backups = path.join(f.dir, 'backups');
    // 01:30 UTC on 19 Oct 2026 is 02:30 in London (BST)
    const r = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-19T01:30:00Z') });
    assert.equal(r.file, 'linear-2026-10-19-0230.sqlite');
    assert.equal(r.path, path.join(backups, r.file));
    assert.ok(r.bytes > 0 && statSync(r.path).size === r.bytes);

    const copy = new DatabaseSync(r.path, { readOnly: true });
    try {
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal(count(copy, 'users'), count(f.db, 'users'));
      assert.equal(count(copy, 'events'), count(f.db, 'events'));
      assert.equal((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
    } finally {
      copy.close();
    }
    // one file per backup: opening it read-only grew no -wal/-shm, and no .partial was left behind
    assert.deepEqual(readdirSync(backups).sort(), ['app-secret', r.file]);

    // the meta table records it, and the status reads it back
    assert.deepEqual(lastBackupMeta(f.db), { at: '2026-10-19T01:30:00.000Z', file: r.file });
    const status = backupStatus(f.db, backups);
    assert.equal(status.file, r.file);
    assert.equal(status.count, 1);
    assert.equal(status.dir, backups);
    f.db.close();
  });

  // REL-1: this used to expect the copy to be overwritten when the key changed, which lost the only saved copy of the
  // old key. A different key is now saved beside it instead (test/app-key.test.ts has the full case).
  test('copies the app-secret once with mode 0600; a changed key is saved beside the old copy, never over it', async () => {
    const f = fixtureDb('secret');
    const backups = path.join(f.dir, 'backups');
    const first = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-18T10:00:00Z') });
    assert.equal(first.secret, 'copied');
    const copy = path.join(backups, 'app-secret');
    assert.deepEqual(readFileSync(copy), readFileSync(f.secret));
    if (process.platform !== 'win32') assert.equal(statSync(copy).mode & 0o777, 0o600);
    const second = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-18T11:00:00Z') });
    assert.equal(second.secret, 'unchanged');
    const original = readFileSync(copy, 'utf8');
    writeFileSync(f.secret, 'rotated-secret\n');
    const third = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-18T12:00:00Z') });
    assert.equal(third.secret, 'kept-both');
    assert.equal(readFileSync(copy, 'utf8'), original, 'the old key copy is kept');
    const beside = path.join(backups, `app-secret-${secretFingerprint('rotated-secret').slice(0, 12)}`);
    assert.equal(readFileSync(beside, 'utf8'), 'rotated-secret\n');
    if (process.platform !== 'win32') assert.equal(statSync(beside).mode & 0o777, 0o600);
    const none = await backupNow(f.db, { dir: backups, secretFile: path.join(f.dir, 'missing'), now: new Date('2026-10-18T13:00:00Z') });
    assert.equal(none.secret, 'none');
    f.db.close();
  });

  test('a concurrent call shares the running backup; writes during a backup do not break it', async () => {
    const f = fixtureDb('concurrent');
    const backups = path.join(f.dir, 'backups');
    const now = new Date('2026-10-17T09:00:00Z');
    const a = backupNow(f.db, { dir: backups, now });
    const b = backupNow(f.db, { dir: backups, now });
    assert.equal(a, b);
    addGauge(f.db, { eventId: buildIds(f.db).event, userId: buildIds(f.db).rep, date: '2026-10-18', stops: 40, sales: 3 });
    const r = await a;
    const copy = new DatabaseSync(r.path, { readOnly: true });
    try {
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally {
      copy.close();
    }
    f.db.close();
  });

  test("stages in a file of its own: another process's backup in the same minute is not disturbed", async () => {
    const f = fixtureDb('staging');
    const backups = path.join(f.dir, 'backups');
    mkdirSync(backups, { recursive: true });
    // npm run backup (another process) is writing the 02:30 copy right now; an earlier build used the name without a pid
    const theirs = ['.linear-2026-10-19-0230.sqlite.99999999.partial', '.linear-2026-10-19-0230.sqlite.partial'];
    for (const n of theirs) writeFileSync(path.join(backups, n), 'in progress');
    const r = await backupNow(f.db, { dir: backups, now: new Date('2026-10-19T01:30:00Z') });
    for (const n of theirs) assert.equal(readFileSync(path.join(backups, n), 'utf8'), 'in progress', `${n} untouched`);
    assert.equal(readdirSync(backups).filter((n) => n.includes(`.${process.pid}.partial`)).length, 0, 'our own staging file is gone');
    assert.ok(existsSync(r.path));
    f.db.close();
  });

  test('names use Europe/London wall-clock time in winter and summer', () => {
    assert.equal(backupFileName(new Date('2026-12-01T02:05:00Z')), 'linear-2026-12-01-0205.sqlite'); // GMT
    assert.equal(backupFileName(new Date('2026-07-01T23:30:00Z')), 'linear-2026-07-02-0030.sqlite'); // BST, next London day
    assert.ok(BACKUP_FILE_RE.test('linear-2026-07-02-0030.sqlite'));
    for (const bad of ['linear-2026-13-01-0200.sqlite', 'linear-2026-10-19-2400.sqlite', 'linear-2026-10-19-0200.sqlite.bak', 'linear.sqlite']) {
      assert.equal(BACKUP_FILE_RE.test(bad), false, bad);
    }
  });
});

/** Let pending promise callbacks and I/O run (timers are mocked, so no setTimeout here). */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function waitUntil(done: () => boolean, rounds = 5000): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(done(), 'condition reached');
}

function buildIds(db: DatabaseSync): { event: number; rep: number } {
  const event = (db.prepare(`SELECT id FROM events WHERE date = '2026-10-18' ORDER BY id LIMIT 1`).get() as { id: number }).id;
  const rep = (db.prepare(`SELECT id FROM users WHERE email = 'remy.rep@fixture.test'`).get() as { id: number }).id;
  return { event, rep };
}

describe('rotation', () => {
  const today = '2026-10-19'; // a Monday
  /** Two backups a day (02:00 and 14:30) for 140 days, except every 9th day. */
  function syntheticNames(): string[] {
    const names: string[] = [];
    for (let i = 0; i < 140; i++) {
      if (i % 9 === 4) continue;
      const d = addDays(today, -i);
      names.push(`linear-${d}-0200.sqlite`, `linear-${d}-1430.sqlite`);
    }
    return names;
  }
  const unrelated = ['app-secret', 'notes.txt', 'linear.sqlite', 'linear-2026-10-19-0200.sqlite.bak', 'linear-2026-13-01-0200.sqlite', '.linear-2026-10-19-0300.sqlite.partial'];

  /** The expectation, written out the long way. */
  function expected(names: string[]): Set<string> {
    const have = new Set(names);
    const keep = new Set<string>();
    const newestOf = (dates: string[]) => {
      for (const d of [...dates].sort().reverse()) {
        for (const hhmm of ['1430', '0200']) if (have.has(`linear-${d}-${hhmm}.sqlite`)) return `linear-${d}-${hhmm}.sqlite`;
      }
      return null;
    };
    // the newest of each of the last 30 days (today and the 29 before it)
    for (let i = 0; i < 30; i++) {
      const n = newestOf([addDays(today, -i)]);
      if (n) keep.add(n);
    }
    // the newest of each of the 8 ISO weeks before those days (only the days before the 30-day window count)
    const windowStart = addDays(today, -29);
    let monday = mondayOf(addDays(windowStart, -1));
    for (let w = 0; w < 8; w++, monday = addDays(monday, -7)) {
      const days = Array.from({ length: 7 }, (_, k) => addDays(monday, k)).filter((d) => d < windowStart);
      const n = newestOf(days);
      if (n) keep.add(n);
    }
    return keep;
  }

  test('keeps exactly the newest file per day for 30 days plus the newest per week for 8 weeks', () => {
    const names = syntheticNames();
    const plan = planRotation([...names, ...unrelated], today);
    const want = expected(names);
    assert.deepEqual(new Set(plan.keep), want);
    assert.equal(plan.keep.length, want.size);
    assert.ok(want.size >= 30 + 8 - 4 && want.size <= 38, `kept ${want.size}`); // a few days are missing on purpose
    assert.equal(plan.keep.length + plan.remove.length, names.length);
    for (const u of unrelated) assert.ok(!plan.keep.includes(u) && !plan.remove.includes(u), `${u} is not touched`);
    // every kept daily file is the 14:30 one when the day has two
    for (const k of plan.keep) if (k >= `linear-${addDays(today, -29)}`) assert.match(k, /-1430\.sqlite$/);
  });

  test('rotate deletes only matching files in the folder, and nothing written in the last 24 hours', () => {
    const dir = path.join(tmp, 'rotate');
    mkdirSync(dir, { recursive: true });
    const names = syntheticNames();
    const now = new Date(`${today}T20:00:00Z`);
    for (const n of [...names, ...unrelated]) {
      const file = path.join(dir, n);
      writeFileSync(file, 'x');
      // each backup was written at the (UTC-ish) time in its name; unrelated files are old
      const m = BACKUP_FILE_RE.exec(n);
      const at = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`) : new Date('2020-01-01T00:00:00Z');
      utimesSync(file, at, at);
    }
    const r = rotate(dir, now);
    const left = new Set(readdirSync(dir));
    const want = expected(names);
    // today's 02:00 copy is under 24 h old: it stays until tomorrow even though 14:30 is today's newest
    want.add(`linear-${today}-0200.sqlite`);
    for (const u of unrelated) {
      // a years-old staging file is a killed backup's leftover: it goes; everything else that is not a backup stays
      if (PARTIAL_FILE_RE.test(u)) assert.ok(!left.has(u), `${u} (stale staging file) removed`);
      else assert.ok(left.has(u), `${u} kept`);
    }
    assert.ok(!r.remove.some((n) => PARTIAL_FILE_RE.test(n)), 'staging files are not reported as removed backups');
    assert.deepEqual(new Set([...left].filter((n) => BACKUP_FILE_RE.test(n))), want);
    assert.equal(r.remove.length, names.length - want.size);
    // a day later it goes
    const later = rotate(dir, new Date(`${addDays(today, 1)}T20:00:00Z`));
    assert.ok(later.remove.includes(`linear-${today}-0200.sqlite`));
  });

  test('rotate removes staging files a killed backup left once they are an hour old, and nothing that only looks like one', () => {
    const dir = path.join(tmp, 'rotate-partials');
    mkdirSync(dir, { recursive: true });
    const now = new Date('2026-10-19T12:00:00Z');
    const files: Record<string, number> = {
      '.linear-2026-10-19-0200.sqlite.4242.partial': 3, // hours old: a killed backup
      '.linear-2026-10-19-0200.sqlite.4242.partial-journal': 3,
      '.linear-2026-10-18-0200.sqlite.partial': 30, // the name an earlier build used
      '.linear-2026-10-19-1155.sqlite.777.partial': 0.05, // 3 minutes old: maybe another process is writing it
      '.linear-notes.txt': 30,
      'linear-2026-10-19-0200.sqlite.4242.partial': 30, // no leading dot: not ours
      'linear-2026-10-19-0200.sqlite': 10,
    };
    for (const [name, hours] of Object.entries(files)) {
      const file = path.join(dir, name);
      writeFileSync(file, 'x');
      const at = new Date(now.getTime() - hours * 3_600_000);
      utimesSync(file, at, at);
    }
    const r = rotate(dir, now);
    assert.deepEqual(r.remove, []);
    assert.deepEqual(readdirSync(dir).sort(), [
      '.linear-2026-10-19-1155.sqlite.777.partial',
      '.linear-notes.txt',
      'linear-2026-10-19-0200.sqlite',
      'linear-2026-10-19-0200.sqlite.4242.partial',
    ]);
  });

  test('never removes the newest backup, even when everything is older than the policy', () => {
    const plan = planRotation(['linear-2025-01-01-0200.sqlite', 'linear-2025-01-02-0200.sqlite', 'linear-2025-01-02-0900.sqlite'], today);
    assert.deepEqual(plan.keep, ['linear-2025-01-02-0900.sqlite']);
    assert.deepEqual(plan.remove.sort(), ['linear-2025-01-01-0200.sqlite', 'linear-2025-01-02-0200.sqlite']);
  });
});

describe('schedule rules', () => {
  test('start-up: back up when there is none or the last one is 24 h old', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    assert.equal(needsBootBackup(null, now), true);
    assert.equal(needsBootBackup('2026-10-18T12:00:00Z', now), true);
    assert.equal(needsBootBackup('2026-10-18T13:00:00Z', now), false);
    assert.equal(needsBootBackup('garbage', now), true);
  });

  test('nightly: from LM_BACKUP_HOUR (London) when none is dated today, including after a sleep past 02:00', () => {
    // 00:30 UTC = 01:30 BST: before 02:00, nothing yet
    assert.equal(needsNightlyBackup('2026-10-17T01:00:00Z', new Date('2026-10-19T00:30:00Z'), 2), false);
    // 01:10 UTC = 02:10 BST, last backup yesterday
    assert.equal(needsNightlyBackup('2026-10-18T01:05:00Z', new Date('2026-10-19T01:10:00Z'), 2), true);
    // the laptop slept through the night and wakes at 08:00: still due
    assert.equal(needsNightlyBackup('2026-10-18T01:05:00Z', new Date('2026-10-19T07:00:00Z'), 2), true);
    // a backup at 00:30 London today counts as today's
    assert.equal(needsNightlyBackup('2026-10-18T23:30:00Z', new Date('2026-10-19T03:00:00Z'), 2), false);
    // 23:30 UTC on 18 Oct is already 19 Oct in London, so a backup then is "today" at 02:00 on the 19th
    assert.equal(needsNightlyBackup(null, new Date('2026-10-19T03:00:00Z'), 2), true);
    // winter (GMT) and a custom hour
    assert.equal(needsNightlyBackup('2026-12-01T03:00:00Z', new Date('2026-12-02T04:59:00Z'), 5), false);
    assert.equal(needsNightlyBackup('2026-12-01T03:00:00Z', new Date('2026-12-02T05:00:00Z'), 5), true);
  });

  test('the schedule backs up 10 minutes after start-up when none is recent, and the hourly check then waits', async () => {
    const f = fixtureDb('schedule');
    const dir = path.join(f.dir, 'backups');
    const logs: string[] = [];
    const errors: string[] = [];
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let stop = () => {};
    try {
      stop = scheduleBackups(f.db, { dir, secretFile: f.secret, hour: 0, log: (l) => logs.push(l), error: (l) => errors.push(l) });
      mock.timers.tick(9 * 60_000);
      await settle();
      assert.equal(listBackups(dir).length, 0, 'nothing before 10 minutes');
      mock.timers.tick(60_000);
      await waitUntil(() => logs.length > 0);
      assert.equal(listBackups(dir).length, 1);
      assert.match(logs[0]!, /^Backed up the database \(start-up check: the last one was over 24 h old\) to .*linear-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite/);
      // an hour later the nightly check finds today's backup and does nothing
      mock.timers.tick(60 * 60_000);
      await settle();
      assert.equal(logs.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      stop();
      mock.timers.reset();
      f.db.close();
    }
  });

  test('status prefers a newer file in the folder over an older meta record (e.g. after a restore)', () => {
    const f = fixtureDb('status');
    const dir = path.join(f.dir, 'backups');
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(backupStatus(f.db, dir), { lastAt: null, file: null, count: 0, dir });
    f.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_backup_at', '2026-10-01T01:00:00.000Z'), ('last_backup_file', 'linear-2026-10-01-0200.sqlite')`).run();
    assert.equal(backupStatus(f.db, dir).file, 'linear-2026-10-01-0200.sqlite');
    const newer = path.join(dir, 'linear-2026-10-18-0200.sqlite');
    writeFileSync(newer, 'x');
    const t = new Date('2026-10-18T01:00:00Z');
    utimesSync(newer, t, t);
    const s = backupStatus(f.db, dir);
    assert.equal(s.file, 'linear-2026-10-18-0200.sqlite');
    assert.equal(s.lastAt, '2026-10-18T01:00:00.000Z');
    assert.equal(s.count, 1);
    assert.deepEqual(listBackups(path.join(f.dir, 'nope')), []);
    f.db.close();
  });
});

describe('restoreDatabase', () => {
  test('refuses while a server holds the port; otherwise swaps the files and keeps .before-restore', async () => {
    const f = fixtureDb('restore');
    const ids = buildIds(f.db);
    addGauge(f.db, { eventId: ids.event, userId: ids.rep, date: '2026-10-18', stops: 50, sales: 4 });
    const backups = path.join(f.dir, 'backups');
    const r = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-19T01:00:00Z') });
    // after the backup a gauge is deleted, then the server is stopped (the connection closed)
    f.db.prepare('DELETE FROM gauge_entries').run();
    f.db.close();
    rmSync(f.secret); // a new laptop: no key yet next to the database

    const srv = await startTestServer();
    const port = Number(new URL(srv.base).port);
    const lines: string[] = [];
    try {
      const refused = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port, confirm: async () => true, log: (l) => lines.push(l) });
      assert.equal(refused.status, 'refused');
      assert.match(refused.status === 'refused' ? refused.reason : '', /Linear Hub is running on port \d+.*Stop it first: npm run stop/s);
      assert.equal(readdirSync(f.dir).filter((n) => n.includes('before-restore') || n.includes('restoring')).length, 0, 'nothing moved');
    } finally {
      await srv.close();
    }

    // a damaged candidate and a non-Linear Hub database are refused without touching anything
    const junk = path.join(f.dir, 'junk.sqlite');
    writeFileSync(junk, 'not a database');
    const j = await restoreDatabase({ dbPath: f.dbPath, candidate: junk, port, confirm: async () => true, log: () => {} });
    assert.equal(j.status, 'refused');
    const other = path.join(f.dir, 'other.sqlite');
    const o = new DatabaseSync(other);
    o.exec('CREATE TABLE users (id INTEGER)');
    o.close();
    const oo = await restoreDatabase({ dbPath: f.dbPath, candidate: other, port, confirm: async () => true, log: () => {} });
    assert.equal(oo.status, 'refused');
    assert.match(oo.status === 'refused' ? oo.reason : '', /missing tables? .*gauge_entries/);

    // saying no changes nothing
    const no = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port, confirm: async () => false, log: () => {} });
    assert.equal(no.status, 'cancelled');
    assert.equal(readdirSync(f.dir).filter((n) => n.includes('before-restore') || n.includes('restoring')).length, 0);

    const done = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port, confirm: async () => true, log: (l) => lines.push(l), now: new Date('2026-10-19T14:02:03Z') });
    assert.equal(done.status, 'restored');
    if (done.status !== 'restored') return;
    assert.equal(done.previous, `${f.dbPath}.before-restore-2026-10-19-150203`);
    assert.ok(existsSync(done.previous!), 'old database kept');
    assert.equal(done.secret, 'installed');
    assert.deepEqual(readFileSync(f.secret), readFileSync(path.join(backups, 'app-secret')));
    assert.equal(readdirSync(f.dir).filter((n) => n.includes('restoring')).length, 0, 'no staging file left');
    // the gauge is back in the live file; the old one still has none
    const live = new DatabaseSync(f.dbPath, { readOnly: true });
    const old = new DatabaseSync(done.previous!, { readOnly: true });
    try {
      assert.equal(count(live, 'gauge_entries'), 1);
      assert.equal(count(old, 'gauge_entries'), 0);
      assert.equal((live.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally {
      live.close();
      old.close();
    }
    // the backup itself is untouched
    assert.ok(existsSync(r.path));
    // the comparison was printed
    assert.ok(lines.some((l) => /Gauge entries\s+0\s+1/.test(l)), lines.join('\n'));
  });

  test('refuses while another connection has the database open, whatever the port; restores once it is closed', async () => {
    const f = fixtureDb('restore-open');
    const backups = path.join(f.dir, 'backups');
    const r = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-19T01:00:00Z') });
    // f.db stays open, like a server running on another port (nothing answers on port 1)
    const nothingMoved = () => readdirSync(f.dir).filter((n) => n.includes('before-restore') || n.includes('restoring')).length === 0;
    assert.match(databaseInUse(f.dbPath) ?? '', /open in another process/);
    const refused = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {}, runningHint: 'service hint' });
    assert.equal(refused.status, 'refused');
    assert.match(refused.status === 'refused' ? refused.reason : '', /The database is open in another process, so it was not touched.*PORT=4001 npm run stop.*service hint/s);
    assert.ok(nothingMoved(), 'nothing moved');
    // the open connection still works and still sees its own file
    assert.ok(count(f.db, 'users') > 0);
    f.db.close();

    // idle (no connection open): the probe leaves the file alone and restore goes ahead
    assert.equal(databaseInUse(f.dbPath), null);
    assert.equal(databaseInUse(path.join(f.dir, 'missing.sqlite')), null);
    assert.equal(existsSync(path.join(f.dir, 'missing.sqlite')), false, 'the probe never creates a database');

    // a connection opened while the question is on screen is caught by the second check, before anything moves
    let late: DatabaseSync | null = null;
    const raced = await restoreDatabase({
      dbPath: f.dbPath,
      candidate: r.path,
      port: 1,
      log: () => {},
      confirm: async () => {
        late = openDb(f.dbPath);
        count(late, 'users');
        return true;
      },
    });
    assert.equal(raced.status, 'refused');
    assert.ok(nothingMoved(), 'nothing moved after the late connection');
    (late as DatabaseSync | null)?.close();

    const done = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {}, now: new Date('2026-10-19T14:10:00Z') });
    assert.equal(done.status, 'restored');
  });

  test('a server process on another port is caught by the lock, not the port', async () => {
    const f = fixtureDb('restore-other-process');
    const backups = path.join(f.dir, 'backups');
    const r = await backupNow(f.db, { dir: backups, secretFile: f.secret, now: new Date('2026-10-19T01:00:00Z') });
    f.db.close();
    // another process opens the file the way the server does (WAL, one read) and keeps it open
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode = WAL'); db.prepare('SELECT COUNT(*) FROM users').get(); console.log('ready'); setInterval(() => {}, 1000);`,
        f.dbPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await once(holder.stdout!, 'data');
      const refused = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {} });
      assert.equal(refused.status, 'refused');
      assert.match(refused.status === 'refused' ? refused.reason : '', /open in another process/);
      assert.equal(readdirSync(f.dir).filter((n) => n.includes('before-restore') || n.includes('restoring')).length, 0, 'nothing moved');
    } finally {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }
    const done = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {}, now: new Date('2026-10-19T14:11:00Z') });
    assert.equal(done.status, 'restored');
  });

  test('says when no two-step key is left anywhere, and how many people that affects', async () => {
    const f = fixtureDb('restore-no-key');
    f.db.prepare(`UPDATE users SET totp_enabled_at = '2026-10-01T09:00:00.000Z', totp_secret_enc = 'v1:x' WHERE email = 'remy.rep@fixture.test'`).run();
    const backups = path.join(f.dir, 'backups');
    // a backup made with no key file (so the folder holds no app-secret), restored on a laptop with no key either
    const r = await backupNow(f.db, { dir: backups, secretFile: null, now: new Date('2026-10-19T01:00:00Z') });
    f.db.close();
    rmSync(f.secret);
    assert.equal(existsSync(path.join(backups, 'app-secret')), false);
    const done = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {} });
    assert.equal(done.status, 'restored');
    if (done.status !== 'restored') return;
    assert.equal(done.secret, 'missing');
    assert.equal(done.candidate.twoStepUsers, 1);
    // with the key in place there is nothing to say
    writeFileSync(f.secret, 'fixture-secret-0123456789abcdef\n', { mode: 0o600 });
    const again = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {}, now: new Date('2026-10-19T14:05:00Z') });
    assert.equal(again.status === 'restored' ? again.secret : again.status, 'none');
  });

  test('warns when restored PINs depend on a key that is missing or different (PINs are peppered with it since 1.2)', async () => {
    const f = fixtureDb('restore-pin-key');
    // two peppered PINs and one 1.2.0 bare-scrypt PIN (which does not depend on the key); nobody has two-step
    f.db.prepare(`UPDATE users SET pin_hash = 'scrypt-hmac$16384$8$1$c2FsdA==$a2V5' WHERE email IN ('remy.rep@fixture.test', 'lee.leader@fixture.test')`).run();
    f.db.prepare(`UPDATE users SET pin_hash = 'scrypt$16384$8$1$c2FsdA==$a2V5' WHERE email = 'ada.admin@fixture.test'`).run();
    const backups = path.join(f.dir, 'backups');
    const r = await backupNow(f.db, { dir: backups, secretFile: null, now: new Date('2026-10-19T01:00:00Z') });
    f.db.close();
    rmSync(f.secret); // a new laptop, and a backup folder that never held the key

    const missing = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {} });
    assert.equal(missing.status, 'restored');
    if (missing.status !== 'restored') return;
    assert.equal(missing.secret, 'missing');
    assert.equal(missing.candidate.twoStepUsers, 0);
    assert.equal(missing.candidate.pinUsers, 2, 'peppered PINs only');
    const [warn, ...more] = restoreKeyNotes(missing.secret, missing.candidate);
    assert.equal(more.length, 0);
    assert.match(warn!, /^Warning: there is no app secret .* so 2 people with a sign-in PIN would be told "That PIN is not right"/);
    assert.match(warn!, /npm run pin:reset -- <email>/);
    assert.doesNotMatch(warn!, /two-step sign-in cannot|recovery code/, 'nobody has two-step');

    // the backups folder holds a different key from the one now next to the database
    writeFileSync(path.join(backups, 'app-secret'), 'the-key-the-pins-were-made-with\n', { mode: 0o600 });
    writeFileSync(f.secret, 'a-key-this-laptop-generated\n', { mode: 0o600 });
    const differs = await restoreDatabase({ dbPath: f.dbPath, candidate: r.path, port: 1, confirm: async () => true, log: () => {}, now: new Date('2026-10-19T14:07:00Z') });
    assert.equal(differs.status === 'restored' ? differs.secret : differs.status, 'differs');
    if (differs.status !== 'restored') return;
    const [note] = restoreKeyNotes(differs.secret, differs.candidate);
    assert.match(note!, /^Warning: the app secret in the backups folder .* differs .* the 2 people with a sign-in PIN would be told "That PIN is not right"/);
    assert.match(note!, /replace the app-secret next to the database with the copy from the backups folder/);
    assert.equal(readFileSync(f.secret, 'utf8'), 'a-key-this-laptop-generated\n', 'the live key is never overwritten');
  });

  test('restoreKeyNotes: one plain line per case, nothing when the key is fine or nobody depends on it', () => {
    const nobody = { pinUsers: 0, twoStepUsers: 0 };
    const both = { pinUsers: 3, twoStepUsers: 1 };
    assert.deepEqual(restoreKeyNotes('same', both), []);
    assert.deepEqual(restoreKeyNotes('none', both), [], 'LM_APP_SECRET set, or no copy to compare with');
    assert.deepEqual(restoreKeyNotes('missing', nobody), []);
    assert.match(restoreKeyNotes('installed', both)[0]!, /two-step codes and sign-in PINs keep working/);
    assert.match(restoreKeyNotes('differs', nobody)[0]!, /^Note: .* nothing depends on it yet/);
    const missingBoth = restoreKeyNotes('missing', both)[0]!;
    assert.match(missingBoth, /3 people with a sign-in PIN .* and 1 person with two-step sign-in cannot finish signing in with a code/);
    assert.match(missingBoth, /npm run pin:reset/);
    assert.match(missingBoth, /recovery code/);
    const twoStepOnly = restoreKeyNotes('missing', { pinUsers: 0, twoStepUsers: 2 })[0]!;
    assert.match(twoStepOnly, /2 people with two-step sign-in/);
    assert.doesNotMatch(twoStepOnly, /pin:reset/);
    assert.match(restoreKeyNotes('differs', { pinUsers: 1, twoStepUsers: 0 })[0]!, /the 1 person with a sign-in PIN would be told/);
  });
});
