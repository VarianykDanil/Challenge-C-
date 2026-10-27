/**
 * REL-9: problems that used to be seen only by someone who went looking now reach the administrators' Needs-attention
 * bell (kind 'system'), and server errors are written to a rotating log file in the data folder.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserWithTeam } from '@lm/shared';
import { run } from '../db/connection.ts';
import { configureSystemHealth, provider } from '../lib/attention/system.ts';
import { configureBackupDir, recordBackup, recordBackupFailure } from '../lib/backup.ts';
import { configureErrorLog, ERROR_LOG, logServerError, serverErrorsSince } from '../lib/errorLog.ts';
import { getUser } from '../db/queries.ts';
import { recordSheetConfirmed } from '../lib/recoverySheet.ts';
import { RESTORE_WARNING_META } from '../lib/restoreCheck.ts';
import { appKeyFingerprint, currentAppSecret, secretFingerprint } from '../lib/crypto.ts';
import { startTestServer, type TestServer } from './helpers.ts';

let srv: TestServer;
let tmp: string;
const NOW = { today: '2026-10-27', nowHHMM: '12:00', nowISO: '2026-10-27T12:00:00.000Z' };

before(async () => {
  srv = await startTestServer();
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-health-'));
  configureBackupDir(path.join(tmp, 'backups'), { scheduled: true });
});
after(async () => {
  configureBackupDir(null);
  configureSystemHealth({ dataDir: null, offsite: null });
  configureErrorLog(null);
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

const me = (id: number): UserWithTeam => ({ ...getUser(srv.db, id)!, twoFactorEnabled: true });
const items = (id: number) => provider.items(srv.db, me(id), NOW);
const keys = (id: number) => items(id).map((i) => i.key.replace(/:.*$/, (m) => m.split(':').slice(0, 2).join(':')));
const setMeta = (key: string, value: string) =>
  run(srv.db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);

describe('the system-health items', () => {
  test('administrators only', () => {
    const f = srv.fixture!;
    for (const id of [f.users.leader, f.users.recruiter, f.users.rep]) assert.deepEqual(items(id), []);
    assert.ok(items(f.users.admin).length > 0);
    assert.ok(items(f.users.admin).every((i) => i.kind === 'system'));
  });

  test('a failed backup is a danger item until a later backup succeeds', () => {
    const admin = srv.fixture!.users.admin;
    recordBackupFailure(srv.db, new Error('ENOSPC: no space left on device'), new Date(Date.now() - 60_000));
    const failed = items(admin).find((i) => i.key.startsWith('system:backup-failed'));
    assert.ok(failed);
    assert.equal(failed!.severity, 'danger');
    assert.match(failed!.body, /no space left/);
    recordBackup(srv.db, new Date().toISOString(), 'linear-2026-10-27-1200.sqlite');
    assert.equal(items(admin).some((i) => i.key.startsWith('system:backup-failed')), false);
  });

  test('no backup for over 36 hours is a warning (a fresh install gets 36 hours first)', () => {
    const admin = srv.fixture!.users.admin;
    run(srv.db, `DELETE FROM meta WHERE key IN ('last_backup_error_at', 'last_backup_error')`);
    setMeta('last_backup_at', new Date(Date.now() - 40 * 3_600_000).toISOString());
    const old = items(admin).find((i) => i.key.startsWith('system:backup-old'));
    assert.ok(old);
    assert.match(old!.title, /^No backup for 40 hours$/);
    setMeta('last_backup_at', new Date(Date.now() - 2 * 3_600_000).toISOString());
    assert.equal(items(admin).some((i) => i.key.startsWith('system:backup-old')), false);
  });

  test('off-site: a quiet line when it is off; a danger item when its folder is missing or it failed', () => {
    const admin = srv.fixture!.users.admin;
    configureSystemHealth({ offsite: null });
    const none = items(admin).find((i) => i.key === 'system:offsite-none');
    assert.equal(none?.severity, 'info');
    const pass = path.join(tmp, 'pass.txt');
    writeFileSync(pass, 'a-long-enough-passphrase\n');
    configureSystemHealth({ offsite: { dir: path.join(tmp, 'not-mounted'), passphraseFile: pass, includeVideos: false } });
    const failing = items(admin).find((i) => i.key.startsWith('system:offsite-failed'));
    assert.equal(failing?.severity, 'danger');
    assert.match(failing!.body, /not there/);
    mkdirSync(path.join(tmp, 'not-mounted'));
    assert.ok(items(admin).some((i) => i.key === 'system:offsite-first'), 'switched on, none made yet');
    setMeta('last_offsite_at', new Date(Date.now() - 3 * 24 * 3_600_000).toISOString());
    assert.match(items(admin).find((i) => i.key.startsWith('system:offsite-old'))!.title, /^No off-site copy for 3 days$/);
    setMeta('last_offsite_error_at', new Date().toISOString());
    setMeta('last_offsite_error', 'The upload folder went away');
    assert.match(items(admin).find((i) => i.key.startsWith('system:offsite-failed'))!.body, /upload folder went away/);
    configureSystemHealth({ offsite: null });
  });

  test('low disk space: a warning, and a danger item when nearly full', () => {
    const admin = srv.fixture!.users.admin;
    configureSystemHealth({ dataDir: tmp, diskSpace: () => ({ free: 600 * 1024 * 1024, total: 100 * 1024 ** 3 }) });
    assert.equal(items(admin).find((i) => i.key.startsWith('system:disk'))?.severity, 'warning');
    configureSystemHealth({ diskSpace: () => ({ free: 100 * 1024 * 1024, total: 100 * 1024 ** 3 }) });
    assert.equal(items(admin).find((i) => i.key.startsWith('system:disk'))?.severity, 'danger');
    configureSystemHealth({ diskSpace: () => ({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 }) });
    assert.equal(items(admin).some((i) => i.key.startsWith('system:disk')), false);
    configureSystemHealth({ dataDir: null });
  });

  test('the key not on a recovery sheet: the owner is told to make it, until confirmed for this key', () => {
    const admin = srv.fixture!.users.admin;
    appKeyFingerprint(); // the server makes its key at start-up
    const item = items(admin).find((i) => i.key === 'system:recovery-sheet');
    assert.ok(item);
    assert.match(item!.body, /Make the recovery sheet/);
    recordSheetConfirmed(srv.db, secretFingerprint(currentAppSecret()!.secret));
    assert.equal(items(admin).some((i) => i.key === 'system:recovery-sheet'), false);
    recordSheetConfirmed(srv.db, 'a-fingerprint-of-another-key');
    assert.ok(items(admin).some((i) => i.key === 'system:recovery-sheet'), 'a sheet for another key does not count');
  });

  test('a restore that forgot payments: a danger item for 14 days', () => {
    const admin = srv.fixture!.users.admin;
    setMeta(RESTORE_WARNING_META, JSON.stringify({ at: new Date().toISOString(), backup: 'linear-2026-10-20-0200.sqlite', approved: 1, sent: 2, bankFiles: 1, bankDetails: 0, paidRuns: 0 }));
    const w = items(admin).find((i) => i.key.startsWith('system:restored'));
    assert.equal(w?.severity, 'danger');
    assert.match(w!.body, /linear-2026-10-20-0200\.sqlite/);
    setMeta(RESTORE_WARNING_META, JSON.stringify({ at: new Date(Date.now() - 15 * 86_400_000).toISOString(), backup: 'x', approved: 1, sent: 0, bankFiles: 0, bankDetails: 0, paidRuns: 0 }));
    assert.equal(items(admin).some((i) => i.key.startsWith('system:restored')), false);
  });

  test('server errors in the last 24 hours, counted from the log file too after a restart', (t) => {
    t.mock.method(console, 'error', () => {});
    const admin = srv.fixture!.users.admin;
    const data = path.join(tmp, 'data-errors');
    configureErrorLog(data);
    assert.equal(items(admin).some((i) => i.key.startsWith('system:errors')), false);
    logServerError('Server error', new Error('boom'), { method: 'GET', path: '/api/venues?token=secret', userId: 7 });
    logServerError('Backup failed (nightly)', new Error('disk full'));
    const item = items(admin).find((i) => i.key.startsWith('system:errors'));
    assert.match(item!.title, /^2 server errors in the last 24 hours$/);
    assert.match(item!.body, /logs\/errors\.log/);
    const text = readFileSync(path.join(data, 'logs', 'errors.log'), 'utf8');
    assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z Server error \[GET \/api\/venues user 7\]: Error: boom/m);
    assert.equal(text.includes('token=secret'), false, 'never the query string');
    // a restart reads the file: errors of the last 24 hours still count, older ones do not
    writeFileSync(path.join(data, 'logs', 'errors.log'), `${new Date(Date.now() - 30 * 3_600_000).toISOString()} Old error: x\n${text}`);
    configureErrorLog(data);
    assert.equal(serverErrorsSince(), 2);
  });

  test('the error log rotates by size and keeps five old files', (t) => {
    t.mock.method(console, 'error', () => {});
    const data = path.join(tmp, 'data-rotate');
    configureErrorLog(data);
    const big = 'x'.repeat(200 * 1024);
    for (let i = 0; i < 40; i++) logServerError('Server error', new Error(big));
    const files = readdirSync(path.join(data, 'logs')).sort();
    assert.deepEqual(files, ['errors.1.log', 'errors.2.log', 'errors.3.log', 'errors.4.log', 'errors.5.log', 'errors.log']);
    for (const f of files) assert.ok(readFileSync(path.join(data, 'logs', f)).length <= ERROR_LOG.maxBytes + 300 * 1024);
    configureErrorLog(null);
  });
});

describe('a 500 answer is logged with its route and person', () => {
  test('a broken table: the person gets "Internal server error" and errors.log gets the details', async (t) => {
    t.mock.method(console, 'error', () => {});
    const other = await startTestServer();
    const data = path.join(tmp, 'data-500');
    configureErrorLog(data);
    try {
      const admin = await other.login('admin');
      other.db.exec('ALTER TABLE check_ins RENAME TO check_ins_gone');
      other.resetCache();
      const r = await admin.get(`/checkins?eventId=${other.fixture!.events.todayA}&token=secret`);
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: 'Internal server error' });
      const file = path.join(data, 'logs', 'errors.log');
      assert.ok(existsSync(file));
      const text = readFileSync(file, 'utf8');
      assert.match(text, /Server error \[GET \/api\/checkins user \d+\]: Error: no such table: check_ins/);
      assert.equal(text.includes('token=secret'), false, 'never the query string');
    } finally {
      configureErrorLog(null);
      await other.close();
    }
  });
});
