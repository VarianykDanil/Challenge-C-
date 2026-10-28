/**
 * Encryption at rest for small secrets (the TOTP seeds): AES-256-GCM with a key derived (SHA-256) from the
 * application secret. Payload format `v1:<iv b64>:<tag b64>:<ciphertext b64>` so the scheme can be rotated later.
 *
 * Where the secret comes from, in order:
 *  1. `LM_APP_SECRET` (a long random string) — the operator-managed override;
 *  2. otherwise a 32-byte random key generated once and persisted in the app-secret file (default
 *     `server/data/app-secret`, next to the database; `configureAppSecret` points it elsewhere) with mode 0600 and
 *     reused on every later start. The server logs a one-line notice saying which file holds it.
 * A new key is only ever made where that is allowed: the server checks the database first (lib/appKey.ts) and then
 * turns creation off (`setKeyCreation(false)`), so a missing key file can never quietly become a new key for a
 * database that holds data locked with the old one.
 * There is no usable built-in default key any more: `DEV_SECRET` only survives to *decrypt* rows written by earlier
 * releases so they can be re-encrypted under the real key (`decryptLegacy`).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEV_SECRET = 'linear-hub-development-secret-not-for-production';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const DEFAULT_APP_SECRET_FILE = path.resolve(import.meta.dirname, '../../data/app-secret');

let secretFile = DEFAULT_APP_SECRET_FILE;
let cachedKey: Buffer | null = null;
let cachedSource: string | null = null;
let announced = false;
let creationAllowed = true;

/** Thrown when the key is needed, the key file is missing and making a new one is not allowed. */
export class AppKeyMissingError extends Error {
  constructor(file: string) {
    super(`The app key file is missing (${file}) and a new key is not made for an existing database.`);
    this.name = 'AppKeyMissingError';
  }
}

/** Whether a missing key file may be replaced by a newly generated key (the server turns this off after its check). */
export function setKeyCreation(allowed: boolean): void {
  creationAllowed = allowed;
}

/** True when `LM_APP_SECRET` is set (non-empty). */
export function hasAppSecret(): boolean {
  return Boolean(process.env.LM_APP_SECRET);
}

/** The file that holds the generated key when `LM_APP_SECRET` is unset. Resets the cached key. */
export function configureAppSecret(file: string): void {
  secretFile = path.resolve(file);
  cachedKey = null;
  cachedSource = null;
}

export function appSecretFile(): string {
  return secretFile;
}

/** The secret in a key file (trimmed), or null when the file is missing or empty. */
export function readSecretFile(file: string): string | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Writes a key file with mode 0600 (made private before the secret is in it, then renamed into place). */
export function writeSecretFile(file: string, secret: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, '', { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask-proof
  writeFileSync(tmp, `${secret}\n`);
  renameSync(tmp, file);
}

function loadOrCreateFileSecret(): string {
  const existing = readSecretFile(secretFile);
  if (existing) return existing;
  if (!creationAllowed) throw new AppKeyMissingError(secretFile);
  const secret = randomBytes(32).toString('hex');
  writeSecretFile(secretFile, secret);
  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * A fingerprint of a secret: HMAC-SHA256 of a fixed label under the key the secret makes. It tells keys apart (it is
 * stored in the database and printed on the recovery sheet) but cannot be turned back into the key.
 */
export function secretFingerprint(secret: string): string {
  return createHmac('sha256', deriveKey(secret)).update('linear-hub:key-fingerprint', 'utf8').digest('hex');
}

/** `3F2A-91BC-07DE`: the first 12 characters of a fingerprint, for people to compare. */
export function shortFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 12).toUpperCase().match(/.{1,4}/g) ?? []).join('-');
}

/**
 * The secret the key comes from right now (LM_APP_SECRET, else the key file), or null when there is none yet. Never
 * creates one. Only the recovery sheet and the encrypted off-site backup read it.
 */
export function currentAppSecret(): { secret: string; source: 'env' | 'file'; file: string | null } | null {
  const env = process.env.LM_APP_SECRET;
  if (env) return { secret: env, source: 'env', file: null };
  const text = readSecretFile(secretFile);
  return text ? { secret: text, source: 'file', file: secretFile } : null;
}

/** The fingerprint of the key in use (creating the key file only where that is allowed). */
export function appKeyFingerprint(): string {
  key();
  const current = currentAppSecret();
  if (!current) throw new AppKeyMissingError(secretFile);
  return secretFingerprint(current.secret);
}

function key(): Buffer {
  const env = process.env.LM_APP_SECRET;
  const source = env ? `env:${env}` : `file:${secretFile}`;
  if (cachedKey && cachedSource === source) return cachedKey;
  cachedKey = deriveKey(env || loadOrCreateFileSecret());
  cachedSource = source;
  return cachedKey;
}

/**
 * A separate 32-byte key for one purpose, derived from the application secret (HMAC-SHA256 of the purpose under the
 * secret's key), so the PIN pepper (lib/pin.ts) never reuses the encryption key itself. Same source and cache as `key()`.
 */
export function deriveAppKey(purpose: string): Buffer {
  return createHmac('sha256', key()).update(`linear-hub:${purpose}`, 'utf8').digest();
}

/** One-line start-up notice about where the key comes from (printed once; creates the file on a first start). */
export function announceAppSecret(): void {
  if (announced) return;
  announced = true;
  key();
  const current = currentAppSecret();
  const fingerprint = current ? ` (fingerprint ${shortFingerprint(secretFingerprint(current.secret))})` : '';
  console.log(
    `${hasAppSecret() ? 'The app key comes from LM_APP_SECRET' : `The app key is in ${secretFile} (mode 0600)`}${fingerprint}. It locks two-step ` +
      'sign-in, PINs, bank details and payment connections: without it they cannot be read. Make a recovery sheet ' +
      'on this computer (npm run recovery-sheet) and keep it locked away.',
  );
}

/** @deprecated kept for older call sites; the server no longer has a default key to warn about. */
export const warnIfDefaultSecret = announceAppSecret;

function encryptWith(text: string, k: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptWith(payload: string, k: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported encrypted payload');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ciphertext = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encrypt(text: string): string {
  return encryptWith(text, key());
}

/** Throws on a malformed payload, a wrong key or a tampered ciphertext (GCM authentication fails). */
export function decrypt(payload: string): string {
  return decryptWith(payload, key());
}

/** Decrypts with the key a given secret makes (checking a key that is not in use yet); throws on a wrong key. */
export function decryptWithSecret(payload: string, secret: string): string {
  return decryptWith(payload, deriveKey(secret));
}

/** Decrypts a row written by a release that still ran on the built-in development key; throws for anything else. */
export function decryptLegacy(payload: string): string {
  return decryptWith(payload, deriveKey(DEV_SECRET));
}
