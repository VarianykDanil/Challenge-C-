/**
 * Encryption at rest for small secrets (the TOTP seeds): AES-256-GCM with a key derived from `LM_APP_SECRET`.
 * Payload format `v1:<iv b64>:<tag b64>:<ciphertext b64>` so the scheme can be rotated later. Without the variable
 * a fixed development key is used — fine for the demo database, never for real people, hence the production warning.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEV_SECRET = 'linear-hub-development-secret-not-for-production';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let warned = false;

/** True when `LM_APP_SECRET` is set (non-empty). */
export function hasAppSecret(): boolean {
  return Boolean(process.env.LM_APP_SECRET);
}

/** One-line startup warning when production runs on the development key; safe to call more than once. */
export function warnIfDefaultSecret(): void {
  if (warned || hasAppSecret() || process.env.NODE_ENV !== 'production') return;
  warned = true;
  console.warn('LM_APP_SECRET is not set: two-step verification secrets are encrypted with the built-in development key. Set LM_APP_SECRET to a long random value.');
}

function key(): Buffer {
  warnIfDefaultSecret();
  return createHash('sha256').update(process.env.LM_APP_SECRET || DEV_SECRET, 'utf8').digest();
}

export function encrypt(text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Throws on a malformed payload, a wrong key or a tampered ciphertext (GCM authentication fails). */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported encrypted payload');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ciphertext = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
