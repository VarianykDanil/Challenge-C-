/**
 * p10: the background-service files. `--print` is a dry run that works on any CI; the generated LaunchAgent and
 * systemd unit carry this Node, Restart=always / KeepAlive, and survive awkward paths; a stale Node path is reported.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVER_ENTRY,
  launchAgentPlist,
  macPrivacyWarning,
  macProtectedFolder,
  serviceEnvironment,
  serviceNodePath,
  staleNodeWarning,
  systemdUnit,
  type ServiceSpec,
} from '../service.ts';

let tmp: string;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-service-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const serverDir = path.resolve(import.meta.dirname, '../..');

test('node src/service.ts --print exits 0 and prints a unit with this Node and Restart=always (Linux)', () => {
  const r = spawnSync(process.execPath, ['src/service.ts', '--print', '--platform=linux'], {
    cwd: serverDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: tmp, XDG_CONFIG_HOME: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(process.execPath), 'ExecStart uses process.execPath');
  assert.match(r.stdout, /^Restart=always$/m);
  assert.ok(r.stdout.includes(SERVER_ENTRY));
  assert.match(r.stdout, /^Environment="TZ=Europe\/London"$/m);
  assert.match(r.stdout, /^Environment="NODE_ENV=production"$/m);
  assert.ok(r.stdout.includes(path.join(tmp, '.config', 'systemd', 'user', 'linear-hub.service')), 'unit path under ~/.config');
});

test('--print --platform=darwin prints the LaunchAgent without touching launchctl', () => {
  const r = spawnSync(process.execPath, ['src/service.ts', 'install', '--print', '--platform=darwin'], {
    cwd: serverDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: tmp, PORT: '4310', HOST: '127.0.0.1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(path.join(tmp, 'Library', 'LaunchAgents', 'uk.co.linear-mcr.hub.plist')));
  assert.match(r.stdout, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(r.stdout, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(r.stdout, /<key>PORT<\/key>\s*<string>4310<\/string>/);
  assert.ok(r.stdout.includes(path.join(tmp, 'Library', 'Logs', 'LinearHub', 'linear-hub.log')));
  const bad = spawnSync(process.execPath, ['src/service.ts', 'install', '--platform=darwin'], { cwd: serverDir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: tmp } });
  assert.equal(bad.status, 1, '--platform without --print is refused');
});

test('environment: production, London, quiet, plus the Linear Hub settings with absolute paths', () => {
  const env = serviceEnvironment({ PORT: '4001', DB_PATH: 'data/live.sqlite', LM_BACKUP_DIR: '/Volumes/Backup/linear', LM_APP_SECRET: 'never-copied', HOME: '/x' });
  assert.deepEqual(env, {
    TZ: 'Europe/London',
    NODE_ENV: 'production',
    NODE_NO_WARNINGS: '1',
    PORT: '4001',
    DB_PATH: path.join(serverDir, 'data', 'live.sqlite'),
    LM_BACKUP_DIR: '/Volumes/Backup/linear',
  });
});

test('environment: LM_DEMO_ACCOUNTS=0 reaches the service (no demo buttons, no demo-account start-up steps)', () => {
  assert.equal(serviceEnvironment({ LM_DEMO_ACCOUNTS: '0', DB_PATH: '/var/lib/x.sqlite' }).LM_DEMO_ACCOUNTS, '0');
  assert.ok(!('LM_DEMO_ACCOUNTS' in serviceEnvironment({ DB_PATH: '/var/lib/x.sqlite' })), 'left out when not set');
});

test('environment: the 1.3 settings reach the service (statement reader off, statements and uploads folders, from server/)', () => {
  const env = serviceEnvironment({ LM_STATEMENTS_JOB: '0', LM_STATEMENTS_DIR: 'data/stmts', LM_UPLOADS_DIR: '/Volumes/Hub/uploads', COOKIE_SECURE: '1' });
  assert.equal(env.LM_STATEMENTS_JOB, '0', 'the Gmail reader stays off under the service');
  assert.equal(env.LM_STATEMENTS_DIR, path.join(serverDir, 'data', 'stmts'), 'resolved from server/ like DB_PATH');
  assert.equal(env.LM_UPLOADS_DIR, '/Volumes/Hub/uploads');
  assert.equal(env.COOKIE_SECURE, '1');
  const none = serviceEnvironment({});
  for (const key of ['LM_STATEMENTS_JOB', 'LM_STATEMENTS_DIR', 'LM_UPLOADS_DIR', 'COOKIE_SECURE']) assert.ok(!(key in none), `${key} left out when not set`);
});

test('--print --platform=darwin writes the statements and uploads settings into the LaunchAgent', () => {
  const r = spawnSync(process.execPath, ['src/service.ts', 'install', '--print', '--platform=darwin'], {
    cwd: serverDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: tmp, LM_STATEMENTS_JOB: '0', LM_STATEMENTS_DIR: '../x/stmts', LM_UPLOADS_DIR: '../x/upl' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<key>LM_STATEMENTS_JOB<\/key>\s*<string>0<\/string>/);
  assert.ok(r.stdout.includes(`<string>${path.resolve(serverDir, '../x/stmts')}</string>`), r.stdout);
  assert.ok(r.stdout.includes(`<string>${path.resolve(serverDir, '../x/upl')}</string>`), r.stdout);
});

test('awkward paths survive both formats, and the Node path reads back', () => {
  const spec: ServiceSpec = {
    node: '/Users/Ann O\'Neil/.nvm/versions/node/v22.18.0/bin/node',
    entry: '/Users/Ann O\'Neil/Linear "Hub" & co/100%/$HOME/server/src/index.ts',
    workDir: '/Users/Ann O\'Neil/Linear "Hub" & co/100%/$HOME/server',
    env: { TZ: 'Europe/London', DB_PATH: '/tmp/a b/100%.sqlite', LM_BACKUP_DIR: '/Users/Ann/Back$ups/$HOME "x" \\y' },
    log: '/Users/Ann O\'Neil/Library/Logs/LinearHub/linear-hub.log',
  };
  const plist = launchAgentPlist(spec);
  assert.ok(plist.includes('Linear &quot;Hub&quot; &amp; co'));
  assert.equal(serviceNodePath(plist), spec.node);
  const unit = systemdUnit(spec);
  const execStart = unit.split('\n').find((l) => l.startsWith('ExecStart='))!;
  assert.ok(execStart.includes('100%%/$$HOME'), 'ExecStart: specifiers and variables escaped');
  assert.ok(unit.includes('Environment="DB_PATH=/tmp/a b/100%%.sqlite"'));
  // Environment= expands no variables ("$" has no special meaning there), so a "$" is written as it is, once
  assert.ok(unit.includes('Environment="LM_BACKUP_DIR=/Users/Ann/Back$ups/$HOME \\"x\\" \\\\y"'), unit);
  assert.ok(!unit.split('\n').some((l) => l.startsWith('Environment=') && l.includes('$$')), 'no doubled $ in Environment=');
  assert.equal(serviceNodePath(unit), spec.node);
  assert.equal(serviceNodePath(systemdUnit({ ...spec, node: '/usr/bin/node' })), '/usr/bin/node');
});

test('Windows steps create the log folder before redirecting into it', () => {
  const r = spawnSync(process.execPath, ['src/service.ts', '--print', '--platform=win32'], { cwd: serverDir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').map((l) => l.trim());
  const mkdir = lines.findIndex((l) => l === 'if not exist "%LOCALAPPDATA%\\LinearHub" mkdir "%LOCALAPPDATA%\\LinearHub"');
  const node = lines.findIndex((l) => l.includes('>> "%LOCALAPPDATA%\\LinearHub\\linear-hub.log" 2>&1'));
  assert.ok(mkdir >= 0 && node > mkdir, r.stdout);
});

test('macOS: a checkout or backups folder in Desktop, Documents, Downloads or iCloud Drive is warned about', () => {
  const home = path.join(tmp, 'mac-home');
  const spec = (workDir: string, env: Record<string, string> = {}): ServiceSpec => ({ node: '/opt/homebrew/opt/node/bin/node', entry: path.join(workDir, 'src/index.ts'), workDir, env, log: '' });
  assert.equal(macProtectedFolder(path.join(home, 'Documents', 'linear-micro-crm', 'server'), home), path.join(home, 'Documents'));
  assert.equal(macProtectedFolder(path.join(home, 'documents', 'x'), home), path.join(home, 'Documents'), 'APFS ignores case');
  assert.equal(macProtectedFolder(path.join(home, 'Documents-old', 'x'), home), null);
  assert.equal(macProtectedFolder(path.join(home, 'LinearHub', 'server'), home), null);
  assert.equal(macPrivacyWarning(spec(path.join(home, 'LinearHub', 'server')), home), null);

  const docs = macPrivacyWarning(spec(path.join(home, 'Desktop', 'linear-micro-crm', 'server')), home) ?? '';
  assert.match(docs, /this Linear Hub folder is in ~\/Desktop/);
  assert.match(docs, /Full Disk Access/);
  const icloud = macPrivacyWarning(
    spec(path.join(home, 'LinearHub', 'server'), { LM_BACKUP_DIR: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Linear') }),
    home,
  );
  assert.match(icloud ?? '', /the backups folder \(LM_BACKUP_DIR\) is in ~\/Library\/Mobile Documents/);
  const moved = macPrivacyWarning(
    spec(path.join(home, 'LinearHub', 'server'), { LM_STATEMENTS_DIR: path.join(home, 'Documents', 'statements'), LM_UPLOADS_DIR: path.join(home, 'Desktop', 'uploads') }),
    home,
  );
  assert.match(moved ?? '', /the statements folder \(LM_STATEMENTS_DIR\) is in ~\/Documents/);
  assert.match(moved ?? '', /the uploads folder, the signature image \(LM_UPLOADS_DIR\) is in ~\/Desktop/);

  // a link from a harmless name into Documents still counts
  mkdirSync(path.join(home, 'Documents', 'real'), { recursive: true });
  symlinkSync(path.join(home, 'Documents', 'real'), path.join(home, 'hub-link'));
  assert.equal(macProtectedFolder(path.join(home, 'hub-link', 'server'), home), null, 'a path that does not exist yet is taken as written');
  assert.equal(macProtectedFolder(path.join(home, 'hub-link'), home), path.join(home, 'Documents'));
});

test('a service that runs another or a missing Node is reported', () => {
  const file = path.join(tmp, 'svc.plist');
  const spec: ServiceSpec = { node: process.execPath, entry: SERVER_ENTRY, workDir: serverDir, env: {}, log: '/tmp/x.log' };
  writeFileSync(file, launchAgentPlist(spec));
  assert.equal(staleNodeWarning(file), null);
  writeFileSync(file, launchAgentPlist({ ...spec, node: path.join(tmp, 'gone', 'node') }));
  assert.match(staleNodeWarning(file) ?? '', /no longer exists.*npm run service:install/);
  const other = path.join(tmp, 'other-node');
  writeFileSync(other, '');
  writeFileSync(file, systemdUnit({ ...spec, node: other }));
  assert.match(staleNodeWarning(file) ?? '', /this terminal uses/);
  assert.equal(staleNodeWarning(null), null);
});
