/**
 * p10: the background-service files. `--print` is a dry run that works on any CI; the generated LaunchAgent and
 * systemd unit carry this Node, Restart=always / KeepAlive, and survive awkward paths; a stale Node path is reported.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVER_ENTRY,
  launchAgentPlist,
  macPrivacyWarning,
  macProtectedFolder,
  readServiceSettings,
  serviceEnvironment,
  serviceNodePath,
  serviceSecretPlan,
  serviceSpec,
  staleNodeWarning,
  systemdUnit,
  withInstalledSettings,
  writeServiceSecret,
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

// SEC-7 / SECURITY-MISSED-3: the always-on install used to refuse LM_APP_SECRET, so every backup held the key file.
// Now the key travels through a private file outside the data folder; the unit and the LaunchAgent never hold it.
test('LM_APP_SECRET reaches the service through a private file outside the data folder, never through the service file', () => {
  const secret = 'Zm9vYmFyLWtleS1mb3ItdGVzdHMtb25seQ==';
  const r = spawnSync(process.execPath, ['src/service.ts', '--print', '--platform=linux'], {
    cwd: serverDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: tmp, XDG_CONFIG_HOME: '', LM_APP_SECRET: secret },
  });
  assert.equal(r.status, 0, r.stderr);
  const envFile = path.join(tmp, '.config', 'linear-hub', 'linear-hub.env');
  assert.match(r.stdout, new RegExp(`^EnvironmentFile=${envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(r.stdout, /^RestartPreventExitStatus=78$/m, 'a missing or wrong key is not restarted in a loop');
  assert.equal(r.stdout.includes(secret), false, 'the key is not printed or put in the unit');
  assert.match(r.stdout, /would write .*linear-hub\.env \(mode 600\)/);

  const linux = serviceSecretPlan({ LM_APP_SECRET: secret, HOME: tmp }, 'linux', tmp)!;
  assert.equal(linux.file, envFile);
  assert.match(linux.content, new RegExp(`^LM_APP_SECRET=${secret.replace(/[+/=]/g, '\\$&')}$`, 'm'));
  assert.deepEqual(linux.env, {});
  assert.throws(() => serviceSecretPlan({ LM_APP_SECRET: 'has a "quote" $HOME' }, 'linux', tmp), /LM_APP_SECRET_FILE/);
  assert.throws(() => serviceSecretPlan({ LM_APP_SECRET: ' padded ' }, 'linux', tmp), /space/);
  assert.equal(serviceSecretPlan({}, 'linux', tmp), null);

  const mac = serviceSecretPlan({ LM_APP_SECRET: secret, DB_PATH: 'data/live.sqlite' }, 'darwin', tmp)!;
  assert.equal(mac.file, path.join(tmp, 'Library', 'Application Support', 'LinearHub', 'app-secret'));
  assert.equal(mac.content, `${secret}\n`);
  assert.equal(mac.env.LM_APP_SECRET_FILE, mac.file);
  assert.equal(mac.env.LM_UPLOADS_DIR, path.join(serverDir, 'data', 'uploads'), 'the uploads stay where they are');
  const plist = launchAgentPlist({ node: process.execPath, entry: SERVER_ENTRY, workDir: serverDir, env: { ...serviceEnvironment({ LM_APP_SECRET: secret }), ...mac.env }, log: '/tmp/x.log' });
  assert.equal(plist.includes(secret), false);
  assert.ok(plist.includes(mac.file));
});

test('the private key file is mode 600, and a different one already there is kept, never overwritten', () => {
  const plan = serviceSecretPlan({ LM_APP_SECRET: 'first-key-0123456789' }, 'linux', path.join(tmp, 'home-a'))!;
  assert.equal(writeServiceSecret(plan), null);
  if (process.platform !== 'win32') {
    assert.equal(statSync(plan.file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(plan.file)).mode & 0o777, 0o700);
  }
  assert.equal(writeServiceSecret(plan), null, 'the same content: nothing to do');
  const next = serviceSecretPlan({ LM_APP_SECRET: 'second-key-0123456789' }, 'linux', path.join(tmp, 'home-a'))!;
  const kept = writeServiceSecret(next, new Date('2026-10-27T12:00:00Z'));
  assert.ok(kept && readFileSync(kept, 'utf8').includes('first-key-0123456789'));
  assert.ok(readFileSync(next.file, 'utf8').includes('second-key-0123456789'));
});

// Review of SECURITY-MISSED-3 / REL-3: `npm run latest` restarts the service with `npm run service:install`, usually
// from a plain terminal. The rebuilt unit or LaunchAgent must keep what the installed one had: the key hand-over and
// the off-site settings, or the service loses its key (exit 78) and off-site copies stop without a word.
const SECRET = 'Zm9vYmFyLWtleS1mb3ItdGVzdHMtb25seQ==';
const plainEnv = (home: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: '', NODE_NO_WARNINGS: '1' });
const printed = (stdout: string, file: string) => {
  const start = stdout.indexOf(`# ${file}\n`);
  const end = stdout.indexOf('\n# then:', start);
  assert.ok(start >= 0 && end > start, stdout);
  return stdout.slice(start + file.length + 3, end + 1);
};
const printService = (platform: string, env: NodeJS.ProcessEnv, ...extra: string[]) =>
  spawnSync(process.execPath, ['src/service.ts', 'install', '--print', `--platform=${platform}`, ...extra], { cwd: serverDir, encoding: 'utf8', env });

test('Linux: a rebuild from a plain terminal keeps the installed unit\'s key file and off-site settings', () => {
  const home = path.join(tmp, 'home-keep-linux');
  mkdirSync(home, { recursive: true });
  const first = printService('linux', {
    ...plainEnv(home),
    LM_APP_SECRET: SECRET,
    LM_OFFSITE_DIR: '/srv/offsite/linear',
    LM_BACKUP_PASSPHRASE_FILE: '/home/hub/.linear-passphrase',
    PORT: '4321',
    DB_PATH: '/var/lib/linear-hub/linear.sqlite',
  });
  assert.equal(first.status, 0, first.stderr);
  const unitPath = path.join(home, '.config', 'systemd', 'user', 'linear-hub.service');
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, printed(first.stdout, unitPath));
  writeServiceSecret(serviceSecretPlan({ LM_APP_SECRET: SECRET }, 'linux', home)!);
  const envFile = path.join(home, '.config', 'linear-hub', 'linear-hub.env');

  const again = printService('linux', plainEnv(home));
  assert.equal(again.status, 0, again.stderr);
  const unit = printed(again.stdout, unitPath);
  assert.ok(unit.includes(`EnvironmentFile=${envFile}\n`), unit);
  assert.ok(unit.includes('Environment="LM_OFFSITE_DIR=/srv/offsite/linear"'), unit);
  assert.ok(unit.includes('Environment="LM_BACKUP_PASSPHRASE_FILE=/home/hub/.linear-passphrase"'), unit);
  assert.ok(unit.includes('Environment="PORT=4321"'), unit);
  assert.ok(unit.includes('Environment="DB_PATH=/var/lib/linear-hub/linear.sqlite"'), unit);
  assert.match(again.stdout, /Kept from the service installed before.*PORT.*DB_PATH.*LM_OFFSITE_DIR.*LM_BACKUP_PASSPHRASE_FILE.*app key/s);
  assert.equal(again.stdout.includes(SECRET), false, 'the key is never printed');

  // a setting typed in this terminal wins over the installed one
  const port = printService('linux', { ...plainEnv(home), PORT: '5000' });
  assert.ok(printed(port.stdout, unitPath).includes('Environment="PORT=5000"'), port.stdout);

  // --fresh starts from this terminal only, and says the key file is no longer used
  const fresh = printService('linux', plainEnv(home), '--fresh');
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshUnit = printed(fresh.stdout, unitPath);
  assert.equal(freshUnit.includes('EnvironmentFile='), false, freshUnit);
  assert.equal(freshUnit.includes('LM_OFFSITE_DIR'), false, freshUnit);
  assert.match(fresh.stdout, /--fresh.*linear-hub\.env.*not used/s);
});

test('macOS: a rebuild from a plain terminal keeps the LaunchAgent\'s key file, uploads folder and off-site settings', () => {
  const home = path.join(tmp, 'home-keep-mac');
  mkdirSync(home, { recursive: true });
  const first = printService('darwin', { ...plainEnv(home), LM_APP_SECRET: SECRET, LM_OFFSITE_DIR: '/Volumes/Cloud/linear', LM_BACKUP_PASSPHRASE_FILE: '/Users/hub/.linear-passphrase' });
  assert.equal(first.status, 0, first.stderr);
  const plistPath = path.join(home, 'Library', 'LaunchAgents', 'uk.co.linear-mcr.hub.plist');
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, printed(first.stdout, plistPath));
  const keyFile = path.join(home, 'Library', 'Application Support', 'LinearHub', 'app-secret');
  writeServiceSecret(serviceSecretPlan({ LM_APP_SECRET: SECRET }, 'darwin', home)!);

  const again = printService('darwin', plainEnv(home));
  assert.equal(again.status, 0, again.stderr);
  const plist = printed(again.stdout, plistPath);
  assert.match(plist, new RegExp(`<key>LM_APP_SECRET_FILE</key>\\s*<string>${keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.match(plist, new RegExp(`<key>LM_UPLOADS_DIR</key>\\s*<string>${path.join(serverDir, 'data', 'uploads').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.match(plist, /<key>LM_OFFSITE_DIR<\/key>\s*<string>\/Volumes\/Cloud\/linear<\/string>/);
  assert.match(plist, /<key>LM_BACKUP_PASSPHRASE_FILE<\/key>\s*<string>\/Users\/hub\/\.linear-passphrase<\/string>/);
  assert.match(again.stdout, /Kept from the service installed before.*LM_APP_SECRET_FILE.*LM_UPLOADS_DIR.*LM_OFFSITE_DIR/s);
});

test('the installed settings read back exactly, awkward values included, from both formats', () => {
  const spec: ServiceSpec = {
    node: process.execPath,
    entry: SERVER_ENTRY,
    workDir: serverDir,
    env: { TZ: 'Europe/London', PORT: '4001', LM_OFFSITE_DIR: '/Volumes/Back$ups/100% "x" \\y & <z>', DB_PATH: "/Users/Ann O'Neil/data/linear.sqlite" },
    log: '/tmp/x.log',
    environmentFile: '/home/ann/.config/linear-hub/100%/linear-hub.env',
  };
  const unit = readServiceSettings(systemdUnit(spec));
  assert.deepEqual(unit.env, spec.env);
  assert.equal(unit.environmentFile, spec.environmentFile);
  const plist = readServiceSettings(launchAgentPlist(spec));
  assert.deepEqual(plist.env, spec.env);
  assert.equal(plist.environmentFile, null);
});

test('the key file kept for the service is used when nothing else names a key, even with no service installed', () => {
  const home = path.join(tmp, 'home-fallback');
  writeServiceSecret(serviceSecretPlan({ LM_APP_SECRET: SECRET }, 'linux', home)!);
  const envFile = path.join(home, '.config', 'linear-hub', 'linear-hub.env');
  const spec = serviceSpec('linux', { env: {}, home, installed: null });
  assert.equal(spec.environmentFile, envFile);
  assert.ok(spec.kept.some((k) => k.includes(envFile)));
  const named = serviceSpec('linux', { env: { LM_APP_SECRET_FILE: '/srv/key' }, home, installed: null });
  assert.equal(named.environmentFile, null, 'a key file named in this terminal is the one used');

  const mac = path.join(tmp, 'home-fallback-mac');
  writeServiceSecret(serviceSecretPlan({ LM_APP_SECRET: SECRET }, 'darwin', mac)!);
  const macSpec = serviceSpec('darwin', { env: {}, home: mac, installed: null });
  assert.equal(macSpec.env.LM_APP_SECRET_FILE, path.join(mac, 'Library', 'Application Support', 'LinearHub', 'app-secret'));
  assert.equal(macSpec.env.LM_UPLOADS_DIR, path.join(serverDir, 'data', 'uploads'));
});

test('npm run latest takes the service\'s own settings for anything the terminal leaves unset', () => {
  const installed = { env: { PORT: '4321', DB_PATH: '/var/lib/linear-hub/linear.sqlite', LM_OFFSITE_DIR: '/srv/off' }, environmentFile: '/x/linear-hub.env' };
  const env = withInstalledSettings({ PORT: '5000', HOME: '/h' }, installed);
  assert.equal(env.PORT, '5000');
  assert.equal(env.DB_PATH, '/var/lib/linear-hub/linear.sqlite');
  assert.equal(env.LM_OFFSITE_DIR, '/srv/off');
  assert.equal(env.HOME, '/h');
  assert.deepEqual(withInstalledSettings({ A: '1' }, null), { A: '1' });
});
