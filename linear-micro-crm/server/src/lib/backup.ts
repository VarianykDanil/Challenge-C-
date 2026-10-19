/**
 * Backups and restore (smart release 1.1, p10).
 *
 * The whole company — people, gauges and payroll — lives in one SQLite file on one laptop, so this module keeps
 * dated, consistent copies of it next to the database (`<data dir>/backups`, `LM_BACKUP_DIR` relocates it):
 *  - `backupNow` uses node:sqlite's online backup API, which copies a consistent snapshot while the server keeps
 *    serving (WAL-safe; nothing is locked for longer than a page step). The copy is switched to a rollback journal
 *    so it is one self-contained file that opens anywhere, verified with `PRAGMA quick_check`, and only then renamed
 *    to `linear-YYYY-MM-DD-HHmm.sqlite` (Europe/London wall-clock time): a half-written backup never carries the name.
 *  - The two-step encryption key (app-secret) is copied once into the folder (mode 0600) when missing or different:
 *    without it, two-step secrets in a restored database cannot be decrypted.
 *  - `rotate` keeps the newest file of each of the last 30 days plus the newest of each of the 8 ISO weeks before
 *    that, never deletes a file written in the last 24 hours, and never touches a file that does not match the backup
 *    naming pattern.
 *  - `scheduleBackups` (index.ts): 10 minutes after start-up when the last backup is over 24 h old, and an hourly
 *    check that backs up once the local hour reaches `LM_BACKUP_HOUR` (default 2) and there is none dated today, so a
 *    laptop asleep at 02:00 still gets its nightly copy when it wakes. `LM_BACKUP=0` turns the schedule off.
 *  - `restoreDatabase` (restore.ts) refuses while the database is open in another process (an exclusive-lock probe, so
 *    a server on another PORT or HOST is caught too) or anything answers on the port, checks the candidate, shows what
 *    changes, asks, then moves the current database aside (`<db>.before-restore-<time>`) and puts the candidate in its
 *    place.
 *
 * Backups run on the real clock (they are about files on a disk, not about the business day), so a pinned
 * LM_BUSINESS_NOW never changes their names or the schedule.
 */
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { BackupStatus } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { DEFAULT_DB_PATH } from '../db/seed.ts';
import { findPortHolder, processCommand } from './boot.ts';
import { addDays, mondayOf } from './dates.ts';

export const BACKUP_RULES = {
  /** Keep the newest file of each of this many days, today included. */
  dailyDays: 30,
  /** …plus the newest file of each of this many ISO weeks before those days. */
  weeklyWeeks: 8,
  /** The start-up check runs this long after boot… */
  bootDelayMs: 10 * 60_000,
  /** …and backs up when the last backup is at least this old. */
  bootMaxAgeHours: 24,
  /** The nightly check runs this often. */
  checkEveryMs: 60 * 60_000,
  /** Default local hour (Europe/London) from which the nightly backup may run. */
  defaultHour: 2,
  /** Settings and doctor warn when the last backup is older than this. */
  staleHours: 36,
  /** Rotation never deletes a file written less than this long ago. */
  graceHours: 24,
  /** Rotation deletes a `.linear-….partial` staging file left behind (a killed backup) once it is this old. */
  partialMaxAgeHours: 1,
} as const;

/** `linear-2026-10-19-0200.sqlite`: date and HHmm in Europe/London wall-clock time. */
export const BACKUP_FILE_RE = /^linear-(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))-([01]\d|2[0-3])([0-5]\d)\.sqlite$/;
/** The copy of the two-step encryption key kept in the backup folder. */
export const SECRET_COPY_NAME = 'app-secret';
/** A backup's staging file (`.linear-…-HHmm.sqlite.<pid>.partial`, plus SQLite's -wal/-shm/-journal next to it). */
export const PARTIAL_FILE_RE = /^\.linear-[^/]*\.sqlite\.(?:\d+\.)?partial(?:-wal|-shm|-journal)?$/;
/** Tables a database must have to be accepted by restore. */
export const CORE_TABLES = ['users', 'teams', 'pay_plans', 'campaigns', 'events', 'gauge_entries', 'payroll_runs', 'meta'] as const;

const HOUR_MS = 3_600_000;

// ── configuration ────────────────────────────────────────────────────────────

/** False only when `LM_BACKUP=0`: the automatic schedule is off (npm run backup still works). */
export function backupsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LM_BACKUP?.trim() !== '0';
}

/** `LM_BACKUP_DIR`, else `backups/` next to the database. */
export function backupDirFor(dbPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.LM_BACKUP_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/** `LM_BACKUP_HOUR` (0–23), else 2. */
export function backupHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LM_BACKUP_HOUR?.trim();
  if (!raw || !/^\d{1,2}$/.test(raw)) return BACKUP_RULES.defaultHour;
  const n = Number(raw);
  return n <= 23 ? n : BACKUP_RULES.defaultHour;
}

let configuredDir: string | null = null;
let configuredSchedule: boolean | null = null;

/**
 * The folder GET /api/health reports (index.ts sets it from DB_PATH / LM_BACKUP_DIR at start-up), and whether this
 * server runs the automatic schedule (`scheduled`; left out, it follows LM_BACKUP).
 */
export function configureBackupDir(dir: string | null, opts: { scheduled?: boolean } = {}): void {
  configuredDir = dir ? path.resolve(dir) : null;
  configuredSchedule = dir && opts.scheduled !== undefined ? opts.scheduled : null;
}

export function currentBackupDir(): string {
  return configuredDir ?? backupDirFor(DEFAULT_DB_PATH);
}

/** True when this server makes the nightly backups itself (false when it was started with LM_BACKUP=0). */
export function backupScheduleOn(): boolean {
  return configuredSchedule ?? backupsEnabled();
}

// ── names and clocks ─────────────────────────────────────────────────────────

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Europe/London wall-clock parts of an instant (independent of the process TZ). */
export function londonParts(at: Date): { date: string; hour: number; minute: number; second: number } {
  const p: Record<string, string> = {};
  for (const part of LONDON.formatToParts(at)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `linear-YYYY-MM-DD-HHmm.sqlite` for an instant, in London wall-clock time. */
export function backupFileName(at: Date): string {
  const { date, hour, minute } = londonParts(at);
  return `linear-${date}-${pad2(hour)}${pad2(minute)}.sqlite`;
}

/** `2026-10-19-150212`: London wall-clock stamp for `.before-restore-…` names. */
export function londonStamp(at: Date): string {
  const { date, hour, minute, second } = londonParts(at);
  return `${date}-${pad2(hour)}${pad2(minute)}${pad2(second)}`;
}

// ── listing and status ───────────────────────────────────────────────────────

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  /** When the file was written (its modification time). */
  mtimeMs: number;
  /** London date from the name. */
  date: string;
}

/** Backup files in `dir`, newest first (by name, which sorts by London time). Missing folder → []. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    const m = BACKUP_FILE_RE.exec(name);
    if (!m) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, path: path.join(dir, name), bytes: st.size, mtimeMs: st.mtimeMs, date: m[1]! });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

interface MetaRow {
  key: string;
  value: string;
}

/** `last_backup_at` / `last_backup_file` from the meta table (null when none, or on a database without meta). */
export function lastBackupMeta(db: DatabaseSync): { at: string; file: string | null } | null {
  try {
    const rows = db.prepare(`SELECT key, value FROM meta WHERE key IN ('last_backup_at', 'last_backup_file')`).all() as unknown as MetaRow[];
    const at = rows.find((r) => r.key === 'last_backup_at')?.value;
    if (!at) return null;
    return { at, file: rows.find((r) => r.key === 'last_backup_file')?.value ?? null };
  } catch {
    return null;
  }
}

/** Record a finished backup in the meta table. */
export function recordBackup(db: DatabaseSync, at: string, file: string): void {
  const upsert = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  upsert.run('last_backup_at', at);
  upsert.run('last_backup_file', file);
}

/**
 * What GET /api/health (admins), Settings and doctor show. The last backup is the newer of the meta record and the
 * newest file in the folder: after a restore the meta table is the backup's own (older) record, and a backup made
 * against another copy of the database still counts.
 */
export function backupStatus(db: DatabaseSync, dir: string = currentBackupDir()): BackupStatus {
  const files = listBackups(dir);
  const meta = lastBackupMeta(db);
  const newest = files[0];
  const metaMs = meta ? Date.parse(meta.at) : Number.NaN;
  if (newest && (!Number.isFinite(metaMs) || newest.mtimeMs > metaMs + 60_000)) {
    return { lastAt: new Date(newest.mtimeMs).toISOString(), file: newest.name, count: files.length, dir };
  }
  return { lastAt: meta?.at ?? null, file: meta?.file ?? null, count: files.length, dir };
}

/** Hours since an ISO instant (Infinity for null or garbage). */
export function hoursSince(iso: string | null, now: Date = new Date()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / HOUR_MS : Number.POSITIVE_INFINITY;
}

/** Start-up check: back up when there has been none or the last one is at least 24 h old. */
export function needsBootBackup(lastAt: string | null, now: Date = new Date()): boolean {
  return hoursSince(lastAt, now) >= BACKUP_RULES.bootMaxAgeHours;
}

/** Hourly check: back up once the London hour has reached `hour` and no backup is dated today (London). */
export function needsNightlyBackup(lastAt: string | null, now: Date = new Date(), hour: number = backupHour()): boolean {
  const here = londonParts(now);
  if (here.hour < hour) return false;
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  return !Number.isFinite(t) || londonParts(new Date(t)).date !== here.date;
}

// ── rotation ─────────────────────────────────────────────────────────────────

export interface RotationPlan {
  keep: string[];
  remove: string[];
}

/**
 * Which backup files to keep on `today` (London date): the newest file of each of the last 30 days, plus the
 * newest file of each of the 8 ISO weeks before those days. The newest file overall is always kept, and names that
 * are not backups are left out of both lists (never removed).
 */
export function planRotation(names: readonly string[], today: string): RotationPlan {
  const windowStart = addDays(today, -(BACKUP_RULES.dailyDays - 1));
  const lastWeek = mondayOf(addDays(windowStart, -1));
  const firstWeek = addDays(lastWeek, -7 * (BACKUP_RULES.weeklyWeeks - 1));
  const backups = names.filter((n) => BACKUP_FILE_RE.test(n)).sort().reverse();
  const seen = new Set<string>();
  const keep: string[] = [];
  const remove: string[] = [];
  backups.forEach((name, i) => {
    const date = BACKUP_FILE_RE.exec(name)![1]!;
    let bucket: string | null;
    if (date >= windowStart) bucket = `day:${date}`;
    else {
      const monday = mondayOf(date);
      bucket = monday >= firstWeek ? `week:${monday}` : null;
    }
    if (i === 0 || (bucket !== null && !seen.has(bucket))) {
      if (bucket) seen.add(bucket);
      keep.push(name);
    } else {
      remove.push(name);
    }
  });
  return { keep, remove };
}

/**
 * Apply `planRotation` to the folder. Returns what was kept and removed. A file written in the last 24 hours is never
 * deleted, even when a newer one replaces it for that day: after a mistake at 10:50, a panicked `npm run backup` at
 * 11:00 must not delete the good 02:00 copy from the same morning. It goes at the first rotation a day later.
 * Staging files a killed backup left behind (`.linear-….partial`) are deleted once they are an hour old; they are never
 * backups, so they are not in the returned lists.
 */
export function rotate(dir: string, now: Date = new Date()): RotationPlan {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { keep: [], remove: [] };
  }
  for (const name of names) {
    if (!PARTIAL_FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now.getTime() - statSync(file).mtimeMs >= BACKUP_RULES.partialMaxAgeHours * HOUR_MS) unlinkSync(file);
    } catch {
      // already gone
    }
  }
  const plan = planRotation(names, londonParts(now).date);
  const keep = [...plan.keep];
  const removed: string[] = [];
  for (const name of plan.remove) {
    const file = path.join(dir, name);
    try {
      if (now.getTime() - statSync(file).mtimeMs < BACKUP_RULES.graceHours * HOUR_MS) {
        keep.push(name);
        continue;
      }
      unlinkSync(file);
      removed.push(name);
    } catch {
      // already gone
    }
  }
  return { keep, remove: removed };
}

// ── backing up ───────────────────────────────────────────────────────────────

export interface BackupOptions {
  /** Backup folder (created with mode 0700 when missing). */
  dir: string;
  /** The app-secret file to copy alongside (skipped when missing or null). */
  secretFile?: string | null;
  /** Instant used for the name and the meta record (default: now). */
  now?: Date;
  /** Run `rotate` afterwards (default true). */
  rotate?: boolean;
}

export interface BackupResult {
  file: string;
  path: string;
  bytes: number;
  ms: number;
  at: string;
  /** What happened to the app-secret copy. */
  secret: 'copied' | 'unchanged' | 'none';
  /** Old backups removed by rotation. */
  removed: string[];
  /** Backups in the folder afterwards. */
  count: number;
}

/** Copy the app-secret into the backup folder (mode 0600) when it is missing there or different. */
export function copySecret(secretFile: string | null | undefined, dir: string): BackupResult['secret'] {
  if (!secretFile || !existsSync(secretFile)) return 'none';
  const src = readFileSync(secretFile);
  const dest = path.join(dir, SECRET_COPY_NAME);
  if (existsSync(dest) && readFileSync(dest).equals(src)) return 'unchanged';
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, src, { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask-proof
  renameSync(tmp, dest);
  return 'copied';
}

function removeDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
}

const inFlight = new WeakMap<DatabaseSync, Promise<BackupResult>>();

/** Resolves once no backup of `db` is running (used before closing the database on shutdown). */
export async function whenBackupIdle(db: DatabaseSync): Promise<void> {
  await inFlight.get(db)?.catch(() => undefined);
}

/**
 * Write a consistent snapshot of the open database to `<dir>/linear-YYYY-MM-DD-HHmm.sqlite`, copy the app-secret,
 * record it in meta and rotate. A second call while one is running for the same database gets the same promise.
 */
export function backupNow(db: DatabaseSync, opts: BackupOptions): Promise<BackupResult> {
  const running = inFlight.get(db);
  if (running) return running;
  const job = runBackup(db, opts).finally(() => inFlight.delete(db));
  inFlight.set(db, job);
  return job;
}

async function runBackup(db: DatabaseSync, opts: BackupOptions): Promise<BackupResult> {
  const started = performance.now();
  const at = opts.now ?? new Date();
  const dir = path.resolve(opts.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = backupFileName(at);
  const target = path.join(dir, file);
  // per process: `npm run backup` in the same minute as the server's own backup must not write into the same file
  const partial = path.join(dir, `.${file}.${process.pid}.partial`);
  removeDbFiles(partial);
  try {
    // Node 26.8.1 finishes the copy on the thread pool but can leave its completion unprocessed until something else
    // wakes the event loop (a 30 s stall under the test runner; on an idle server it would wait for the next timer).
    // A short ref'd tick while the copy runs keeps the loop polling, so the promise settles within ~25 ms of the copy
    // finishing. Node 22 does not need it; it costs nothing there.
    const tick = setInterval(() => {}, 25);
    try {
      await sqliteBackup(db, partial);
    } finally {
      clearInterval(tick);
    }
    const copy = new DatabaseSync(partial);
    try {
      // One self-contained file: a WAL-mode copy would grow -wal/-shm files next to it whenever it is opened.
      copy.exec('PRAGMA journal_mode = DELETE');
      const check = copy.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (check?.quick_check !== 'ok') throw new Error(`The backup copy failed its check: ${check?.quick_check ?? 'no result'}`);
    } finally {
      copy.close();
    }
    renameSync(partial, target);
  } catch (err) {
    removeDbFiles(partial);
    throw err;
  }
  const bytes = statSync(target).size;
  const secret = copySecret(opts.secretFile, dir);
  const iso = at.toISOString();
  recordBackup(db, iso, file);
  const removed = opts.rotate === false ? [] : rotate(dir, at).remove;
  return { file, path: target, bytes, ms: Math.round(performance.now() - started), at: iso, secret, removed, count: listBackups(dir).length };
}

export interface ScheduleOptions {
  dir: string;
  secretFile?: string | null;
  hour?: number;
  log?: (line: string) => void;
  error?: (line: string, err: unknown) => void;
}

/** `25.4 GB` / `5.1 MB` / `812 kB`. */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} kB`;
}

/**
 * The automatic schedule (index.ts): a start-up check after 10 minutes and an hourly nightly check. Timers are
 * unref'd, a failure is logged and retried at the next check. Returns a function that cancels both timers.
 */
export function scheduleBackups(db: Db, opts: ScheduleOptions): () => void {
  const log = opts.log ?? ((line: string) => console.log(line));
  const error = opts.error ?? ((line: string, err: unknown) => console.error(line, err));
  const hour = opts.hour ?? backupHour();
  const attempt = async (why: string, needed: (lastAt: string | null) => boolean) => {
    try {
      if (!needed(backupStatus(db, opts.dir).lastAt)) return;
      const r = await backupNow(db, { dir: opts.dir, secretFile: opts.secretFile });
      log(
        `Backed up the database (${why}) to ${r.path} (${formatBytes(r.bytes)}, ${r.ms} ms); ` +
          `${r.count} backup${r.count === 1 ? '' : 's'} kept${r.removed.length ? `, ${r.removed.length} old one${r.removed.length === 1 ? '' : 's'} removed` : ''}.`,
      );
    } catch (err) {
      error(`Backup failed (${why}); the next check tries again.`, err);
    }
  };
  const boot = setTimeout(() => void attempt('start-up check: the last one was over 24 h old', (last) => needsBootBackup(last)), BACKUP_RULES.bootDelayMs);
  boot.unref();
  const nightly = setInterval(() => void attempt('nightly', (last) => needsNightlyBackup(last, new Date(), hour)), BACKUP_RULES.checkEveryMs);
  nightly.unref();
  return () => {
    clearTimeout(boot);
    clearInterval(nightly);
  };
}

// ── inspecting and restoring ─────────────────────────────────────────────────

export interface DbSummary {
  users: number;
  gauges: number;
  payrollRuns: number;
  latestGaugeDate: string | null;
  /** People with two-step sign-in on (their secrets need the app-secret key); 0 on a database from before two-step. */
  twoStepUsers: number;
}

/** Counts shown side by side before a restore. */
export function summariseDb(db: DatabaseSync): DbSummary {
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number | bigint } | undefined)?.n ?? 0);
  const latest = db.prepare(`SELECT MAX(date) AS d FROM gauge_entries`).get() as { d: string | null } | undefined;
  let twoStepUsers = 0;
  try {
    twoStepUsers = n(`SELECT COUNT(*) AS n FROM users WHERE totp_enabled_at IS NOT NULL`);
  } catch {
    // no two-step columns yet: nobody has it on
  }
  return {
    users: n(`SELECT COUNT(*) AS n FROM users`),
    gauges: n(`SELECT COUNT(*) AS n FROM gauge_entries`),
    payrollRuns: n(`SELECT COUNT(*) AS n FROM payroll_runs`),
    latestGaugeDate: latest?.d ?? null,
    twoStepUsers,
  };
}

export interface DatabaseCheck {
  ok: boolean;
  problems: string[];
  summary: DbSummary | null;
}

/** Open read-only, require `PRAGMA integrity_check` = ok and the core tables, and summarise. */
export function inspectDatabase(file: string): DatabaseCheck {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    return { ok: false, problems: [`It cannot be opened as a database: ${err instanceof Error ? err.message : String(err)}`], summary: null };
  }
  try {
    const problems: string[] = [];
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') problems.push(`PRAGMA integrity_check reported: ${integrity.slice(0, 5).join('; ') || 'nothing'}`);
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name));
    const missing = CORE_TABLES.filter((t) => !tables.has(t));
    if (missing.length) problems.push(`It is not a Linear Hub database: missing table${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);
    return { ok: problems.length === 0, problems, summary: missing.length ? null : summariseDb(db) };
  } catch (err) {
    return { ok: false, problems: [`It could not be read: ${err instanceof Error ? err.message : String(err)}`], summary: null };
  } finally {
    db.close();
  }
}

/**
 * Counts of the live database for the comparison. Opened normally (the server is stopped by then), so closing it
 * folds any leftover WAL into the file and removes the -wal/-shm files instead of creating them. Null when unreadable.
 */
function summariseLive(file: string): DbSummary | null {
  try {
    const db = new DatabaseSync(file);
    try {
      return summariseDb(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** True when the file starts with the SQLite header. */
export function isSqliteFile(file: string): boolean {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(16);
      return readSync(fd, buf, 0, 16, 0) === 16 && buf.toString('latin1') === 'SQLite format 3\u0000';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** True when the file's header says it is in WAL mode (bytes 18–19 = 2). */
function isWalFile(file: string): boolean {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(2);
      return readSync(fd, buf, 0, 2, 18) === 2 && buf[0] === 2;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** SQLite's "database is locked" result codes (SQLITE_BUSY, SQLITE_LOCKED). */
function isBusyError(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  return e?.errcode === 5 || e?.errcode === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(String(e?.message ?? ''));
}

/** Process ids that have the file open, as `lsof` reports them (empty when it cannot tell). */
function pidsWithFileOpen(file: string): number[] {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('lsof', ['-nP', '-t', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return [...new Set(out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  } catch {
    return [];
  }
}

/**
 * Is the database open in another process? A Linear Hub server keeps its connection open in WAL mode for as long as
 * it runs, and that holds a shared lock on the file, so an exclusive lock taken without waiting (busy timeout 0,
 * `locking_mode = EXCLUSIVE`, `BEGIN EXCLUSIVE`) fails with SQLITE_BUSY: whatever PORT or HOST that server uses.
 * Returns the refusal text, or null when the file is free or missing. Any other error (a damaged file, say) is not
 * "in use": replacing a damaged database is what restore is for, and the candidate is checked on its own.
 */
export function databaseInUse(file: string): string | null {
  if (!existsSync(file)) return null;
  let busy = false;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
  } catch (err) {
    busy = isBusyError(err);
  } finally {
    try {
      db?.close();
    } catch {
      // closing a connection that never opened
    }
  }
  if (!busy) return null;
  const who = pidsWithFileOpen(file)
    .filter((pid) => pid !== process.pid)
    .map((pid) => {
      const cmd = processCommand(pid);
      return `  pid ${pid}${cmd ? `: ${cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd}` : ''}`;
    });
  return [
    `The database is open in another process, so it was not touched: ${file}`,
    ...(who.length ? ['Open right now in:', ...who] : []),
    'This is usually Linear Hub still running, perhaps on another port or address (PORT=4001 npm start) or as a background service.',
    'Stop it first, with the PORT it runs on (for example: PORT=4001 npm run stop), then restore again.',
  ].join('\n');
}

export interface RestoreOptions {
  /** The live database file to replace. */
  dbPath: string;
  /** The backup to put in its place. */
  candidate: string;
  /**
   * The port Linear Hub listens on: restore refuses while anything answers there. A hint only: the real guard is
   * `databaseInUse`, which catches a server on any port or address.
   */
  port: number;
  /** Asked once the comparison is printed; false cancels. */
  confirm: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  /** Extra line for the "server is running" refusal (e.g. the background-service hint). */
  runningHint?: string;
  /** The live app-secret file (default `<db dir>/app-secret`); null skips the key check (LM_APP_SECRET is set). */
  secretFile?: string | null;
  now?: Date;
}

export type RestoreOutcome =
  | { status: 'refused'; reason: string }
  | { status: 'cancelled' }
  | {
      status: 'restored';
      dbPath: string;
      /** `<db>.before-restore-<time>` (plus -wal/-shm when they existed), or null when there was no database. */
      previous: string | null;
      moved: string[];
      /**
       * installed: the backup folder's app-secret was put in place because there was none; differs: left alone;
       * missing: there is no key next to the database nor in the backup's folder, so two-step secrets cannot be read.
       */
      secret: 'installed' | 'same' | 'differs' | 'missing' | 'none';
      candidate: DbSummary;
    };

function describeSummary(s: DbSummary | null): string[] {
  if (!s) return ['(unreadable)', '', '', ''];
  return [String(s.users), String(s.gauges), String(s.payrollRuns), s.latestGaugeDate ?? 'none'];
}

/** Side-by-side table of the current database and the candidate. */
export function comparisonTable(current: DbSummary | null, candidate: DbSummary, hasCurrent: boolean): string {
  const labels = ['Users', 'Gauge entries', 'Payroll runs', 'Latest gauge date'];
  const cur = hasCurrent ? describeSummary(current) : ['(no database)', '', '', ''];
  const cand = describeSummary(candidate);
  const w0 = Math.max(...labels.map((l) => l.length));
  const w1 = Math.max('Current'.length, ...cur.map((v) => v.length));
  const lines = [`  ${''.padEnd(w0)}  ${'Current'.padEnd(w1)}  Backup`];
  labels.forEach((l, i) => lines.push(`  ${l.padEnd(w0)}  ${cur[i]!.padEnd(w1)}  ${cand[i]}`));
  return lines.join('\n');
}

/**
 * Replace the live database with a backup. Never runs while the live database is open in another process (any port,
 * any address: `databaseInUse`) or while something answers on the port. The candidate is copied
 * to a private staging file next to the database (so the backup itself is never changed and the final swap is an
 * atomic rename on one disk), checked read-only, compared with the current database and confirmed; then the current
 * database and its -wal/-shm files move to `<db>.before-restore-<time>` and the staging copy takes its name.
 */
export async function restoreDatabase(opts: RestoreOptions): Promise<RestoreOutcome> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const dbPath = path.resolve(opts.dbPath);
  const candidate = path.resolve(opts.candidate);
  const running = async (): Promise<string | null> => {
    // the lock probe first: it is the one that cannot be fooled by a server on another port or bound to a LAN address
    const inUse = databaseInUse(dbPath);
    if (inUse) return [inUse, opts.runningHint].filter(Boolean).join('\n');
    const holder = await findPortHolder(opts.port);
    if (!holder) return null;
    const who = holder.linearHub ? `Linear Hub is running on port ${opts.port}` : `Something is listening on port ${opts.port}`;
    return [`${who}, so the database is in use and was not touched. Stop it first: npm run stop`, opts.runningHint].filter(Boolean).join('\n');
  };
  const busy = await running();
  if (busy) return { status: 'refused', reason: busy };
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return { status: 'refused', reason: `No backup file at ${candidate}` };
  if (candidate === dbPath) return { status: 'refused', reason: 'That is the live database itself: pick a file from the backups folder.' };
  if (!isSqliteFile(candidate)) return { status: 'refused', reason: `${candidate} is not a SQLite database file.` };

  const now = opts.now ?? new Date();
  const stamp = londonStamp(now);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const staging = `${dbPath}.restoring-${stamp}`;
  removeDbFiles(staging);
  try {
    copyFileSync(candidate, staging);
    if (existsSync(`${candidate}-wal`)) copyFileSync(`${candidate}-wal`, `${staging}-wal`);
    if (isWalFile(staging)) {
      // A raw copy of a live (WAL-mode) database: fold its WAL in and make the staging copy a single file.
      const w = new DatabaseSync(staging);
      try {
        w.exec('PRAGMA journal_mode = DELETE');
      } finally {
        w.close();
      }
    }
    const check = inspectDatabase(staging);
    if (!check.ok || !check.summary) return { status: 'refused', reason: `The backup was not restored. ${check.problems.join(' ')}` };

    const hasCurrent = existsSync(dbPath);
    const current = hasCurrent ? summariseLive(dbPath) : null;
    log(`Restore ${candidate}`);
    log(`   into ${dbPath}\n`);
    log(comparisonTable(current, check.summary, hasCurrent));
    log('');
    if (!(await opts.confirm('Replace the current database with this backup?'))) return { status: 'cancelled' };
    const busyNow = await running();
    if (busyNow) return { status: 'refused', reason: busyNow };

    const previous = `${dbPath}.before-restore-${stamp}`;
    const moved: string[] = [];
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (!existsSync(dbPath + suffix)) continue;
      renameSync(dbPath + suffix, previous + suffix);
      moved.push(previous + suffix);
    }
    renameSync(staging, dbPath);

    const secretFile = opts.secretFile === undefined ? path.join(path.dirname(dbPath), SECRET_COPY_NAME) : opts.secretFile;
    const savedSecret = path.join(path.dirname(candidate), SECRET_COPY_NAME);
    let secret: 'installed' | 'same' | 'differs' | 'missing' | 'none' = 'none';
    if (secretFile && existsSync(savedSecret)) {
      if (!existsSync(secretFile)) {
        copyFileSync(savedSecret, secretFile);
        chmodSync(secretFile, 0o600);
        secret = 'installed';
      } else {
        secret = readFileSync(savedSecret).equals(readFileSync(secretFile)) ? 'same' : 'differs';
      }
    } else if (secretFile && !existsSync(secretFile)) {
      secret = 'missing';
    }
    return { status: 'restored', dbPath, previous: moved.includes(previous) ? previous : null, moved, secret, candidate: check.summary };
  } finally {
    // after the swap the staging name no longer exists; on a refusal or cancel this deletes the private copy
    removeDbFiles(staging);
  }
}
