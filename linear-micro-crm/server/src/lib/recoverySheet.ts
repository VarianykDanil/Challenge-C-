/**
 * The recovery sheet: one printed page with the app key and the steps to get Linear Hub back after losing the key or
 * the whole computer. Made by the owner (Settings › Backups, with a fresh two-step code) or on the server with
 * `npm run recovery-sheet`.
 *
 * What the database remembers (meta), never the key itself:
 *  - when a sheet was last made, and for which key (its fingerprint);
 *  - when the owner confirmed they have it (by typing the last six characters of the key from the sheet), and for
 *    which key. From then on, backups no longer carry a copy of that key (`keyLeftOutOfBackups`): a stolen backups
 *    folder then holds no key. Until then the key stays in the backups, so nothing can become unrecoverable.
 */
import type { DatabaseSync } from 'node:sqlite';
import { readSecretFile, secretFingerprint, shortFingerprint } from './crypto.ts';

export const SHEET_META = {
  madeAt: 'recovery_sheet_made_at',
  madeFor: 'recovery_sheet_made_fp',
  confirmedAt: 'recovery_sheet_confirmed_at',
  confirmedFor: 'recovery_sheet_confirmed_fp',
} as const;

function metaValues(db: DatabaseSync, keys: readonly string[]): Record<string, string> {
  try {
    const rows = db.prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys) as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export interface SheetStatus {
  /** When a sheet was last made (any key), or null. */
  madeAt: string | null;
  /** When the owner confirmed having the sheet, or null. */
  confirmedAt: string | null;
  /** True when the confirmed sheet is for the key in use now (a new key needs a new sheet). */
  confirmedForThisKey: boolean;
}

export function sheetStatus(db: DatabaseSync, fingerprint: string | null): SheetStatus {
  const m = metaValues(db, Object.values(SHEET_META));
  return {
    madeAt: m[SHEET_META.madeAt] ?? null,
    confirmedAt: m[SHEET_META.confirmedAt] ?? null,
    confirmedForThisKey: Boolean(fingerprint && m[SHEET_META.confirmedFor] === fingerprint),
  };
}

export function recordSheetMade(db: DatabaseSync, fingerprint: string, at: Date = new Date()): void {
  setMeta(db, SHEET_META.madeAt, at.toISOString());
  setMeta(db, SHEET_META.madeFor, fingerprint);
}

export function recordSheetConfirmed(db: DatabaseSync, fingerprint: string, at: Date = new Date()): void {
  setMeta(db, SHEET_META.confirmedAt, at.toISOString());
  setMeta(db, SHEET_META.confirmedFor, fingerprint);
}

/**
 * True when backups should leave the key in `secretFile` out: the owner has confirmed a recovery sheet for exactly
 * that key. False when there is no key file, no confirmation, or the confirmation was for another key.
 */
export function keyLeftOutOfBackups(db: DatabaseSync, secretFile: string | null | undefined): boolean {
  const secret = secretFile ? readSecretFile(secretFile) : null;
  if (!secret) return false;
  return metaValues(db, [SHEET_META.confirmedFor])[SHEET_META.confirmedFor] === secretFingerprint(secret);
}

/** The key as people read it from paper: a 64-character hex key in groups of four; any other secret as it is. */
export function keyForPaper(secret: string): string {
  return /^[0-9a-f]{64}$/i.test(secret) ? (secret.match(/.{4}/g) ?? []).join(' ') : secret;
}

/** What someone typed from the sheet, back as the key: spaces and dashes between groups of a hex key are dropped. */
export function keyFromPaper(typed: string): string {
  const trimmed = typed.trim();
  const compact = trimmed.replace(/[\s-]+/g, '');
  return /^[0-9a-f]{64}$/i.test(compact) ? compact.toLowerCase() : trimmed;
}

/** The last six characters of the key, which the owner types to confirm they have the sheet. */
export function lastSix(secret: string): string {
  return keyFromPaper(secret).slice(-6);
}

/** True when `typed` is the last six characters of the key (case and spaces ignored). */
export function confirmsKey(secret: string, typed: unknown): boolean {
  if (typeof typed !== 'string') return false;
  return typed.replace(/\s+/g, '').toLowerCase() === lastSix(secret).toLowerCase();
}

export interface RecoverySheet {
  madeAt: string;
  /** The key, grouped for paper. */
  key: string;
  /** `3F2A-91BC-07DE`. */
  fingerprint: string;
  /** Where the server reads the key: a file, or LM_APP_SECRET. */
  keySource: 'file' | 'env';
  keyFile: string | null;
  dbPath: string;
  backupDir: string;
  /** The off-site backup folder, when off-site copies are switched on. */
  offsiteDir: string | null;
  /** Numbered steps, plain words. */
  steps: string[];
  warning: string;
}

export interface SheetInput {
  secret: string;
  keySource: 'file' | 'env';
  keyFile: string | null;
  dbPath: string;
  backupDir: string;
  offsiteDir: string | null;
  at?: Date;
}

export function buildRecoverySheet(input: SheetInput): RecoverySheet {
  const steps = [
    'If Linear Hub will not start and says the app key is missing or wrong: on the server, run "npm run key:restore" and type the key above. ' +
      'It checks the key against the database before saving it, so a typing mistake changes nothing.',
    input.offsiteDir
      ? `If the server is lost: set up Linear Hub on a new server (docs/DEPLOY.md), copy the newest file from the off-site folder (${input.offsiteDir}) to it, ` +
        'run "npm run restore -- <file>.lhbk" and type the off-site backup passphrase. That brings back the database, the uploaded files and the key.'
      : 'If the server is lost: set up Linear Hub on a new server (docs/DEPLOY.md), copy your newest backup to it, run "npm run restore -- <file>", ' +
        'then "npm run key:restore" and type the key above.',
    'The off-site backup passphrase is NOT on this sheet: keep it on its own piece of paper, in a different place.',
    `Check: after "npm run key:restore", Linear Hub shows the key fingerprint ${shortFingerprint(secretFingerprint(input.secret))}. It must match the one on this sheet.`,
  ];
  return {
    madeAt: (input.at ?? new Date()).toISOString(),
    key: keyForPaper(input.secret),
    fingerprint: shortFingerprint(secretFingerprint(input.secret)),
    keySource: input.keySource,
    keyFile: input.keyFile,
    dbPath: input.dbPath,
    backupDir: input.backupDir,
    offsiteDir: input.offsiteDir,
    steps,
    warning:
      'Keep this sheet locked away, like a bank card. Anyone with it and a copy of the database can read the bank details in it. ' +
      'Do not photograph it or keep it on the server computer.',
  };
}

/** The sheet as plain text, for the terminal or a printer. */
export function recoverySheetText(sheet: RecoverySheet): string {
  const line = '─'.repeat(72);
  return [
    line,
    'LINEAR HUB — RECOVERY SHEET',
    `Made ${sheet.madeAt.slice(0, 16).replace('T', ' ')} (UTC)`,
    line,
    '',
    'App key (type it exactly, spaces do not matter):',
    '',
    `    ${sheet.key}`,
    '',
    `Key fingerprint: ${sheet.fingerprint}`,
    sheet.keySource === 'env' ? 'The server reads the key from LM_APP_SECRET.' : `The server reads the key from: ${sheet.keyFile}`,
    `Database: ${sheet.dbPath}`,
    `Backups folder: ${sheet.backupDir}`,
    `Off-site backups: ${sheet.offsiteDir ?? 'not switched on'}`,
    '',
    'What to do:',
    ...sheet.steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    sheet.warning,
    line,
  ].join('\n');
}
