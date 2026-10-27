/**
 * Backups and restore (smart release 1.1, p10).
 *
 * The whole company — people, gauges and payroll — lives in one SQLite file on one laptop, so this module keeps
 * dated, consistent copies of it next to the database (`<data dir>/backups`, `LM_BACKUP_DIR` relocates it):
 *  - `backupNow` uses node:sqlite's online backup API, which copies a consistent snapshot while the server keeps
 *    serving (WAL-safe; nothing is locked for longer than a page step). The copy is switched to a rollback journal
 *    so it is one self-contained file that opens anywhere, verified with `PRAGMA quick_check`, and only then renamed
 *    to `linear-YYYY-MM-DD-HHmm.sqlite` (Europe/London wall-clock time): a half-written backup never carries the name.
 *  - The app secret (the app-secret file: the key that encrypts two-step secrets and peppers sign-in PINs) is copied
 *    once into the folder (mode 0600) when missing or different: without it, two-step secrets in a restored database
 *    cannot be decrypted and no peppered PIN matches. So the folder as a whole is as sensitive as the key itself.
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
import { BACKUP_FILE_RE, ROTATION, londonParts, planRotation, type RotationPlan } from './rotation.ts';
import { checkAppKey, encryptedData, storedFingerprint } from './appKey.ts';
import {
  FILES_PARTIAL_RE,
  FILES_SNAPSHOT_RE,
  filesSnapshotName,
  restoreFiles,
  snapshotFiles,
  type DataFolders,
  type FilesRestoreResult,
  type SnapshotResult,
} from './backupFiles.ts';
import { currentAppSecret, readSecretFile, secretFingerprint, shortFingerprint } from './crypto.ts';
import { extractArchive, isArchiveFile, writeOffsiteCopy, type OffsiteConfig, type OffsiteResult } from './offsite.ts';
import { RESTORE_WARNING_META, describeLosses, noLosses, paymentLosses, restoreWarningRecord, type PaymentLosses } from './restoreCheck.ts';
import { keyLeftOutOfBackups } from './recoverySheet.ts';

export { BACKUP_FILE_RE, londonParts, planRotation, type RotationPlan };

export const BACKUP_RULES = {
  /** Keep the newest file of each of this many days, today included… */
  dailyDays: ROTATION.dailyDays,
  /** …plus the newest file of each of this many ISO weeks before those days. */
  weeklyWeeks: ROTATION.weeklyWeeks,
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

/** The copy of the app secret (the two-step and PIN key) kept in the backup folder. */
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
  const olderThan = (file: string, hours: number) => now.getTime() - statSync(file).mtimeMs >= hours * HOUR_MS;
  for (const name of names) {
    if (!PARTIAL_FILE_RE.test(name) && !FILES_PARTIAL_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (olderThan(file, BACKUP_RULES.partialMaxAgeHours)) rmSync(file, { recursive: true, force: true });
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
      if (!olderThan(file, BACKUP_RULES.graceHours)) {
        keep.push(name);
        continue;
      }
      unlinkSync(file);
      // the uploaded-files snapshot goes with its database file
      rmSync(path.join(dir, filesSnapshotName(name)), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // already gone
    }
  }
  // a files snapshot whose database file is gone (deleted by hand) goes too, once it is past the grace period
  for (const name of names) {
    if (!FILES_SNAPSHOT_RE.test(name) || names.includes(name.replace(/\.files$/, '.sqlite'))) continue;
    try {
      if (olderThan(path.join(dir, name), BACKUP_RULES.graceHours)) rmSync(path.join(dir, name), { recursive: true, force: true });
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
  /** The uploaded-files folders to snapshot beside the database file (null or left out: none). */
  files?: { folders: DataFolders; includeVideos: boolean } | null;
  /** Write the encrypted off-site copy afterwards (LM_OFFSITE_DIR). */
  offsite?: OffsiteConfig | null;
  /** The release, written into the off-site copy's manifest. */
  version?: string;
}

export interface BackupResult {
  file: string;
  path: string;
  bytes: number;
  ms: number;
  at: string;
  /** What happened to the app-secret copy (`copySecret`). */
  secret: SecretCopyOutcome;
  /** Old backups removed by rotation. */
  removed: string[];
  /** Backups in the folder afterwards. */
  count: number;
  /** The uploaded-files snapshot, when one was asked for. */
  files: SnapshotResult | null;
  /** The off-site copy, when off-site copies are on and it worked… */
  offsite: OffsiteResult | null;
  /** …or why it did not (the local backup is still good). */
  offsiteError: string | null;
}

/**
 * What happened to the key copy in the backups folder:
 *  - none: there is no key file to copy (LM_APP_SECRET is used, or no key was made yet);
 *  - copied / unchanged: `app-secret` holds the key in use;
 *  - kept-both: `app-secret` holds a DIFFERENT key. It is never overwritten (older backups may need it, and it may be
 *    the only copy left); the key in use is saved beside it as `app-secret-<fingerprint>`;
 *  - left-out / removed: the owner has confirmed a recovery sheet for this key, so backups no longer carry it: a stolen
 *    backups folder then holds no key. `removed`: a copy of this key that was still there was deleted. Copies of other
 *    keys are kept.
 */
export type SecretCopyOutcome = 'copied' | 'unchanged' | 'none' | 'kept-both' | 'left-out' | 'removed';

/** `app-secret-3f2a91bc07de`: where a key goes when `app-secret` already holds a different one. */
export function secretCopyNameFor(fingerprint: string): string {
  return `${SECRET_COPY_NAME}-${fingerprint.slice(0, 12)}`;
}

function writePrivate(dest: string, content: Buffer): void {
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, '', { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask-proof, before the key is in it
  writeFileSync(tmp, content);
  renameSync(tmp, dest);
}

/**
 * Keeps the key copy in the backups folder (mode 0600). `leaveOut`: the owner confirmed a recovery sheet for this key,
 * so it is not copied and a copy of it is removed. A copy of a different key is never overwritten or removed.
 */
export function copySecret(secretFile: string | null | undefined, dir: string, opts: { leaveOut?: boolean } = {}): SecretCopyOutcome {
  const secret = secretFile ? readSecretFile(secretFile) : null;
  if (!secretFile || !secret) return 'none';
  const src = readFileSync(secretFile);
  const fingerprint = secretFingerprint(secret);
  const dest = path.join(dir, SECRET_COPY_NAME);
  const beside = path.join(dir, secretCopyNameFor(fingerprint));
  const holdsThisKey = (file: string) => readSecretFile(file) === secret;
  if (opts.leaveOut) {
    let removed = false;
    for (const file of [dest, beside]) {
      if (existsSync(file) && holdsThisKey(file)) {
        unlinkSync(file);
        removed = true;
      }
    }
    return removed ? 'removed' : 'left-out';
  }
  if (!existsSync(dest)) {
    writePrivate(dest, src);
    return 'copied';
  }
  if (holdsThisKey(dest)) return 'unchanged';
  if (!existsSync(beside) || !holdsThisKey(beside)) writePrivate(beside, src);
  return 'kept-both';
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
  const job = runBackup(db, opts)
    .catch((err: unknown) => {
      recordBackupFailure(db, err);
      throw err;
    })
    .finally(() => inFlight.delete(db));
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
  const files = opts.files ? snapshotFiles(opts.files.folders, dir, file, { includeVideos: opts.files.includeVideos }) : null;
  const secret = copySecret(opts.secretFile, dir, { leaveOut: keyLeftOutOfBackups(db, opts.secretFile) });
  const iso = at.toISOString();
  recordBackup(db, iso, file);
  const removed = opts.rotate === false ? [] : rotate(dir, at).remove;
  let offsite: OffsiteResult | null = null;
  let offsiteError: string | null = null;
  if (opts.offsite) {
    try {
      offsite = await writeOffsiteCopy(db, opts.offsite, {
        backupPath: target,
        folders: opts.files?.folders ?? null,
        secret: currentAppSecret()?.secret ?? null,
        version: opts.version,
        now: at,
      });
    } catch (err) {
      // the local backup is good; the failure is recorded (meta) and shown in Settings and the Needs-attention bell
      offsiteError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    file,
    path: target,
    bytes,
    ms: Math.round(performance.now() - started),
    at: iso,
    secret,
    removed,
    count: listBackups(dir).length,
    files,
    offsite,
    offsiteError,
  };
}

export const BACKUP_FAILURE_META = { at: 'last_backup_error_at', message: 'last_backup_error' } as const;

/** Records a failed backup in meta (shown until a later backup succeeds); never throws. */
export function recordBackupFailure(db: DatabaseSync, err: unknown, at: Date = new Date()): void {
  try {
    const upsert = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    upsert.run(BACKUP_FAILURE_META.at, at.toISOString());
    upsert.run(BACKUP_FAILURE_META.message, (err instanceof Error ? err.message : String(err)).slice(0, 500));
  } catch {
    // the database itself is the problem: the log has the error
  }
}

/** The last backup failure, when it is newer than the last successful backup; null otherwise. */
export function lastBackupFailure(db: DatabaseSync): { at: string; message: string } | null {
  try {
    const rows = db
      .prepare(`SELECT key, value FROM meta WHERE key IN (?, ?, 'last_backup_at')`)
      .all(BACKUP_FAILURE_META.at, BACKUP_FAILURE_META.message) as Array<{ key: string; value: string }>;
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const failedAt = m[BACKUP_FAILURE_META.at];
    if (!failedAt) return null;
    const okAt = m.last_backup_at;
    if (okAt && Date.parse(okAt) >= Date.parse(failedAt)) return null;
    return { at: failedAt, message: m[BACKUP_FAILURE_META.message] ?? 'failed' };
  } catch {
    return null;
  }
}

export interface ScheduleOptions {
  dir: string;
  secretFile?: string | null;
  files?: BackupOptions['files'];
  offsite?: OffsiteConfig | null;
  version?: string;
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
      const r = await backupNow(db, { dir: opts.dir, secretFile: opts.secretFile, files: opts.files, offsite: opts.offsite, version: opts.version });
      log(
        `Backed up the database (${why}) to ${r.path} (${formatBytes(r.bytes)}, ${r.ms} ms)` +
          `${r.files ? ` with ${r.files.files} uploaded file${r.files.files === 1 ? '' : 's'}` : ''}; ` +
          `${r.count} backup${r.count === 1 ? '' : 's'} kept${r.removed.length ? `, ${r.removed.length} old one${r.removed.length === 1 ? '' : 's'} removed` : ''}.` +
          `${r.offsite ? ` Off-site copy: ${r.offsite.path} (${formatBytes(r.offsite.bytes)}).` : ''}`,
      );
      if (r.offsiteError) error(`Off-site copy failed (${why}); the local backup is fine and the next backup tries again.`, new Error(r.offsiteError));
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
  /**
   * People whose sign-in PIN is peppered with the app secret (`scrypt-hmac$…` hashes, 1.2 onwards): under any other key
   * their PIN never matches. 1.2.0's bare `scrypt$…` hashes do not depend on the key and are not counted; 0 before PINs.
   */
  pinUsers: number;
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
  let pinUsers = 0;
  try {
    pinUsers = n(`SELECT COUNT(*) AS n FROM users WHERE substr(pin_hash, 1, 12) = 'scrypt-hmac$'`);
  } catch {
    // no PIN column yet (a database from before 1.2): nobody has a PIN
  }
  return {
    users: n(`SELECT COUNT(*) AS n FROM users`),
    gauges: n(`SELECT COUNT(*) AS n FROM gauge_entries`),
    payrollRuns: n(`SELECT COUNT(*) AS n FROM payroll_runs`),
    latestGaugeDate: latest?.d ?? null,
    twoStepUsers,
    pinUsers,
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
  /** The backup to put in its place: a `.sqlite` backup, or an off-site `.lhbk` copy (then `passphrase` is asked). */
  candidate: string;
  /**
   * The port Linear Hub listens on: restore refuses while anything answers there. A hint only: the real guard is
   * `databaseInUse`, which catches a server on any port or address.
   */
  port: number;
  /**
   * Asked once the comparison is printed; false cancels. `typed`: the word the person must type (asked when the
   * restore would make Linear Hub forget payments).
   */
  confirm: (question: string, opts?: { typed?: string }) => Promise<boolean>;
  /** The passphrase of an off-site copy (asked only for one). */
  passphrase?: () => Promise<string | null>;
  log?: (line: string) => void;
  /** Extra line for the "server is running" refusal (e.g. the background-service hint). */
  runningHint?: string;
  /** The live app-secret file (default `<db dir>/app-secret`); null when LM_APP_SECRET is used (`envSecret`). */
  secretFile?: string | null;
  /** LM_APP_SECRET, when the server takes the key from it. */
  envSecret?: string | null;
  /** Where the uploaded files go back to (default: the folders the server uses for this database). */
  folders?: DataFolders;
  now?: Date;
}

/** The word typed to restore a backup that would make Linear Hub forget payments. */
export const RESTORE_TYPED_WORD = 'RESTORE';

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
       * The app key after the restore:
       *  - same: the key next to the database fits the backup (or nothing tells which key it needs and the copies agree);
       *  - installed: there was none, and the backup's own key was put in place;
       *  - replaced: the key there did not fit; it was kept as `<key file>.before-restore-<time>` and the backup's key
       *    put in place;
       *  - differs: the key there does not fit (or cannot be checked and differs from the backup's copy) and no copy
       *    that fits was found: Linear Hub will not start until it is put back (npm run key:restore);
       *  - missing: there is no key and no copy: same as differs;
       *  - none: nothing to compare with (LM_APP_SECRET is used, or no copy of the key in the backup's folder).
       */
      secret: 'installed' | 'replaced' | 'same' | 'differs' | 'missing' | 'none';
      /** The key file kept aside (secret 'replaced'). */
      keptKey: string | null;
      candidate: DbSummary;
      /** The uploaded files put back from the backup's snapshot (null: the backup had none). */
      files: FilesRestoreResult | null;
      /** What the live database had about money that the backup does not (it was confirmed by typing). */
      losses: PaymentLosses;
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

/** The key files a backup may have beside it: `app-secret`, then `app-secret-<fingerprint>` copies. */
function keyCopiesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return [
    ...names.filter((n) => n === SECRET_COPY_NAME),
    ...names.filter((n) => /^app-secret-[0-9a-f]{12}$/.test(n)).sort(),
  ].map((n) => path.join(dir, n));
}

interface KeyPlan {
  outcome: 'same' | 'install' | 'differs' | 'missing' | 'none';
  /** The copy to put in place (install). */
  copy: string | null;
  fingerprint: string | null;
}

/**
 * Which key the restored database needs. When the backup can tell (it records its key's fingerprint, or holds locked
 * values to test), the live key and every copy beside the backup are tried; otherwise only `app-secret` is compared,
 * as before.
 */
function planKey(staging: string, live: string | null, copies: string[]): KeyPlan {
  const db = new DatabaseSync(staging, { readOnly: true });
  try {
    const data = encryptedData(db);
    const verifiable = Boolean(storedFingerprint(db)) || data.samples.length > 0;
    if (verifiable) {
      const fits = (secret: string | null) => {
        if (!secret) return false;
        return checkAppKey(db, secret).status === 'ok';
      };
      if (fits(live)) return { outcome: 'same', copy: null, fingerprint: secretFingerprint(live!) };
      for (const copy of copies) {
        const secret = readSecretFile(copy);
        if (fits(secret)) return { outcome: 'install', copy, fingerprint: secretFingerprint(secret!) };
      }
      return { outcome: live ? 'differs' : 'missing', copy: null, fingerprint: null };
    }
    const saved = copies.find((c) => path.basename(c) === SECRET_COPY_NAME) ?? null;
    if (!saved) return { outcome: live ? 'none' : 'missing', copy: null, fingerprint: null };
    if (!live) return { outcome: 'install', copy: saved, fingerprint: null };
    return { outcome: readSecretFile(saved) === live ? 'same' : 'differs', copy: null, fingerprint: null };
  } finally {
    db.close();
  }
}

/**
 * Replace the live database with a backup. Never runs while the live database is open in another process (any port,
 * any address: `databaseInUse`) or while something answers on the port. The candidate is copied
 * to a private staging file next to the database (so the backup itself is never changed and the final swap is an
 * atomic rename on one disk), checked read-only, compared with the current database (including the payments it would
 * forget) and confirmed; then the current database and its -wal/-shm files move to `<db>.before-restore-<time>`, the
 * staging copy takes its name, the key that fits is put in place and the backup's uploaded files are put back.
 * An off-site copy (.lhbk) is first decrypted with its passphrase into a private folder next to the database.
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
  const archive = isArchiveFile(candidate);
  if (!archive && !isSqliteFile(candidate)) return { status: 'refused', reason: `${candidate} is not a SQLite database file or an off-site backup (.lhbk).` };

  const now = opts.now ?? new Date();
  const stamp = londonStamp(now);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const staging = `${dbPath}.restoring-${stamp}`;
  const unpacked = `${dbPath}.restoring-${stamp}.d`;
  removeDbFiles(staging);
  rmSync(unpacked, { recursive: true, force: true });
  try {
    let source = candidate;
    let filesSnapshot: string | null = path.join(path.dirname(candidate), filesSnapshotName(path.basename(candidate)));
    let keyCopies = keyCopiesIn(path.dirname(candidate));
    if (archive) {
      const passphrase = (await opts.passphrase?.()) ?? null;
      if (!passphrase) return { status: 'refused', reason: 'An off-site backup needs its passphrase (set LM_BACKUP_PASSPHRASE_FILE, or run this in a terminal to type it).' };
      mkdirSync(unpacked, { recursive: true, mode: 0o700 });
      try {
        await extractArchive(candidate, passphrase, unpacked);
      } catch (err) {
        return { status: 'refused', reason: `The backup was not restored. ${err instanceof Error ? err.message : String(err)}` };
      }
      source = path.join(unpacked, 'linear.sqlite');
      if (!existsSync(source)) return { status: 'refused', reason: 'The off-site backup holds no database.' };
      filesSnapshot = path.join(unpacked, 'files');
      keyCopies = keyCopiesIn(unpacked);
    }
    if (!filesSnapshot || !existsSync(filesSnapshot)) filesSnapshot = null;

    copyFileSync(source, staging);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${staging}-wal`);
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
    const losses = hasCurrent ? paymentLosses(dbPath, staging) : noLosses();
    const secretFile = opts.secretFile === undefined ? path.join(path.dirname(dbPath), SECRET_COPY_NAME) : opts.secretFile;
    const liveSecret = opts.envSecret || (secretFile ? readSecretFile(secretFile) : null);
    const key = planKey(staging, liveSecret, keyCopies);

    log(`Restore ${candidate}`);
    log(`   into ${dbPath}\n`);
    log(comparisonTable(current, check.summary, hasCurrent));
    if (filesSnapshot) log(`\nUploaded files: the backup's statement PDFs and signature image${existsSync(path.join(filesSnapshot, 'media')) ? ' and learning videos' : ''} are put back too.`);
    if (key.outcome === 'install') {
      log(
        opts.envSecret
          ? '\nApp key: LM_APP_SECRET does not open this backup, but a copy of its own key was found. After the restore, set LM_APP_SECRET to that key (or unset it and use the key file).'
          : `\nApp key: the backup's own key${key.fingerprint ? ` (fingerprint ${shortFingerprint(key.fingerprint)})` : ''} is put in place${liveSecret ? '; the key there now is kept beside it' : ''}.`,
      );
    } else if (key.outcome === 'differs' || key.outcome === 'missing') {
      log(
        '\nApp key: no key that opens this backup was found here. After the restore Linear Hub will not start until you put it back: ' +
          'npm run key:restore (type the key from your recovery sheet).',
      );
    }
    const lossLines = describeLosses(losses);
    if (lossLines.length) log(`\n${lossLines.join('\n')}`);
    log('');
    const confirmed = lossLines.length
      ? await opts.confirm(`To restore anyway, type ${RESTORE_TYPED_WORD}.`, { typed: RESTORE_TYPED_WORD })
      : await opts.confirm('Replace the current database with this backup?');
    if (!confirmed) return { status: 'cancelled' };
    const busyNow = await running();
    if (busyNow) return { status: 'refused', reason: busyNow };

    if (losses.total) {
      // the restored database remembers what it lost, so the office is warned in the app as well
      const w = new DatabaseSync(staging);
      try {
        w.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
          RESTORE_WARNING_META,
          restoreWarningRecord(losses, path.basename(candidate), now),
        );
      } finally {
        w.close();
      }
    }

    const previous = `${dbPath}.before-restore-${stamp}`;
    const moved: string[] = [];
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (!existsSync(dbPath + suffix)) continue;
      renameSync(dbPath + suffix, previous + suffix);
      moved.push(previous + suffix);
    }
    renameSync(staging, dbPath);

    let secret: Extract<RestoreOutcome, { status: 'restored' }>['secret'] = key.outcome === 'install' ? 'installed' : key.outcome;
    let keptKey: string | null = null;
    if (key.outcome === 'install' && key.copy && secretFile && !opts.envSecret) {
      if (existsSync(secretFile)) {
        keptKey = `${secretFile}.before-restore-${stamp}`;
        renameSync(secretFile, keptKey); // never deleted: it may be the only copy of another key
        secret = 'replaced';
      }
      copyFileSync(key.copy, secretFile);
      chmodSync(secretFile, 0o600);
    } else if (key.outcome === 'install') {
      secret = 'differs';
    }
    const folders = opts.folders ?? foldersOutsideBackup(dbPath);
    const files = filesSnapshot ? restoreFiles(filesSnapshot, folders, stamp) : null;
    return { status: 'restored', dbPath, previous: moved.includes(previous) ? previous : null, moved, secret, keptKey, candidate: check.summary, files, losses };
  } finally {
    // after the swap the staging name no longer exists; on a refusal or cancel this deletes the private copy
    removeDbFiles(staging);
    rmSync(unpacked, { recursive: true, force: true });
  }
}

const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;

/**
 * What restore says about the app secret once the files are swapped. Since 1.2 the key that encrypts two-step secrets
 * also peppers every sign-in PIN, so a restore onto a computer with no key, or with a different one, would otherwise
 * break every PIN quietly: the right PIN gets "That PIN is not right" and locks after ten tries. Empty when there is
 * nothing to say (same key, `LM_APP_SECRET` set, or nobody depends on a key that is missing).
 */
export function restoreKeyNotes(
  secret: Extract<RestoreOutcome, { status: 'restored' }>['secret'],
  candidate: Pick<DbSummary, 'twoStepUsers' | 'pinUsers'>,
  keptKey: string | null = null,
): string[] {
  const { pinUsers, twoStepUsers } = candidate;
  const pinReset =
    `If no copy of the key is left, reset those PINs: npm run pin:reset -- <email> on this computer for an administrator, ` +
    'then Team › person › Edit profile › Reset PIN for everyone else.';
  const twoStepReset = 'People with two-step sign-in can use a recovery code, and an administrator resets it (Team › Edit › Reset two-step verification).';
  if (secret === 'installed') {
    return ['Put the app secret from the backups folder in place (there was none), so two-step codes and sign-in PINs keep working.'];
  }
  if (secret === 'replaced') {
    return [
      `The app key next to the database did not open this backup, so the backup's own key was put in place${keptKey ? ` and the old one kept as ${keptKey}` : ''}. ` +
        'Make a new recovery sheet once Linear Hub is running (Settings › Backups): the sheet you have is for the other key.',
    ];
  }
  if (secret === 'differs') {
    if (!pinUsers && !twoStepUsers) {
      return [
        'Note: the app secret in the backups folder differs from the one next to the database (left as it is). Nobody in this ' +
          'backup has a sign-in PIN or two-step sign-in, so nothing depends on it yet.',
      ];
    }
    const hurt = [
      pinUsers ? `the ${people(pinUsers)} with a sign-in PIN would be told "That PIN is not right" (it locks after ten tries)` : '',
      twoStepUsers ? `the ${people(twoStepUsers)} with two-step sign-in could not finish with a code` : '',
    ].filter(Boolean);
    return [
      'Warning: the app secret in the backups folder (the key for two-step sign-in and PINs) differs from the one next to the ' +
        `database, which was left as it is. If this backup was made under the backups folder's key, ${hurt.join(' and ')}: ` +
        'before starting, replace the app-secret next to the database with the copy from the backups folder ' +
        '(npm run key:restore -- --file <that copy> checks it and does it), or type the key from your recovery sheet: npm run key:restore.' +
        (pinUsers ? ` ${pinReset}` : ''),
    ];
  }
  if (secret === 'missing' && (pinUsers || twoStepUsers)) {
    const hurt = [
      pinUsers ? `${people(pinUsers)} with a sign-in PIN would be told "That PIN is not right" (it locks after ten tries)` : '',
      twoStepUsers ? `${people(twoStepUsers)} with two-step sign-in cannot finish signing in with a code` : '',
    ].filter(Boolean);
    return [
      'Warning: there is no app secret (app-secret, the key for two-step sign-in and PINs) next to the database or in the ' +
        `backup's folder, so ${hurt.join(' and ')}. Before starting, put the key back: npm run key:restore (type it from your ` +
        'recovery sheet), or npm run key:restore -- --file <the app-secret you kept>.' +
        (pinUsers ? ` ${pinReset}` : '') +
        (twoStepUsers ? ` ${twoStepReset}` : ''),
    ];
  }
  return [];
}

// ── what the backups leave out ───────────────────────────────────────────────

/** The release 1.3 folders kept beside the database: in neither the database file nor its backups. */
export interface FoldersOutsideBackup {
  /** Learning videos (`<data dir>/media`, uploads in `media/videos`). */
  media: string;
  /** Client statement PDFs (`LM_STATEMENTS_DIR`, else `<data dir>/statements`). */
  statements: string;
  /** The office's signature image (`LM_UPLOADS_DIR`, else `uploads/` next to the app secret). */
  uploads: string;
}

/**
 * Where those folders are for this database, resolved as the server resolves them (lib/videos/files.ts mediaRootFor,
 * lib/statements/files.ts statementsDir, lib/invoices.ts uploadsDir; the app secret as index.ts places it), so the
 * backup and restore scripts can name them without loading the server's modules.
 */
export function foldersOutsideBackup(dbPath: string, env: NodeJS.ProcessEnv = process.env): FoldersOutsideBackup {
  const dataDir = path.dirname(path.resolve(dbPath));
  const secretFile = env.LM_APP_SECRET_FILE ? path.resolve(env.LM_APP_SECRET_FILE) : path.join(dataDir, SECRET_COPY_NAME);
  const statements = env.LM_STATEMENTS_DIR?.trim();
  const uploads = env.LM_UPLOADS_DIR?.trim();
  return {
    media: path.join(dataDir, 'media'),
    statements: statements ? path.resolve(statements) : path.join(dataDir, 'statements'),
    uploads: uploads ? path.resolve(uploads) : path.join(path.dirname(secretFile), 'uploads'),
  };
}

/** What `npm run backup` says the backup holds and what it leaves out. */
export function backupContentsNote(
  f: FoldersOutsideBackup,
  r: Pick<BackupResult, 'files' | 'secret'>,
  opts: { includeVideos: boolean; envSecret: boolean },
): string {
  const parts = ['the database'];
  if (r.files) {
    parts.push(
      `${r.files.files} uploaded file${r.files.files === 1 ? '' : 's'} (client statement PDFs and the signature image${opts.includeVideos ? ', learning videos' : ''})`,
    );
  }
  const keyIn = r.secret === 'copied' || r.secret === 'unchanged' || r.secret === 'kept-both';
  if (keyIn) parts.push('the app key');
  const lines = [`This backup holds ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}.`];
  if (!r.files) lines.push(`Copy ${f.statements} (client statement PDFs) and ${f.uploads} (the signature image) yourself too.`);
  if (!opts.includeVideos) lines.push(`Learning videos (${f.media}) are not in it: copy that folder yourself, or set LM_BACKUP_VIDEOS=1 to include them.`);
  if (r.secret === 'left-out' || r.secret === 'removed') lines.push('The app key is not in the local backups: it is on your recovery sheet.');
  else if (!keyIn && opts.envSecret) lines.push('LM_APP_SECRET is not in them: keep it on your recovery sheet.');
  return lines.join(' ');
}

/**
 * What restore says about the uploaded-files folders once the database is back: what came back from the backup's
 * snapshot (or, for a backup from before snapshots, that the folders were left as they are), and that videos uploaded
 * after the backup are now files without a row (said only when the media folder holds videos).
 */
export function restoreFolderNotes(
  f: FoldersOutsideBackup,
  files: FilesRestoreResult | null = null,
  exists: (p: string) => boolean = existsSync,
): string[] {
  const videos = path.join(f.media, 'videos');
  const lines: string[] = [];
  if (files) {
    lines.push(
      `Uploaded files: ${files.restored} put back from the backup, ${files.unchanged} already the same` +
        `${files.setAside ? `, ${files.setAside} that differed kept beside them as .before-restore files` : ''}. ` +
        'Files added after the backup were left as they are.',
    );
    if (!files.parts.includes('media')) lines.push(`Learning videos (${f.media}) are not in this backup and were left as they are.`);
  } else {
    lines.push(
      `Learning videos (${f.media}), client statement PDFs (${f.statements}) and the signature image (${f.uploads}) ` +
        'are not in this backup and were left as they are: if they are missing on this computer, copy those folders back ' +
        'from your own copy.',
    );
  }
  if (exists(videos)) lines.push(`Videos uploaded after this backup stay in ${videos} with no row in the restored database: delete them if you do not need them.`);
  return lines;
}
