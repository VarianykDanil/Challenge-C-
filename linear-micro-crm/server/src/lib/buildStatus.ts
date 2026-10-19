/**
 * Is this checkout ready to serve: are the dependencies installed for the current lockfile, and is the built client
 * (client/dist) newer than every file it is built from?
 *
 * Why: after `git pull` the server code is new straight away (it runs from source), but the screens come from the
 * last `npm run build`. Forgetting the build serves yesterday's screens with today's API, which looks like "the new
 * features are missing". `npm start` (via server/src/prepare.ts) and the server's start-up warning both use this.
 *
 * Only node:fs and node:path here: prepare.ts runs it before dependencies may be installed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';

export interface NewestFile {
  /** Path relative to the repository folder (linear-micro-crm/). */
  file: string;
  mtimeMs: number;
}

export interface ClientBuildStatus {
  built: boolean;
  builtAtMs: number | null;
  /** The newest file the client is built from. */
  newest: NewestFile | null;
  /** True when there is no build, or a source file changed after it. */
  stale: boolean;
}

export interface DepsStatus {
  installed: boolean;
  /** True when node_modules is missing, or package-lock.json changed after the last install. */
  stale: boolean;
}

/** What `npm run build` (client) reads: its sources, the shared package it imports, and its config. */
const SOURCE_DIRS = ['client/src', 'client/public', 'shared/src'];
const SOURCE_FILES = [
  'client/index.html',
  'client/vite.config.ts',
  'client/tsconfig.json',
  'client/package.json',
  'shared/package.json',
  // written by every npm install / npm ci: the installed packages changed (not merely the lockfile's timestamp)
  'node_modules/.package-lock.json',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function newestIn(dir: string, root: string, best: NewestFile | null): NewestFile | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return best;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) best = newestIn(full, root, best);
    } else if (e.isFile()) {
      const m = mtimeOf(full);
      if (m !== null && (!best || m > best.mtimeMs)) best = { file: path.relative(root, full), mtimeMs: m };
    }
  }
  return best;
}

/** The newest client source file under `repoDir` (the linear-micro-crm folder). */
export function newestClientSource(repoDir: string): NewestFile | null {
  let best: NewestFile | null = null;
  for (const d of SOURCE_DIRS) best = newestIn(path.join(repoDir, d), repoDir, best);
  for (const f of SOURCE_FILES) {
    const m = mtimeOf(path.join(repoDir, f));
    if (m !== null && (!best || m > best.mtimeMs)) best = { file: f, mtimeMs: m };
  }
  return best;
}

/** Slack for file systems with coarse timestamps and for a build that ends in the same second as an edit. */
const SLACK_MS = 1000;

export function clientBuildStatus(repoDir: string): ClientBuildStatus {
  const builtAtMs = mtimeOf(path.join(repoDir, 'client', 'dist', 'index.html'));
  const newest = newestClientSource(repoDir);
  const built = builtAtMs !== null;
  const stale = !built || (newest !== null && newest.mtimeMs > builtAtMs + SLACK_MS);
  return { built, builtAtMs, newest, stale };
}

/** Fingerprint of package-lock.json recorded after `npm run setup` installs, so a reset or re-checkout of an identical
 * lockfile (new timestamp, same content) does not reinstall. */
const LOCK_MARKER = path.join('node_modules', '.linear-hub-lockfile.sha256');

function lockfileHash(repoDir: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path.join(repoDir, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
}

/** Record that node_modules now matches the current package-lock.json (after a successful install). */
export function recordInstalledLockfile(repoDir: string): void {
  const hash = lockfileHash(repoDir);
  if (!hash) return;
  try {
    writeFileSync(path.join(repoDir, LOCK_MARKER), `${hash}\n`);
  } catch {
    // node_modules not writable: the timestamp rule below still applies next time
  }
}

export function depsStatus(repoDir: string): DepsStatus {
  // npm writes node_modules/.package-lock.json at the end of every install
  const installedAt = mtimeOf(path.join(repoDir, 'node_modules', '.package-lock.json'));
  const installed = installedAt !== null && existsSync(path.join(repoDir, 'node_modules'));
  if (!installed) return { installed, stale: true };
  let recorded: string | null = null;
  try {
    recorded = readFileSync(path.join(repoDir, LOCK_MARKER), 'utf8').trim();
  } catch {
    recorded = null;
  }
  if (recorded) return { installed, stale: recorded !== lockfileHash(repoDir) };
  // no fingerprint yet (installed by hand): fall back to timestamps
  const lockAt = mtimeOf(path.join(repoDir, 'package-lock.json'));
  return { installed, stale: lockAt !== null && lockAt > installedAt + SLACK_MS };
}

/** "3 Oct 14:05" in the business zone, for messages. */
export function shortStamp(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

/** One sentence for the start-up warning and the doctor, or null when the build is current. */
export function staleBuildMessage(s: ClientBuildStatus): string | null {
  if (!s.stale) return null;
  if (!s.built) return 'The app\'s screens have not been built yet (client/dist is missing), so the browser gets no pages. Run  npm run build, or start with  npm start, which builds when needed.';
  const changed = s.newest ? `${s.newest.file} changed ${shortStamp(s.newest.mtimeMs)}` : 'the code changed';
  return `The app's screens are out of date: they were built ${shortStamp(s.builtAtMs!)}, but ${changed}, so new screens and fixes will not show. Run  npm run build  and restart, or start with  npm start, which builds when needed.`;
}
