/**
 * `npm run latest`: bring this checkout up to date and start it, in one command. (Not `npm update`: that is npm's own
 * command, which upgrades packages and rewrites package-lock.json.)
 *
 * 1. Refuse if you have edited tracked files (other than package-lock.json): your work is never thrown away.
 * 2. Discard local changes to package-lock.json: npm rewrites that file on install; the pulled one replaces it.
 * 3. Stop the copy running in a terminal (the background service, if installed, is restarted at the end instead).
 * 4. git pull --ff-only, and list what came in.
 * 5. npm ci when the dependencies changed, npm run build when the screens changed (npm run setup, prepare.ts).
 * 6. Start: reload the background service if it is installed, otherwise run npm start here (Ctrl+C stops it).
 *
 * `npm run latest -- --no-start` stops after step 5.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { installedServiceFile } from './service.ts';

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

function fail(message: string): never {
  console.error(`\nLinear Hub: npm run latest stopped. ${message}`);
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

// 3. Stop a copy running in a terminal; the background service is restarted at the end instead.
const service = installedServiceFile();
if (!service) {
  const stop = npmRun(['run', '--silent', 'stop']);
  if (stop !== 0) console.log('Linear Hub: could not stop what is on the port (see above); carrying on with the update.');
}

// 4. Pull.
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

// 5. Dependencies and screens (the same step npm start runs first).
if (npmRun(['run', '--silent', 'setup']) !== 0) fail('The install or build failed (see above).');

if (noStart) {
  console.log('\nLinear Hub: updated. Start it with  npm start');
  process.exit(0);
}

// 6. Start.
if (service) {
  console.log('Linear Hub: restarting the background service with the new version…');
  process.exit(npmRun(['run', 'service:install']));
}
console.log('Linear Hub: starting. Press Ctrl+C to stop.\n');
process.exit(npmRun(['start'], { ...process.env, LM_SKIP_PREPARE: '1' }));
