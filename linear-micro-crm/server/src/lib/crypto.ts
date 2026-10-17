/**
 * Encryption at rest for small secrets (the TOTP seeds): AES-256-GCM with a key derived (SHA-256) from the
 * application secret. Payload format `v1:<iv b64>:<tag b64>:<ciphertext b64>` so the scheme can be rotated later.
 *
 * Where the secret comes from, in order:
 *  1. `LM_APP_SECRET` (a long random string) — the operator-managed override;
 *  2. otherwise a 32-byte random key generated once and persisted in the app-secret file (default
 *     `server/data/app-secret`, next to the database; `configureAppSecret` points it elsewhere) with mode 0600 and
 *     reused on every later start. The server logs a one-line notice saying which file holds it.
 * There is no usable built-in default key any more: `DEV_SECRET` only survives to *decrypt* rows written by earlier
 * releases so they can be re-encrypted under the real key (`decryptLegacy`).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEV_SECRET = 'linear-hub-development-secret-not-for-production';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const DEFAULT_APP_SECRET_FILE = path.resolve(import.meta.dirname, '../../data/app-secret');

let secretFile = DEFAULT_APP_SECRET_FILE;
let cachedKey: Buffer | null = null;
let cachedSource: string | null = null;
let announced = false;

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

function loadOrCreateFileSecret(): string {
  if (existsSync(secretFile)) {
    const text = readFileSync(secretFile, 'utf8').trim();
    if (text) return text;
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(secretFile), { recursive: true });
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600); // umask-proof
  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function key(): Buffer {
  const env = process.env.LM_APP_SECRET;
  const source = env ? `env:${env}` : `file:${secretFile}`;
  if (cachedKey && cachedSource === source) return cachedKey;
  cachedKey = deriveKey(env || loadOrCreateFileSecret());
  cachedSource = source;
  return cachedKey;
}

/** One-line start-up notice about where the key comes from (printed once; creates the file on a first start). */
export function announceAppSecret(): void {
  if (announced) return;
  announced = true;
  if (hasAppSecret()) return;
  key();
  console.log(
    `LM_APP_SECRET is not set: two-step verification secrets are encrypted with the key in ${secretFile} ` +
      '(generated on first start, mode 0600). Back that file up with the database, or set LM_APP_SECRET to manage the key yourself.',
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

/** Decrypts a row written by a release that still ran on the built-in development key; throws for anything else. */
export function decryptLegacy(payload: string): string {
  return decryptWith(payload, deriveKey(DEV_SECRET));
}
