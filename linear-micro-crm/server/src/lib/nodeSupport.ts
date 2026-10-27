/**
 * Which Node versions Linear Hub supports, and what `npm run doctor` and the server's start say about the one in use.
 *
 * The data layer is Node's built-in node:sqlite (no native add-on to compile, the same SQLite on every machine). Node
 * still labels it "experimental", so Linear Hub supports only the long-term-support lines it is tested on and the
 * version range is pinned in package.json "engines" (kept equal to NODE_ENGINES; a test checks it). Everything reaches
 * the database through db/connection.ts and lib/backup.ts, so a change in node:sqlite's API is a change in two files.
 */
import { spawnSync } from 'node:child_process';

/** The oldest supported Node: type stripping on by default, node:sqlite with backup() and isTransaction. */
export const NODE_MINIMUM = '22.18.0';
/** The long-term-support lines Linear Hub is tested on. */
export const NODE_MAJORS = [22, 24, 26] as const;
/** package.json "engines".node, in the root and in server/. */
export const NODE_ENGINES = '^22.18.0 || ^24.0.0 || ^26.0.0';

export interface NodeSupport {
  /** 'ok' supported; 'warn' runs but is not a tested line; 'fail' too old to run Linear Hub. */
  status: 'ok' | 'warn' | 'fail';
  message: string | null;
}

const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0) as [number, number, number];

/** What to say about a Node version. */
export function nodeSupport(version: string = process.versions.node): NodeSupport {
  const [major, minor, patch] = parse(version);
  const [minMajor, minMinor, minPatch] = parse(NODE_MINIMUM);
  const tooOld = major < minMajor || (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)));
  if (tooOld) {
    return { status: 'fail', message: `Node ${version} is too old: Linear Hub needs Node ${NODE_MINIMUM} or newer. Install Node 22 or 24 LTS from https://nodejs.org.` };
  }
  if (!(NODE_MAJORS as readonly number[]).includes(major)) {
    const why = major > NODE_MAJORS.at(-1)! ? 'newer than the versions Linear Hub is tested on' : 'not a long-term-support version';
    return {
      status: 'warn',
      message:
        `Node ${version} is ${why} (supported: Node ${NODE_MAJORS.join(', ')}). The database uses node:sqlite, which Node still marks ` +
        'experimental, so an untested Node may change how it behaves. Install Node 22 or 24 LTS from https://nodejs.org, then run npm run service:install again if the background service is installed.',
    };
  }
  return { status: 'ok', message: null };
}

/** One line at start-up when the Node in use is not a supported one (the server still starts). */
export function warnIfUnsupportedNode(version: string = process.versions.node, warn: (line: string) => void = console.warn): void {
  const s = nodeSupport(version);
  if (s.status !== 'ok' && s.message) warn(`▲ ${s.message}`);
}

export interface SqliteStatus {
  available: boolean;
  /** True when this Node prints "SQLite is an experimental feature" (the npm scripts hide that warning). */
  experimental: boolean;
  /** The SQLite library version inside Node, when it could be read. */
  sqliteVersion: string | null;
  error: string | null;
}

/** Loads node:sqlite in a separate Node, with warnings on, to see what this Node says about it. */
export function sqliteStatus(execPath: string = process.execPath): SqliteStatus {
  const env = { ...process.env };
  delete env.NODE_NO_WARNINGS;
  delete env.NODE_OPTIONS;
  const r = spawnSync(
    execPath,
    ['-e', "const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(':memory:'); console.log(d.prepare('select sqlite_version() AS v').get().v); d.close();"],
    { encoding: 'utf8', env, timeout: 10_000 },
  );
  if (r.status !== 0) return { available: false, experimental: false, sqliteVersion: null, error: (r.stderr || String(r.error ?? 'failed')).trim().split('\n')[0] ?? null };
  return {
    available: true,
    experimental: /ExperimentalWarning:.*SQLite/i.test(r.stderr ?? ''),
    sqliteVersion: (r.stdout ?? '').trim() || null,
    error: null,
  };
}
