/**
 * Release 1.4 — OWNED BY F payments-foundation: the one small fetch wrapper every payment adapter uses (./provider.ts).
 *
 *  - A timeout on every request (15 s by default; AbortSignal.timeout).
 *  - Retries: reads (GET, HEAD) are tried again up to twice after a network error, a 429 or a 5xx, with a short pause.
 *    A request that can move money (anything else) is NEVER retried — unless the caller passes `idempotencyKey`, which
 *    the provider uses to answer a repeat with the first answer (then it is retried like a read, with the same key).
 *  - Secrets are redacted from every error: pass the connection's secret values in `secrets` and any of them (and any
 *    `Bearer …` token) appearing in a message is replaced with "[redacted]". Bodies of failed responses are cut to
 *    300 characters before they reach an error message.
 * Errors are thrown as ProviderError with plain words ("Revolut did not answer within 15 seconds").
 */
import { ProviderError } from './provider.ts';

export const PROVIDER_TIMEOUT_MS = 15_000;
const READ_RETRIES = 2;
const RETRY_PAUSE_MS = 300;

export interface ProviderFetchOptions {
  /** The provider's name for messages ("Revolut"). */
  provider: string;
  /** Secret values to redact from errors (tokens, keys, account numbers). */
  secrets?: readonly string[];
  /** Milliseconds before the request is abandoned (default 15 000). */
  timeoutMs?: number;
  /** Makes a money-moving request safe to retry: the provider's idempotency key for it. */
  idempotencyKey?: string;
  /** Test hook: the fetch to use. */
  fetchImpl?: typeof fetch;
}

export interface ProviderResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The parsed JSON body (null when empty or not JSON). */
  json: unknown;
  text: string;
}

/** Replaces each secret (and any bearer token) in `text` with "[redacted]". */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to a provider. Answers every HTTP status (check `ok`); throws ProviderError only when no answer came
 * (timeout, network) after the retries allowed.
 */
export async function providerFetch(url: string, init: RequestInit, opts: ProviderFetchOptions): Promise<ProviderResponse> {
  const method = (init.method ?? 'GET').toUpperCase();
  const read = method === 'GET' || method === 'HEAD';
  const retries = read || opts.idempotencyKey ? READ_RETRIES : 0;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(RETRY_PAUSE_MS * attempt);
    try {
      const res = await doFetch(url, { ...init, method, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastError = new ProviderError(`${opts.provider} answered ${res.status}`, res.status);
        continue;
      }
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, ok: res.ok, headers: res.headers, json, text };
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
    }
  }
  const e = lastError as { name?: string; message?: string } | null;
  const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
  const message = timedOut
    ? `${opts.provider} did not answer within ${Math.round(timeoutMs / 1000)} seconds`
    : lastError instanceof ProviderError
      ? `${opts.provider} is not answering properly (${lastError.message.replace(`${opts.provider} `, '')})`
      : `Could not reach ${opts.provider}: ${redactSecrets(String(e?.message ?? 'network error'), opts.secrets).slice(0, 200)}`;
  throw new ProviderError(redactSecrets(message, opts.secrets), lastError instanceof ProviderError ? lastError.status : null);
}

/** A failed answer's plain message: the provider's own message when it has one, redacted and cut short. */
export function providerErrorText(res: ProviderResponse, provider: string, secrets: readonly string[] = []): string {
  const body = res.json as Record<string, unknown> | null;
  const own = body && typeof body === 'object' ? (body.message ?? body.error_description ?? body.error ?? body.detail) : null;
  const detail = typeof own === 'string' && own.trim() ? own.trim() : res.text.trim();
  return redactSecrets(`${provider} answered ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`, secrets);
}
