/**
 * Off-site backups: an encrypted copy of each backup in a folder that is not on this computer's disk.
 *
 * LM_OFFSITE_DIR names the folder (a mounted cloud drive, or a folder rclone copies to cloud storage); the passphrase
 * is in the file LM_BACKUP_PASSPHRASE_FILE (the owner also keeps it on paper, away from the recovery sheet). After each
 * backup, `writeOffsiteCopy` writes `linear-YYYY-MM-DD-HHmm.lhbk` there holding:
 *   manifest.json, linear.sqlite (the verified backup), app-secret (the app key) and files/<part>/… (statement PDFs,
 *   the signature image, and the learning videos when LM_BACKUP_VIDEOS=1),
 * reads it back to check it before giving it its name, and keeps 30 daily + 8 weekly copies there too.
 *
 * File format (.lhbk, version 1):
 *   "LHBKUP1\n" · header length (4 bytes, big-endian) · header JSON · ciphertext · 16-byte GCM tag
 * The header holds the scrypt settings and salt, the AES-256-GCM nonce and a passphrase check; it is authenticated as
 * additional data, so it cannot be changed unnoticed. The ciphertext is gzip of a list of entries, each
 * `length (4 bytes) · {"name","size"} JSON · bytes`, ended by a zero length. Nothing is trusted until the GCM tag checks
 * out at the end: entries are written to a private staging folder that is deleted when the check fails.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  fstatSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { createGunzip, createGzip } from 'node:zlib';
import { snapshotParts, walkFiles, type DataFolders } from './backupFiles.ts';
import { londonParts, planRotation } from './rotation.ts';

const MAGIC = Buffer.from('LHBKUP1\n', 'ascii');
export const ARCHIVE_EXT = '.lhbk';
/** `linear-2026-10-27-0200.lhbk` (same date and time groups as the local backup names, so rotation reads it). */
export const ARCHIVE_RE = /^linear-(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))-([01]\d|2[0-3])([0-5]\d)\.lhbk$/;
export const ARCHIVE_PARTIAL_RE = /^\.linear-[^/]*\.lhbk\.\d+\.partial$/;

export const OFFSITE_RULES = {
  /** Settings and the Needs-attention bell warn when the newest off-site copy is older than this. */
  staleHours: 48,
  minPassphraseLength: 12,
  /** scrypt cost: about a quarter of a second and 128 MB to try one passphrase. */
  kdf: { N: 2 ** 17, r: 8, p: 1 },
} as const;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ENTRY_HEADER_BYTES = 4096;

const scryptAsync = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

// ── settings ─────────────────────────────────────────────────────────────────

export interface OffsiteConfig {
  dir: string;
  /** LM_BACKUP_PASSPHRASE_FILE, resolved (null when it is not set). */
  passphraseFile: string | null;
  includeVideos: boolean;
  /** Tests only: a cheaper scrypt cost. */
  kdfN?: number;
}

/** LM_OFFSITE_DIR / LM_BACKUP_PASSPHRASE_FILE / LM_BACKUP_VIDEOS; null when off-site copies are not switched on. */
export function offsiteConfig(env: NodeJS.ProcessEnv = process.env): OffsiteConfig | null {
  const dir = env.LM_OFFSITE_DIR?.trim();
  if (!dir) return null;
  const pass = env.LM_BACKUP_PASSPHRASE_FILE?.trim();
  return { dir: path.resolve(dir), passphraseFile: pass ? path.resolve(pass) : null, includeVideos: env.LM_BACKUP_VIDEOS?.trim() === '1' };
}

/** The passphrase from LM_BACKUP_PASSPHRASE_FILE (null when unset or unreadable). */
export function readPassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.LM_BACKUP_PASSPHRASE_FILE?.trim();
  if (!file) return null;
  try {
    const text = readFileSync(path.resolve(file), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Why off-site copies cannot be written right now (plain words), or null when they can. */
export function offsiteProblem(config: OffsiteConfig): string | null {
  if (!config.passphraseFile) return 'LM_OFFSITE_DIR is set but LM_BACKUP_PASSPHRASE_FILE is not: off-site copies need a passphrase file.';
  let passphrase: string | null = null;
  try {
    passphrase = readFileSync(config.passphraseFile, 'utf8').trim();
  } catch {
    return `The passphrase file ${config.passphraseFile} cannot be read.`;
  }
  if (passphrase.length < OFFSITE_RULES.minPassphraseLength) {
    return `The passphrase in ${config.passphraseFile} is too short: use at least ${OFFSITE_RULES.minPassphraseLength} characters (npm run backup -- --new-passphrase makes one).`;
  }
  try {
    if (!statSync(config.dir).isDirectory()) return `The off-site folder ${config.dir} is not a folder.`;
  } catch {
    // never created here: a missing folder usually means the cloud drive is not mounted, and a copy on this disk is not off-site
    return `The off-site folder ${config.dir} is not there. Is the cloud drive connected? Linear Hub does not create it, so a copy never lands on this disk by mistake.`;
  }
  return null;
}

/** A new passphrase: 6 groups of 5 letters and digits (no look-alikes), about 150 bits. */
export function newPassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(30);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return Array.from({ length: 6 }, (_, i) => chars.slice(i * 5, i * 5 + 5).join('')).join('-');
}

// ── writing ──────────────────────────────────────────────────────────────────

export interface ArchiveEntry {
  name: string;
  /** A file to stream in… */
  path?: string;
  /** …or bytes. */
  data?: Buffer;
}

interface Header {
  format: 1;
  createdAt: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  compression: 'gzip';
  /** HMAC of a fixed label under the key: a wrong passphrase is told apart from a damaged file. */
  check: string;
}

const passphraseCheck = (key: Buffer) => createHmac('sha256', key).update('linear-hub:offsite-passphrase-check').digest('base64').slice(0, 22);
const kdfOptions = (N: number, r: number, p: number): ScryptOptions => ({ N, r, p, maxmem: 256 * 1024 * 1024 });

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

async function* entryStream(entries: readonly ArchiveEntry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    const size = e.data ? e.data.length : statSync(e.path!).size;
    const head = Buffer.from(JSON.stringify({ name: e.name, size }), 'utf8');
    yield u32(head.length);
    yield head;
    if (e.data) {
      yield e.data;
      continue;
    }
    if (!size) continue;
    let read = 0;
    for await (const chunk of createReadStream(e.path!, { start: 0, end: size - 1 })) {
      read += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (read !== size) throw new Error(`${e.name} got shorter while it was being copied; the next backup tries again.`);
  }
  yield u32(0);
}

/** Writes an encrypted archive to `file` (mode 0600, flushed to disk). */
export async function writeArchive(file: string, entries: readonly ArchiveEntry[], passphrase: string, opts: { kdfN?: number; now?: Date } = {}): Promise<void> {
  const { r, p } = OFFSITE_RULES.kdf;
  const N = opts.kdfN ?? OFFSITE_RULES.kdf.N;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scryptAsync(passphrase.normalize('NFC'), salt, 32, kdfOptions(N, r, p));
  const header: Header = {
    format: 1,
    createdAt: (opts.now ?? new Date()).toISOString(),
    kdf: { name: 'scrypt', N, r, p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    compression: 'gzip',
    check: passphraseCheck(key),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.concat([MAGIC, u32(headerBytes.length), headerBytes]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(prefix);
  const out = createWriteStream(file, { mode: 0o600 });
  out.write(prefix);
  await pipeline(Readable.from(entryStream(entries)), createGzip({ level: 6 }), cipher, out);
  appendFileSync(file, cipher.getAuthTag());
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── reading ──────────────────────────────────────────────────────────────────

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

function readHeader(file: string): { header: Header; prefix: Buffer; size: number } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Buffer.alloc(MAGIC.length + 4);
    if (readSync(fd, start, 0, start.length, 0) !== start.length || !start.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ArchiveError(`${file} is not a Linear Hub off-site backup (.lhbk).`);
    }
    const len = start.readUInt32BE(MAGIC.length);
    if (len < 2 || len > MAX_HEADER_BYTES || start.length + len + 16 > size) throw new ArchiveError(`${file} is damaged (its header is not readable).`);
    const headerBytes = Buffer.alloc(len);
    readSync(fd, headerBytes, 0, len, start.length);
    let header: Header;
    try {
      header = JSON.parse(headerBytes.toString('utf8')) as Header;
    } catch {
      throw new ArchiveError(`${file} is damaged (its header is not readable).`);
    }
    const k = header.kdf;
    const okKdf =
      k?.name === 'scrypt' && Number.isInteger(k.N) && k.N >= 2 ** 10 && k.N <= 2 ** 20 && (k.N & (k.N - 1)) === 0 && k.r === 8 && k.p >= 1 && k.p <= 4;
    if (header.format !== 1 || header.cipher !== 'aes-256-gcm' || header.compression !== 'gzip' || !okKdf) {
      throw new ArchiveError(`${file} was made by a newer Linear Hub, or is damaged: update Linear Hub (npm run latest) and try again.`);
    }
    return { header, prefix: Buffer.concat([start, headerBytes]), size };
  } finally {
    closeSync(fd);
  }
}

/** A safe relative entry name: manifest.json, linear.sqlite, app-secret or files/<part>/…, never leaving the folder. */
function safeEntryName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 1024 || name.includes('\0') || name.includes('\\')) throw new ArchiveError('The backup holds a file with a bad name.');
  const norm = path.posix.normalize(name);
  if (norm !== name || norm.startsWith('/') || norm.split('/').includes('..')) throw new ArchiveError('The backup holds a file with a bad name.');
  if (!['manifest.json', 'linear.sqlite', 'app-secret'].includes(norm) && !/^files\/(statements|uploads|media)\/./.test(norm)) {
    throw new ArchiveError(`The backup holds an unexpected file (${name}).`);
  }
  return norm;
}

export interface Manifest {
  format: 1;
  createdAt: string;
  /** The local backup the archive was made from. */
  backup: string;
  includesKey: boolean;
  includesVideos: boolean;
  files: number;
  bytes: number;
  version: string;
}

export interface ExtractResult {
  manifest: Manifest | null;
  /** Entry names, in order. */
  names: string[];
}

/**
 * Decrypts `file` with `passphrase` and writes the entries `want` accepts into `dest` (default: all). The whole archive
 * is always read, so the GCM check covers every byte; on any failure `dest` is left for the caller to delete.
 */
export async function extractArchive(file: string, passphrase: string, dest: string | null, want: (name: string) => boolean = () => true): Promise<ExtractResult> {
  const { header, prefix, size } = readHeader(file);
  const key = await scryptAsync(passphrase.normalize('NFC'), Buffer.from(header.kdf.salt, 'base64'), 32, kdfOptions(header.kdf.N, header.kdf.r, header.kdf.p));
  const expected = Buffer.from(passphraseCheck(key));
  const given = Buffer.from(String(header.check ?? ''));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new ArchiveError('That passphrase does not open this backup. Check it against your paper copy (letters, digits and dashes) and try again.');
  }
  const tag = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);

  const names: string[] = [];
  let manifestBytes: Buffer[] | null = null;
  let manifestText: string | null = null;
  // the entry parser: length → header → body, until a zero length
  let buf: Buffer = Buffer.alloc(0);
  // the closures below change it, so its type is the whole set from the start
  let state = 'len' as 'len' | 'head' | 'body' | 'done';
  let need = 4;
  let remaining = 0;
  let current: string | null = null;
  let out: number | null = null;
  const closeOut = () => {
    if (out !== null) closeSync(out);
    out = null;
  };
  const sink = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length) {
        if (state === 'done') throw new ArchiveError(`${file} is damaged (data after its end).`);
        if (state === 'body') {
          const take = Math.min(remaining, buf.length);
          if (out !== null) writeSync(out, buf, 0, take);
          if (manifestBytes) manifestBytes.push(Buffer.from(buf.subarray(0, take)));
          buf = buf.subarray(take);
          remaining -= take;
          if (!remaining) finishEntry();
          continue;
        }
        if (buf.length < need) break;
        const piece = buf.subarray(0, need);
        buf = buf.subarray(need);
        if (state === 'len') {
          const len = piece.readUInt32BE(0);
          if (len === 0) {
            state = 'done';
            continue;
          }
          if (len > MAX_ENTRY_HEADER_BYTES) throw new ArchiveError(`${file} is damaged (an entry header is too long).`);
          state = 'head';
          need = len;
        } else {
          let meta: { name?: unknown; size?: unknown };
          try {
            meta = JSON.parse(piece.toString('utf8')) as { name?: unknown; size?: unknown };
          } catch {
            throw new ArchiveError(`${file} is damaged (an entry header is not readable).`);
          }
          const name = safeEntryName(meta.name);
          if (typeof meta.size !== 'number' || !Number.isSafeInteger(meta.size) || meta.size < 0) throw new ArchiveError(`${file} is damaged (a bad entry size).`);
          current = name;
          names.push(name);
          remaining = meta.size;
          manifestBytes = name === 'manifest.json' ? [] : null;
          if (dest && want(name)) {
            const target = path.join(dest, ...name.split('/'));
            mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            out = openSync(target, 'w', 0o600);
          }
          state = 'body';
          if (!remaining) finishEntry();
        }
      }
    }
  };
  function finishEntry(): void {
    closeOut();
    if (current === 'manifest.json' && manifestBytes) manifestText = Buffer.concat(manifestBytes).toString('utf8');
    manifestBytes = null;
    current = null;
    state = 'len';
    need = 4;
  }
  try {
    await pipeline(createReadStream(file, { start: prefix.length, end: size - 17 }), decipher, createGunzip(), sink);
  } catch (err) {
    closeOut();
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(`${file} is damaged or was changed after it was made (it failed its check), so nothing in it was used.`);
  }
  if (state !== 'done') throw new ArchiveError(`${file} is cut short (it ends before its last entry).`);
  let manifest: Manifest | null = null;
  try {
    manifest = manifestText ? (JSON.parse(manifestText) as Manifest) : null;
  } catch {
    manifest = null;
  }
  return { manifest, names };
}

/** The app key inside an archive (null when it holds none). */
export async function readArchiveKey(file: string, passphrase: string): Promise<string | null> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lm-key-'));
  try {
    const r = await extractArchive(file, passphrase, tmp, (n) => n === 'app-secret');
    if (!r.names.includes('app-secret')) return null;
    return readFileSync(path.join(tmp, 'app-secret'), 'utf8').trim() || null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── the off-site copy of a backup ────────────────────────────────────────────

export const OFFSITE_META = {
  at: 'last_offsite_at',
  file: 'last_offsite_file',
  errorAt: 'last_offsite_error_at',
  error: 'last_offsite_error',
} as const;

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export interface OffsiteResult {
  file: string;
  path: string;
  bytes: number;
  ms: number;
  /** Entries in the archive besides the manifest. */
  entries: number;
  includesKey: boolean;
  removed: string[];
}

export interface OffsiteInput {
  /** The verified local backup file. */
  backupPath: string;
  /** The uploaded-files folders to include (null: none). */
  folders: DataFolders | null;
  /** The app key's secret (null: none to include). */
  secret: string | null;
  version?: string;
  now?: Date;
}

/** `linear-2026-10-27-0200.sqlite` → `linear-2026-10-27-0200.lhbk`. */
export const archiveNameFor = (backupName: string) => backupName.replace(/\.sqlite$/, ARCHIVE_EXT);

/**
 * Writes the encrypted copy of a backup into the off-site folder, checks it by reading it back, gives it its name,
 * rotates the folder and records the result. Throws (and records the failure) when anything is wrong.
 */
export async function writeOffsiteCopy(db: DatabaseSync, config: OffsiteConfig, input: OffsiteInput): Promise<OffsiteResult> {
  const now = input.now ?? new Date();
  try {
    const problem = offsiteProblem(config);
    if (problem) throw new Error(problem);
    const passphrase = readFileSync(config.passphraseFile!, 'utf8').trim();
    const started = performance.now();
    const name = archiveNameFor(path.basename(input.backupPath));
    const target = path.join(config.dir, name);
    const partial = path.join(config.dir, `.${name}.${process.pid}.partial`);
    const fileEntries: ArchiveEntry[] = [];
    let fileBytes = 0;
    for (const [part, source] of input.folders ? snapshotParts(input.folders, config.includeVideos) : []) {
      for (const rel of walkFiles(source)) {
        const p = path.join(source, rel);
        fileEntries.push({ name: `files/${part}/${rel.split(path.sep).join('/')}`, path: p });
        fileBytes += statSync(p).size;
      }
    }
    const manifest: Manifest = {
      format: 1,
      createdAt: now.toISOString(),
      backup: path.basename(input.backupPath),
      includesKey: Boolean(input.secret),
      includesVideos: config.includeVideos,
      files: fileEntries.length,
      bytes: statSync(input.backupPath).size + fileBytes,
      version: input.version ?? '',
    };
    const entries: ArchiveEntry[] = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'linear.sqlite', path: input.backupPath },
      ...(input.secret ? [{ name: 'app-secret', data: Buffer.from(`${input.secret}\n`) }] : []),
      ...fileEntries,
    ];
    try {
      await writeArchive(partial, entries, passphrase, { kdfN: config.kdfN, now });
      const check = await extractArchive(partial, passphrase, null);
      if (check.names.length !== entries.length) throw new Error('The off-site copy did not read back complete.');
      renameSync(partial, target);
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
    const removed = rotateArchives(config.dir, now);
    setMeta(db, OFFSITE_META.at, now.toISOString());
    setMeta(db, OFFSITE_META.file, name);
    return {
      file: name,
      path: target,
      bytes: statSync(target).size,
      ms: Math.round(performance.now() - started),
      entries: entries.length - 1,
      includesKey: Boolean(input.secret),
      removed,
    };
  } catch (err) {
    try {
      setMeta(db, OFFSITE_META.errorAt, now.toISOString());
      setMeta(db, OFFSITE_META.error, (err instanceof Error ? err.message : String(err)).slice(0, 500));
    } catch {
      // the database itself failed: the caller logs the error
    }
    throw err;
  }
}

/** Off-site copies in a folder, newest first. */
export function listArchives(dir: string): Array<{ name: string; path: string; bytes: number; mtimeMs: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => ARCHIVE_RE.test(n))
    .sort()
    .reverse()
    .flatMap((name) => {
      try {
        const st = statSync(path.join(dir, name));
        return st.isFile() ? [{ name, path: path.join(dir, name), bytes: st.size, mtimeMs: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    });
}

const GRACE_MS = 24 * 3_600_000;

/** 30 daily + 8 weekly off-site copies, nothing written in the last 24 hours removed; returns what was removed. */
export function rotateArchives(dir: string, now: Date = new Date()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!ARCHIVE_PARTIAL_RE.test(name)) continue;
    try {
      if (now.getTime() - statSync(path.join(dir, name)).mtimeMs >= 3_600_000) unlinkSync(path.join(dir, name));
    } catch {
      // already gone
    }
  }
  const removed: string[] = [];
  for (const name of planRotation(names, londonParts(now).date, ARCHIVE_RE).remove) {
    const file = path.join(dir, name);
    try {
      if (now.getTime() - statSync(file).mtimeMs < GRACE_MS) continue;
      unlinkSync(file);
      removed.push(name);
    } catch {
      // already gone
    }
  }
  return removed;
}

export interface OffsiteStatus {
  configured: boolean;
  dir: string | null;
  lastAt: string | null;
  file: string | null;
  /** The last failure, when it is newer than the last success. */
  error: string | null;
  errorAt: string | null;
  /** Why it cannot run right now (no passphrase, folder missing), or null. */
  problem: string | null;
}

export function offsiteStatus(db: DatabaseSync, config: OffsiteConfig | null): OffsiteStatus {
  let m: Record<string, string> = {};
  try {
    const keys = Object.values(OFFSITE_META);
    const rows = db.prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys) as Array<{ key: string; value: string }>;
    m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    m = {};
  }
  const lastAt = m[OFFSITE_META.at] ?? null;
  const errorAt = m[OFFSITE_META.errorAt] ?? null;
  const failedLast = Boolean(errorAt && (!lastAt || Date.parse(errorAt) > Date.parse(lastAt)));
  return {
    configured: Boolean(config),
    dir: config?.dir ?? null,
    lastAt,
    file: m[OFFSITE_META.file] ?? null,
    error: failedLast ? (m[OFFSITE_META.error] ?? 'failed') : null,
    errorAt: failedLast ? errorAt : null,
    problem: config ? offsiteProblem(config) : null,
  };
}

/** True when `file` starts like an off-site backup. */
export function isArchiveFile(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const fd = openSync(file, 'r');
    try {
      const b = Buffer.alloc(MAGIC.length);
      return readSync(fd, b, 0, b.length, 0) === b.length && b.equals(MAGIC);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
