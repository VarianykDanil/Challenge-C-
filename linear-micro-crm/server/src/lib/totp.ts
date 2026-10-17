/**
 * Pure TOTP (RFC 6238) on top of HOTP (RFC 4226) with Node's `crypto` only: SHA-1, 6 digits, 30-second step —
 * the profile every authenticator app (Google/Microsoft Authenticator, 1Password, Authy) supports. Secrets are
 * base32 (RFC 4648, no padding) because that is what the apps and the `otpauth://` URI format expect.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, without `=` padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 leniently: case-insensitive, ignores spaces, hyphens and `=` padding. Throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s\-=]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret (the RFC 4226 recommended length), base32 without padding → 32 characters. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  /** Unix time in milliseconds (defaults to now). */
  timeMs?: number;
  /** Step length in seconds (30). */
  step?: number;
  /** Number of digits (6). */
  digits?: number;
}

/** HOTP (RFC 4226): HMAC-SHA1 of the 8-byte big-endian counter, dynamically truncated to `digits` decimals. */
export function hotp(secret: Uint8Array, counter: number | bigint, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', Buffer.from(secret)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function secretBytes(secret: string | Uint8Array): Buffer {
  return typeof secret === 'string' ? base32Decode(secret) : Buffer.from(secret);
}

/** The time-step counter for `timeMs` (T = floor(unixSeconds / step)). */
export function totpCounter(timeMs: number, step = 30): number {
  return Math.floor(timeMs / 1000 / step);
}

/** TOTP (RFC 6238) for a base32 secret (or raw bytes) at `timeMs` (default now). */
export function totp(secret: string | Uint8Array, opts: TotpOptions = {}): string {
  const { timeMs = Date.now(), step = 30, digits = 6 } = opts;
  return hotp(secretBytes(secret), totpCounter(timeMs, step), digits);
}

/** Strips whitespace from a typed code; the result must be exactly `digits` decimals to be a candidate at all. */
export function normaliseCode(code: string, digits = 6): string | null {
  const clean = code.replace(/\s+/g, '');
  return new RegExp(`^\\d{${digits}}$`).test(clean) ? clean : null;
}

/**
 * Checks `code` against the secret for the current step and `window` steps either side (±1 by default — a slow
 * clock or a code typed just before it rolled over) and returns the time-step counter it matched, or `null`.
 * Callers persist the returned counter and refuse any later code whose counter is not greater (RFC 6238 §5.2:
 * a code is accepted once). Every candidate is compared in constant time and every step is checked whatever the
 * outcome, so timing says nothing about which step (if any) matched.
 */
export function matchTotpCounter(secret: string | Uint8Array, code: string, opts: TotpOptions & { window?: number } = {}): number | null {
  const { timeMs = Date.now(), step = 30, digits = 6, window = 1 } = opts;
  const clean = normaliseCode(code, digits);
  if (clean === null) return null;
  const bytes = secretBytes(secret);
  const given = Buffer.from(clean, 'utf8');
  const centre = totpCounter(timeMs, step);
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const counter = centre + delta;
    if (counter < 0) continue;
    const candidate = Buffer.from(hotp(bytes, counter, digits), 'utf8');
    if (timingSafeEqual(candidate, given)) matched = counter;
  }
  return matched;
}

/** True when `code` is valid for the secret right now (±`window` steps); see `matchTotpCounter`. */
export function verifyTotp(secret: string | Uint8Array, code: string, opts: TotpOptions & { window?: number } = {}): boolean {
  return matchTotpCounter(secret, code, opts) !== null;
}

export interface OtpauthParams {
  /** The service name shown in the app, e.g. "Linear Hub". */
  issuer: string;
  /** The account label, conventionally `<issuer>:<account>`, e.g. "Linear Hub:jane@example.com". */
  label: string;
  /** Base32 secret. */
  secret: string;
  digits?: number;
  period?: number;
}

/**
 * The `otpauth://totp/...` key URI understood by authenticator apps (Google's Key URI format). The label's
 * `issuer:account` colon is kept literal — every major app accepts it and some display it better than `%3A`.
 */
export function otpauthUrl({ issuer, label, secret, digits = 6, period = 30 }: OtpauthParams): string {
  const encodedLabel = encodeURIComponent(label).replace(/%3A/gi, ':');
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  // URLSearchParams encodes spaces as '+', which some apps read literally; use %20 like the apps themselves do.
  return `otpauth://totp/${encodedLabel}?${params.toString().replace(/\+/g, '%20')}`;
}
