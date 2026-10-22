/**
 * `npm run setup`, and automatically before `npm start` (the root "prestart" script): make sure the checkout is ready
 * to serve, so a `git pull` followed by `npm start` always shows the new screens.
 *
 * 1. Dependencies: when node_modules is missing or package-lock.json changed since the last install, run npm ci
 *    (installs exactly the lockfile and never rewrites it, so the next git pull is never blocked by it).
 * 2. Screens: when client/dist is missing or older than any file it is built from, run npm run build.
 *
 * Each step says what it is doing and why. LM_SKIP_PREPARE=1 skips both (for setups that build elsewhere).
 * `--deps-only` runs step 1 alone: the root "prebuild" script, so `git pull` then `npm run build` installs new
 * dependencies first instead of failing with "Cannot find module" (1.3 added jspdf for the PDF downloads).
 * Only Node built-ins are imported: this must work before the dependencies are installed.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { clientBuildStatus, depsStatus, lockfileInstalled, recordInstalledLockfile, shortStamp } from './lib/buildStatus.ts';

const repoDir = path.resolve(import.meta.dirname, '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args: string[], what: string): void {
  const started = performance.now();
  const r = spawnSync(npm, args, { cwd: repoDir, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, LM_SKIP_PREPARE: '1' } });
  if (r.status !== 0) {
    console.error(`\nLinear Hub: ${what} failed (exit ${r.status ?? r.signal}). Fix the error above, then run  npm start  again.`);
    process.exit(r.status || 1);
  }
  console.log(`Linear Hub: ${what} done in ${Math.round((performance.now() - started) / 1000)} s.\n`);
}

if (process.env.LM_SKIP_PREPARE === '1') process.exit(0);

const depsOnly = process.argv.includes('--deps-only');
const deps = depsStatus(repoDir);
// Before a build every package must be there (the build needs the client's and the dev packages too), so check the
// installed packages against the lockfile itself, not only the record of the last install.
if (depsOnly && deps.installed && !deps.stale && !lockfileInstalled(repoDir)) deps.stale = true;
if (deps.stale) {
  console.log(
    deps.installed
      ? 'Linear Hub: the dependencies changed since the last install (package-lock.json is newer) — running npm ci first.'
      : 'Linear Hub: dependencies are not installed yet — running npm ci first.',
  );
  run(['ci', '--no-audit', '--no-fund'], 'npm ci');
  recordInstalledLockfile(repoDir);
} else if (deps.installed && lockfileInstalled(repoDir, { includeDev: process.env.NODE_ENV !== 'production' })) {
  recordInstalledLockfile(repoDir); // first run after an install by hand: start fingerprinting (only when it matches)
}

if (depsOnly) process.exit(0);

const build = clientBuildStatus(repoDir);
if (build.stale) {
  console.log(
    build.built
      ? `Linear Hub: the app's screens changed since the last build (${build.newest?.file} is newer than the build from ${shortStamp(build.builtAtMs!)}) — building them now, about 10–20 s.`
      : "Linear Hub: the app's screens have not been built yet — building them now, about 10–20 s.",
  );
  run(['run', 'build'], 'Build');
}
