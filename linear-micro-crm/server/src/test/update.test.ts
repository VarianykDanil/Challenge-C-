/**
 * REL-5 and RELIABILITY-MISSED-4: `npm run latest` takes and checks a backup before anything can change the database,
 * and does not update at all without one. Run for real on a scratch clone of the server code (git pull from a scratch
 * "upstream" with one new commit; LM_SKIP_PREPARE=1, so no packages are installed). The service stop/start commands
 * are checked as text (no launchctl or systemctl here).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { backupAndVerify } from '../lib/backup.ts';
import { serviceStartCommand, serviceStopCommand } from '../service.ts';
import { buildFixture } from './helpers.ts';

const appDir = path.resolve(import.meta.dirname, '../../..'); // linear-micro-crm/
let tmp: string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-update-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** upstream (with the server code) → a clone "office" one commit behind; a database next to it. */
function scratchCheckout(name: string): { office: string; upstream: string; dbPath: string } {
  const root = path.join(tmp, name);
  const upstream = path.join(root, 'upstream');
  mkdirSync(path.join(upstream, 'linear-micro-crm', 'server'), { recursive: true });
  cpSync(path.join(appDir, 'package.json'), path.join(upstream, 'linear-micro-crm', 'package.json'));
  cpSync(path.join(appDir, 'server', 'package.json'), path.join(upstream, 'linear-micro-crm', 'server', 'package.json'));
  cpSync(path.join(appDir, 'server', 'src'), path.join(upstream, 'linear-micro-crm', 'server', 'src'), { recursive: true });
  writeFileSync(path.join(upstream, '.gitignore'), 'node_modules\n');
  git(upstream, 'init', '-q');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'v1');
  const office = path.join(root, 'office');
  git(root, 'clone', '-q', upstream, office);
  symlinkSync(path.join(appDir, 'node_modules'), path.join(office, 'linear-micro-crm', 'node_modules'));
  writeFileSync(path.join(upstream, 'NEWS.md'), 'version 2\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'v2');
  const dbPath = path.join(root, 'data', 'linear.sqlite');
  return { office, upstream, dbPath };
}

async function latest(office: string, dbPath: string) {
  return spawnSync(process.execPath, [path.join(office, 'linear-micro-crm', 'server', 'src', 'update.ts'), '--no-start'], {
    cwd: path.join(office, 'linear-micro-crm'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: tmp, // no background service installed here
      XDG_CONFIG_HOME: path.join(tmp, '.config'),
      DB_PATH: dbPath,
      LM_APP_SECRET_FILE: path.join(path.dirname(dbPath), 'app-secret'),
      LM_APP_SECRET: '',
      LM_BACKUP_DIR: '',
      LM_SKIP_PREPARE: '1',
      PORT: String(await freePort()),
    },
    timeout: 120_000,
  });
}

test('npm run latest backs the database up and checks it before pulling', async () => {
  const s = scratchCheckout('ok');
  const db = openDb(s.dbPath);
  createSchema(db);
  buildFixture(db);
  db.close();
  const r = await latest(s.office, s.dbPath);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  const backedUp = out.indexOf('backed up and checked the database before the update');
  const pulled = out.indexOf('pulling the latest version');
  assert.ok(backedUp >= 0 && pulled > backedUp, `the backup comes first:\n${out}`);
  assert.match(out, /To go back: git checkout [0-9a-f]{12} && npm run setup && npm run restore -- linear-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite/);
  const backups = readdirSync(path.join(path.dirname(s.dbPath), 'backups'));
  assert.ok(backups.some((n) => /^linear-.*\.sqlite$/.test(n)));
  assert.equal(git(s.office, 'rev-parse', 'HEAD'), git(s.upstream, 'rev-parse', 'HEAD'), 'then it pulled');
});

test('no good backup, no update: a damaged database stops it before the pull', async () => {
  const s = scratchCheckout('damaged');
  mkdirSync(path.dirname(s.dbPath), { recursive: true });
  writeFileSync(s.dbPath, 'this is not a database');
  const head = git(s.office, 'rev-parse', 'HEAD');
  const r = await latest(s.office, s.dbPath);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No update without a good backup/);
  assert.equal(git(s.office, 'rev-parse', 'HEAD'), head, 'nothing was pulled');
});

test('backupAndVerify: the backup is opened again and compared with the database', async () => {
  const dir = path.join(tmp, 'verify');
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'linear.sqlite');
  const db = openDb(dbPath);
  createSchema(db);
  buildFixture(db);
  db.close();
  const { result, summary } = await backupAndVerify(dbPath, { dir: path.join(dir, 'backups') });
  assert.ok(existsSync(result.path));
  assert.equal(summary.users, 6);
});

test('the service is stopped and started with its own manager (never killed, which KeepAlive would undo)', () => {
  assert.deepEqual(serviceStopCommand('darwin', 501), ['launchctl', ['bootout', 'gui/501/uk.co.linear-mcr.hub']]);
  assert.deepEqual(serviceStopCommand('linux', 1000), ['systemctl', ['--user', 'stop', 'linear-hub.service']]);
  assert.deepEqual(serviceStartCommand('darwin', 501, '/Users/x'), ['launchctl', ['bootstrap', 'gui/501', '/Users/x/Library/LaunchAgents/uk.co.linear-mcr.hub.plist']]);
  assert.deepEqual(serviceStartCommand('linux', 1000), ['systemctl', ['--user', 'start', 'linear-hub.service']]);
  assert.equal(serviceStopCommand('win32'), null);
});
