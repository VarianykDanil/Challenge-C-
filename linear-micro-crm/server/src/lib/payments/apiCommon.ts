/**
 * Release 1.4 — OWNED BY A api-providers: what the Revolut, Wise and TrueLayer adapters share. node:crypto only (no
 * JWT or signing libraries).
 *
 *  - `paymentUuid(key)`: the provider's idempotency id for one payment, from Linear Hub's per-item key
 *    (`<batch key>:<item id>`, ./provider.ts). A name-based UUID (RFC 9562 version 5, SHA-1), so the same item always
 *    gets the same id however often it is sent: Revolut `request_id` (at most 40 characters, UUID recommended), Wise
 *    `customerTransactionId` (a UUID), TrueLayer `Idempotency-Key` (a UUID).
 *  - `signJwt` (RS256, Revolut's client assertion) and `signDetachedJws` (ES512, TrueLayer's Tl-Signature).
 *  - Plain names: `splitHolderName` (Revolut wants first and last names apart).
 *  - `guardTestNetwork`: under `node --test`, a request to a real provider host is refused before it is made, so no
 *    test ever calls the internet (tests point the adapters at local fakes, src/test/paymentApiFakes.ts).
 *  - Money: `penceToDecimal` (Revolut and Wise take pounds as a decimal number; TrueLayer takes pence).
 */
import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { ProviderError } from './provider.ts';

/** A fixed namespace for Linear Hub payment ids (random once; not a secret). */
const PAYMENT_NAMESPACE = Buffer.from('3f6c2a1e9b7d4c58a0e1f2d3c4b5a697', 'hex');

/** The same UUID (version 5) for the same item key, every time. */
export function paymentUuid(key: string): string {
  const hash = createHash('sha1').update(PAYMENT_NAMESPACE).update(key, 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** A compact JWT signed RS256 (RSASSA-PKCS1-v1_5 with SHA-256). */
export function signJwt(claims: Record<string, unknown>, key: KeyObject): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

/**
 * A JWS with detached content (RFC 7515 appendix F), ES512: `<header>..<signature>`. The signature is over
 * `<b64url(header)>.<b64url(payload)>`, in the JOSE (IEEE P1363, r‖s) format.
 */
export function signDetachedJws(header: Record<string, unknown>, payload: string, key: KeyObject): string {
  const head = b64url(JSON.stringify(header));
  const sig = cryptoSign('sha512', Buffer.from(`${head}.${b64url(payload)}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}..${b64url(sig)}`;
}

/** A PEM private key, or null when it is not one (never throws with the key in the message). */
export function readPrivateKey(pem: string | undefined): KeyObject | null {
  if (!pem || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return null;
  try {
    return createPrivateKey({ key: pem.trim(), format: 'pem' });
  } catch {
    return null;
  }
}

/** "Mary Ann O’Neill" → { first: "Mary Ann", last: "O’Neill" }; a single name is used for both. */
export function splitHolderName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? name, last: parts[0] ?? name };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/** Whole pence → pounds as a decimal number (6350 → 63.5, 123456 → 1234.56). */
export function penceToDecimal(pence: number): number {
  if (!Number.isSafeInteger(pence)) throw new RangeError('Pence must be whole numbers');
  return Math.round(pence) / 100;
}

/** Pounds as a provider's decimal → whole pence, exactly (3171.89 → 317189); null when it is not a number. */
export function decimalToPence(amount: unknown): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/** Under `node --test`, refuse a real provider host (a test must point the adapter at a local fake). */
export function guardTestNetwork(url: string, provider: string): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return;
  throw new ProviderError(`${provider}: tests never call the real provider (${host || 'no host'}); point the adapter at a local fake.`);
}

/** Text with the given values (an account number, a sort code) replaced, longest first. */
export function withoutValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...values].filter((x) => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(v).join('[hidden]');
  return out;
}

/** The first plain message in a provider's error body (several common shapes), cut short. */
export function bodyMessage(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  for (const k of ['message', 'error_description', 'detail', 'title']) {
    if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim().slice(0, 300);
  }
  if (Array.isArray(o.errors)) {
    const msgs = (o.errors as unknown[]).map((e) => (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string' ? ((e as Record<string, unknown>).message as string) : null)).filter(Boolean);
    if (msgs.length) return msgs.join(' ').slice(0, 300);
  }
  if (typeof o.error === 'string') return o.error.slice(0, 300);
  return null;
}

/** A transient failure (no answer, 429, 5xx): try again later with the same keys. */
export function isTransient(status: number | null): boolean {
  return status === null || status === 429 || status === 409 || status >= 500;
}
