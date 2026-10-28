/**
 * p10 route test: GET /api/health carries `backup` for administrators only; every other role and an anonymous probe
 * get exactly the old shape { ok, version, seededAt }.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupNow, configureBackupDir } from '../lib/backup.ts';
import { startTestServer, type TestServer } from './helpers.ts';

let srv: TestServer;
let dir: string;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'linear-health-backups-'));
  configureBackupDir(dir, { scheduled: true });
  srv = await startTestServer();
});
after(async () => {
  await srv.close();
  configureBackupDir(null);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/health: admin sees backup {lastAt, file, count, dir, enabled}; others and anonymous do not', async () => {
  const [admin, leader, recruiter, rep] = await Promise.all([srv.login('admin'), srv.login('leader'), srv.login('recruiter'), srv.login('rep')]);

  const before = await admin.get('/health');
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.backup, { lastAt: null, file: null, count: 0, dir, enabled: true });

  const r = await backupNow(srv.db, { dir });
  // The file's time is the backup's own, as on a computer whose clock and file times agree (npm run test:dates moves
  // only the clock, so in the past the file would look newer than its record).
  utimesSync(r.path, new Date(r.at), new Date(r.at));
  const a = await admin.get('/health');
  assert.equal(a.status, 200);
  assert.equal(a.json.ok, true);
  assert.deepEqual(Object.keys(a.json.backup).sort(), ['count', 'dir', 'enabled', 'file', 'lastAt']);
  assert.equal(a.json.backup.file, r.file);
  assert.equal(a.json.backup.lastAt, r.at);
  assert.equal(a.json.backup.count, 1);
  assert.equal(a.json.backup.dir, dir);

  for (const [who, client] of [['leader', leader], ['recruiter', recruiter], ['rep', rep], ['anonymous', srv.anon()]] as const) {
    const res = await client.get('/health');
    assert.equal(res.status, 200, who);
    assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'seededAt', 'version'], `${who} gets the old shape`);
    assert.equal('backup' in res.json, false, `${who} sees no backup key`);
  }
});

test('GET /api/health: enabled is false when the server runs with LM_BACKUP=0, so Settings does not promise nightly copies', async () => {
  const admin = await srv.login('admin');
  configureBackupDir(dir, { scheduled: false });
  try {
    const off = await admin.get('/health');
    assert.equal(off.status, 200);
    assert.equal(off.json.backup.enabled, false);
    assert.equal(off.json.backup.dir, dir);
  } finally {
    configureBackupDir(dir, { scheduled: true });
  }
});
