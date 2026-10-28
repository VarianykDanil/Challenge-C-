/**
 * Server errors, kept where someone will see them.
 *
 * Every unexpected error (a 500 answer, a failed backup or off-site copy, a failed background job) is written to
 * `<data dir>/logs/errors.log` as well as the terminal or service log, with the time, what was happening, the request
 * (method and path, never the query string or body) and the signed-in person's id. The file is rotated by size
 * (1 MB, five old files kept: errors.1.log … errors.5.log). The Needs-attention bell counts the errors of the last
 * 24 hours (`serverErrorsSince`), counting the ones already in the file when the server starts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const ERROR_LOG = {
  maxBytes: 1024 * 1024,
  keep: 5,
} as const;

let logFile: string | null = null;
/** Times (ms) of recent errors, oldest first; at most 5,000 (older ones are not needed for a 24-hour count). */
const recent: number[] = [];
const MAX_RECENT = 5000;

/** Where errors go: `<dataDir>/logs/errors.log` (null: only the terminal, as in tests). Reads the existing file's times. */
export function configureErrorLog(dataDir: string | null, now: Date = new Date()): void {
  logFile = dataDir ? path.join(dataDir, 'logs', 'errors.log') : null;
  recent.length = 0;
  if (!logFile || !existsSync(logFile)) return;
  try {
    const since = now.getTime() - 24 * 3_600_000;
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /.exec(line);
      if (!m) continue;
      const t = Date.parse(m[1]!);
      if (t >= since) recent.push(t);
    }
  } catch {
    // an unreadable log is not a reason to stop
  }
}

export function errorLogFile(): string | null {
  return logFile;
}

function rotateIfLarge(file: string): void {
  try {
    if (statSync(file).size < ERROR_LOG.maxBytes) return;
  } catch {
    return;
  }
  const numbered = (i: number) => file.replace(/\.log$/, `.${i}.log`);
  rmSync(numbered(ERROR_LOG.keep), { force: true });
  for (let i = ERROR_LOG.keep - 1; i >= 1; i--) {
    if (existsSync(numbered(i))) renameSync(numbered(i), numbered(i + 1));
  }
  renameSync(file, numbered(1));
}

export interface ErrorContext {
  method?: string;
  /** The path only: a query string can hold things that must not be logged. */
  path?: string;
  userId?: number | null;
}

/** Writes an error to the terminal and the error log, and counts it. Never throws. */
export function logServerError(what: string, err: unknown, ctx: ErrorContext = {}, now: Date = new Date()): void {
  console.error(what, err);
  recent.push(now.getTime());
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  if (!logFile) return;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    rotateIfLarge(logFile);
    const where = ctx.method || ctx.path ? ` [${[ctx.method, ctx.path?.split('?')[0]].filter(Boolean).join(' ')}${ctx.userId ? ` user ${ctx.userId}` : ''}]` : '';
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const stack = err instanceof Error && err.stack ? `\n${err.stack.split('\n').slice(1, 8).join('\n')}` : '';
    appendFileSync(logFile, `${now.toISOString()} ${what}${where}: ${message}${stack}\n`, { mode: 0o600 });
  } catch {
    // the disk is full or the folder is gone: the terminal still has it
  }
}

/** How many errors were logged since `ms` ago (default 24 hours). */
export function serverErrorsSince(ms: number = 24 * 3_600_000, now: Date = new Date()): number {
  const since = now.getTime() - ms;
  let n = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i]! >= since; i--) n++;
  return n;
}
