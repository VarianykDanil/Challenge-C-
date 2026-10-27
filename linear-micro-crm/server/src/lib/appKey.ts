/**
 * Keeping the app key and the database together.
 *
 * The app key (lib/crypto.ts) locks two-step secrets, bank details, payment connections, bank files and the Gmail
 * password, and peppers sign-in PINs. A database that holds any of that is useless with a different key, so:
 *  - the database stores the key's fingerprint (`meta.app_key_fingerprint`, an HMAC of a fixed label: it identifies
 *    the key but cannot be turned back into it);
 *  - before anything uses the key, `checkAppKey` compares the key on this computer with the database. When the key
 *    file is missing, or the key does not match, and the database holds locked data, the server refuses to start with
 *    the recovery steps (`appKeyRefusal`). A new key is made only for a database that holds nothing locked yet;
 *  - a database from before this check (no fingerprint yet) is checked by decrypting a few of its locked values: the
 *    key that opens them is recorded, a key that opens none of them is refused.
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentAppSecret, decryptLegacy, decryptWithSecret, secretFingerprint, shortFingerprint } from './crypto.ts';

export const KEY_META = {
  fingerprint: 'app_key_fingerprint',
  recordedAt: 'app_key_recorded_at',
} as const;

/** Exit code when the key is missing or wrong (EX_CONFIG): the systemd unit does not restart on it. */
export const KEY_REFUSAL_EXIT_CODE = 78;

export interface EncryptedData {
  /** How many locked values the database holds, all kinds together. */
  total: number;
  /** Per kind, for the refusal message: 'two-step sign-in' → 3. */
  parts: Record<string, number>;
  /** A few `v1:` values to test a key against (PIN hashes cannot be tested: the PINs themselves are unknown). */
  samples: string[];
}

interface Source {
  label: string;
  table: string;
  column: string;
  /** The SQL for the value (default: the column) and an extra condition. */
  value?: string;
  where?: string;
  /** False for values that are not `v1:` payloads (peppered PIN hashes). */
  sample?: boolean;
}

const SOURCES: readonly Source[] = [
  { label: 'two-step sign-in', table: 'users', column: 'totp_secret_enc' },
  { label: 'two-step sign-in', table: 'users', column: 'totp_pending_enc' },
  { label: 'sign-in PINs', table: 'users', column: 'pin_hash', where: `substr(pin_hash, 1, 12) = 'scrypt-hmac$'`, sample: false },
  { label: 'bank details', table: 'bank_accounts', column: 'account_number_enc' },
  { label: 'payment connections', table: 'payment_connections', column: 'secrets_enc' },
  { label: 'payments', table: 'payment_items', column: 'payee_enc' },
  { label: 'bank files', table: 'payment_batches', column: 'file_enc' },
  {
    label: 'the Gmail password',
    table: 'meta',
    column: 'value',
    value: `json_extract(value, '$.passwordEnc')`,
    where: `key = 'ext:statements:mail' AND json_valid(value) AND json_extract(value, '$.passwordEnc') IS NOT NULL`,
  },
];

/** A complete `v1:iv:tag:ciphertext` payload (a damaged value cannot say anything about the key, so it is no sample). */
function wellFormed(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const parts = v.split(':');
  return (
    parts.length === 4 &&
    parts[0] === 'v1' &&
    Buffer.from(parts[1]!, 'base64').length === 12 &&
    Buffer.from(parts[2]!, 'base64').length === 16 &&
    parts[3]!.length > 0
  );
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  } catch {
    return new Set();
  }
}

/** The locked values this database holds (tables or columns that do not exist yet count as none). */
export function encryptedData(db: DatabaseSync): EncryptedData {
  const parts: Record<string, number> = {};
  const samples: string[] = [];
  let total = 0;
  const cols = new Map<string, Set<string>>();
  for (const s of SOURCES) {
    if (!cols.has(s.table)) cols.set(s.table, columnsOf(db, s.table));
    if (!cols.get(s.table)!.has(s.column)) continue;
    const value = s.value ?? s.column;
    const conditions = [...(s.value ? [] : [`${s.column} IS NOT NULL AND ${s.column} <> ''`]), ...(s.where ? [s.where] : [])];
    const where = conditions.join(' AND ');
    try {
      const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE ${where}`).get() as { n: number }).n);
      if (!n) continue;
      parts[s.label] = (parts[s.label] ?? 0) + n;
      total += n;
      if (s.sample !== false && samples.length < 12) {
        const rows = db.prepare(`SELECT ${value} AS v FROM ${s.table} WHERE ${where} LIMIT 3`).all() as Array<{ v: unknown }>;
        for (const r of rows) if (wellFormed(r.v)) samples.push(r.v);
      }
    } catch {
      // a table of another shape: nothing of that kind
    }
  }
  return { total, parts, samples };
}

/** The fingerprint recorded in the database, or null (a database from before 1.5, or a fresh one). */
export function storedFingerprint(db: DatabaseSync): string | null {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(KEY_META.fingerprint) as { value?: string } | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}

export type KeyCheck =
  /** The key fits (or nothing depends on it). `record`: write its fingerprint to the database. */
  | { status: 'ok'; fingerprint: string; record: boolean; note: string | null }
  /** There is no key and nothing depends on one: make a new key. */
  | { status: 'create'; note: string | null }
  /** There is no key, and the database holds data locked with one. */
  | { status: 'missing'; needed: string | null; data: EncryptedData }
  /** The key does not open this database's locked data. */
  | { status: 'mismatch'; needed: string | null; found: string; data: EncryptedData };

/** Does `secret` open this sample, or was the sample written under the old built-in development key? */
function opens(payload: string, secret: string): 'yes' | 'legacy' | 'no' {
  try {
    decryptWithSecret(payload, secret);
    return 'yes';
  } catch {
    try {
      decryptLegacy(payload);
      return 'legacy';
    } catch {
      return 'no';
    }
  }
}

/**
 * Compares a key (the secret it comes from, or null when there is none) with the database. Read-only: it never writes
 * the database or a key file. `npm run doctor` and the server's start both use it.
 */
export function checkAppKey(db: DatabaseSync, secret: string | null): KeyCheck {
  const data = encryptedData(db);
  const needed = storedFingerprint(db);
  if (!secret) {
    if (data.total > 0) return { status: 'missing', needed, data };
    return { status: 'create', note: needed ? 'A new app key was made: the old one is gone, but nothing in the database was locked with it.' : null };
  }
  const fingerprint = secretFingerprint(secret);
  if (needed === fingerprint) return { status: 'ok', fingerprint, record: false, note: null };
  if (needed) {
    if (data.total > 0) return { status: 'mismatch', needed, found: fingerprint, data };
    return { status: 'ok', fingerprint, record: true, note: 'The app key changed. Nothing in the database was locked with the old one, so the new one is now recorded.' };
  }
  // No fingerprint yet (a database from 1.4 or earlier): test the key on a few locked values.
  if (data.samples.length) {
    const results = data.samples.map((p) => opens(p, secret));
    if (!results.includes('yes') && !results.includes('legacy')) return { status: 'mismatch', needed: null, found: fingerprint, data };
  }
  return { status: 'ok', fingerprint, record: true, note: null };
}

/** Records the key's fingerprint in the database (after a check said it fits). */
export function recordFingerprint(db: DatabaseSync, fingerprint: string, at: Date = new Date()): void {
  const upsert = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  upsert.run(KEY_META.fingerprint, fingerprint);
  upsert.run(KEY_META.recordedAt, at.toISOString());
}

/** The current key (LM_APP_SECRET or the configured key file) checked against the database. */
export function checkCurrentAppKey(db: DatabaseSync): KeyCheck {
  return checkAppKey(db, currentAppSecret()?.secret ?? null);
}

export interface RefusalContext {
  dbPath: string;
  /** The key file the server reads (null when LM_APP_SECRET is used). */
  keyFile: string | null;
  backupDir: string;
}

function lockedList(data: EncryptedData): string {
  const names = Object.keys(data.parts);
  if (!names.length) return 'locked information';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What the server (and doctor) says when it will not start: what is wrong, why, and how to put the key back. */
export function appKeyRefusal(check: Extract<KeyCheck, { status: 'missing' | 'mismatch' }>, ctx: RefusalContext): string {
  const where = ctx.keyFile ? `the key file ${ctx.keyFile}` : 'LM_APP_SECRET';
  const needed = check.needed ? ` The database needs the key with fingerprint ${shortFingerprint(check.needed)}.` : '';
  const head =
    check.status === 'missing'
      ? `Linear Hub did not start: the app key is missing (${where}).`
      : `Linear Hub did not start: the app key in ${where} (fingerprint ${shortFingerprint(check.found)}) is not the key this database was locked with.`;
  return [
    head,
    '',
    `The database ${ctx.dbPath} holds ${lockedList(check.data)}, locked with the app key. ` +
      'Without that same key it cannot be read, so Linear Hub will not start with a new or different key.' +
      needed,
    '',
    'Put the right key back, then start Linear Hub again. Any one of these works:',
    '  1. From your printed recovery sheet:   npm run key:restore',
    '     (type the key exactly as it is printed on the sheet)',
    '  2. From an off-site backup:            npm run key:restore -- --from <backup file>.lhbk',
    '     (it asks for the backup passphrase)',
    `  3. From the backups folder:            npm run key:restore -- --file ${ctx.backupDir}/app-secret`,
    '     (only if a copy is kept there; files named app-secret-<fingerprint> are other keys)',
    'npm run key:restore checks the key against the database before it saves it, so a wrong key changes nothing.',
    'If this server used LM_APP_SECRET or LM_APP_SECRET_FILE before, set it the same way again instead.',
    'Do not delete the database to get past this message: that loses everything. Ask Noryn for help if none of the above works.',
  ].join('\n');
}
