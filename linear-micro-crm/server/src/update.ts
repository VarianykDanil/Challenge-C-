/**
 * `npm run latest`: bring this checkout up to date and start it, in one command. (Not `npm update`: that is npm's own
 * command, which upgrades packages and rewrites package-lock.json.)
 *
 * 1. Refuse if you have edited tracked files (other than package-lock.json): your work is never thrown away.
 * 2. Discard local changes to package-lock.json: npm rewrites that file on install; the pulled one replaces it.
 * 3. Stop Linear Hub: the background service when it is installed (so nothing runs while node_modules is reinstalled),
 *    otherwise the copy running in a terminal.
 * 4. Back the database up and check the backup (with the uploaded files), before anything can change the database.
 *    No good backup, no update: the service is started again as it was.
 * 5. git pull --ff-only, and list what came in.
 * 6. npm ci when the dependencies changed, npm run build when the screens changed (npm run setup, prepare.ts).
 * 7. Start: install the background service again (it starts the new version), otherwise run npm start here. The new
 *    version upgrades the database at its first start, in one transaction.
 * If a step fails after the stop, the service is started again and the way back is printed.
 *
 * `npm run latest -- --no-start` stops after step 6.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { backupAndVerify, backupDirFor, foldersOutsideBackup } from './lib/backup.ts';
import { backupVideos } from './lib/backupFiles.ts';
import { installedServiceFile, startInstalledService, stopInstalledService } from './service.ts';

const repoDir = path.resolve(import.meta.dirname, '..', '..'); // linear-micro-crm/
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const noStart = process.argv.includes('--no-start');
const LOCKFILE = 'package-lock.json';

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  // trim only the end: `git status --porcelain` lines start with a significant space (" M file")
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\s+$/, '') };
}

function npmRun(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const r = spawnSync(npm, args, { cwd: repoDir, stdio: 'inherit', env, shell: process.platform === 'win32' });
  return r.status ?? 1;
}

/** Set once the background service was stopped, so a failure starts it again. */
let serviceStopped = false;

function fail(message: string): never {
  console.error(`\nLinear Hub: npm run latest stopped. ${message}`);
  if (serviceStopped) {
    console.error(startInstalledService() ? 'Linear Hub: the background service was started again as it was.' : 'Linear Hub: start it again with  npm run service:install');
  }
  process.exit(1);
}

if (!git(['rev-parse', '--is-inside-work-tree']).ok) fail('This folder is not a git checkout, so there is nothing to pull.');

// 1-2. Local changes: the lockfile is npm's, everything else is yours.
const status = git(['status', '--porcelain', '--', '.']);
const changed = status.out
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('??'))
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
const lockfilePaths = new Set([LOCKFILE, `linear-micro-crm/${LOCKFILE}`]);
const yours = changed.filter((f) => !lockfilePaths.has(f) && !f.endsWith(`/${LOCKFILE}`));
if (yours.length) {
  fail(
    `You have changed ${yours.length === 1 ? 'a file' : `${yours.length} files`} here:\n${yours.map((f) => `  ${f}`).join('\n')}\n` +
      'Keep them with  git stash  (bring them back later with  git stash pop), or discard them with  git restore <file>,\n' +
      'then run  npm run latest  again.',
  );
}
if (changed.length) {
  git(['restore', '--staged', '--worktree', '--', LOCKFILE]);
  console.log(`Linear Hub: discarded npm's local changes to ${LOCKFILE} (the pulled version replaces them).`);
}

// 3. Stop Linear Hub: the background service too, so it never serves while node_modules is being reinstalled.
const service = installedServiceFile();
if (service) {
  console.log('Linear Hub: stopping the background service for the update…');
  if (!(await stopInstalledService())) fail('The background service did not stop (see npm run service:status). Nothing was changed.');
  serviceStopped = true;
} else {
  const stop = npmRun(['run', '--silent', 'stop']);
  if (stop !== 0) console.log('Linear Hub: could not stop what is on the port (see above); carrying on with the update.');
}

// 4. A checked backup before anything can change the database (the new version upgrades it at its first start).
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
let backupFile: string | null = null;
if (existsSync(dbPath)) {
  try {
    const secretFile = process.env.LM_APP_SECRET ? null : process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
    const { result, summary } = await backupAndVerify(dbPath, {
      dir: backupDirFor(dbPath),
      secretFile,
      files: { folders: foldersOutsideBackup(dbPath), includeVideos: backupVideos() },
    });
    backupFile = result.path;
    console.log(`Linear Hub: backed up and checked the database before the update: ${result.path} (${summary.users} people, ${summary.payrollRuns} pay runs).`);
  } catch (err) {
    fail(`No update without a good backup: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 5. Pull.
const before = git(['rev-parse', 'HEAD']).out;
console.log('Linear Hub: pulling the latest version…');
const pull = git(['pull', '--ff-only']);
if (!pull.ok) {
  fail(
    `The pull did not complete:\n${pull.out.replace(/^/gm, '  ')}\n` +
      'If it says the branches have diverged, someone committed on this machine: ask for help before forcing anything.',
  );
}
const after = git(['rev-parse', 'HEAD']).out;
if (before === after) {
  console.log('Linear Hub: already up to date.');
} else {
  const log = git(['log', '--oneline', '--no-decorate', `${before}..${after}`]).out.split('\n').filter(Boolean);
  console.log(`Linear Hub: pulled ${log.length === 1 ? '1 change' : `${log.length} changes`}:`);
  for (const line of log.slice(0, 15)) console.log(`  ${line}`);
  if (log.length > 15) console.log(`  … and ${log.length - 15} more`);
}

// 6. Dependencies and screens (the same step npm start runs first).
const wayBack = () =>
  `To go back: git checkout ${before.slice(0, 12)} && npm run setup${backupFile ? ` && npm run restore -- ${path.basename(backupFile)}` : ''}`;
if (npmRun(['run', '--silent', 'setup']) !== 0) fail(`The install or build failed (see above). ${wayBack()}`);

if (backupFile) console.log(`Linear Hub: if the new version is not right: ${wayBack()}`);
if (noStart) {
  console.log(`\nLinear Hub: updated. Start it with  ${service ? 'npm run service:install' : 'npm start'}`);
  process.exit(0);
}

// 7. Start.
if (service) {
  console.log('Linear Hub: starting the background service with the new version…');
  const code = npmRun(['run', 'service:install']);
  if (code !== 0) fail('The background service did not start with the new version (see above).');
  process.exit(0);
}
console.log('Linear Hub: starting. Press Ctrl+C to stop.\n');
process.exit(npmRun(['start'], { ...process.env, LM_SKIP_PREPARE: '1' }));
