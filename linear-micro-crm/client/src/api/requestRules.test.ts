// When a request counts as "can't reach Linear Hub" (src/api/requestRules.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_PROBE_TIMEOUT_MS, GET_TIMEOUT_MS, RequestTimeout, fetchWithin, isGatewayFailure, requestTimeoutMs } from './requestRules.ts';

test("a proxy's 502, 503 or 504 page is no answer from the app", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(isGatewayFailure(status, null), true, `${status}, empty or not JSON`);
    assert.equal(isGatewayFailure(status, { message: 'Bad Gateway' }), true, `${status}, someone else's JSON`);
  }
});

test("the app's own errors stay the app's answer, whatever the status", () => {
  assert.equal(isGatewayFailure(503, { error: 'The payment provider is not answering. Try again in a minute.' }), false);
  assert.equal(isGatewayFailure(502, { error: 'Revolut said no' }), false);
  for (const status of [200, 400, 401, 403, 404, 409, 500, 507]) assert.equal(isGatewayFailure(status, null), false, String(status));
});

test('reads have a time limit, saves do not (a slow save may still have been made)', () => {
  assert.equal(requestTimeoutMs(undefined), GET_TIMEOUT_MS);
  assert.equal(requestTimeoutMs('GET'), GET_TIMEOUT_MS);
  assert.equal(requestTimeoutMs('get'), GET_TIMEOUT_MS);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requestTimeoutMs(m), null, m);
  assert.equal(requestTimeoutMs('GET', AUTH_PROBE_TIMEOUT_MS), AUTH_PROBE_TIMEOUT_MS, 'the sign-in check sets its own');
  assert.equal(requestTimeoutMs('GET', null), null, 'a caller can ask for no limit');
  assert.ok(AUTH_PROBE_TIMEOUT_MS < GET_TIMEOUT_MS);
});

/** A server that accepts the connection and never answers: the promise settles only when the request is aborted. */
const stalled = (_input: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const aborted = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    // like fetch: an already cancelled request fails at once
    if (init.signal?.aborted) aborted();
    else init.signal?.addEventListener('abort', aborted);
  });

test('no answer within the limit rejects with RequestTimeout, promptly', async () => {
  const started = Date.now();
  await assert.rejects(fetchWithin(stalled, '/api/auth/me', {}, 40), (e: unknown) => e instanceof RequestTimeout && e.ms === 40);
  assert.ok(Date.now() - started < 1000);
});

test("the caller's own cancel still rejects as a cancel, not as a time-out", async () => {
  const ctl = new AbortController();
  const p = fetchWithin(stalled, '/api/gauges', { signal: ctl.signal }, 5_000);
  ctl.abort();
  await assert.rejects(p, (e: unknown) => !(e instanceof RequestTimeout) && (e as Error).name === 'AbortError');
  const already = new AbortController();
  already.abort();
  await assert.rejects(fetchWithin(stalled, '/api/gauges', { signal: already.signal }, 5_000), (e: unknown) => !(e instanceof RequestTimeout));
});

test('an answer in time is passed on, and no limit is plain fetch with the caller’s own signal', async () => {
  const res = await fetchWithin(async () => new Response('{"ok":true}', { status: 200 }), '/api/x', {}, 1_000);
  assert.equal(res.status, 200);
  const ctl = new AbortController();
  let seen: AbortSignal | null | undefined;
  await fetchWithin(async (_i, init) => {
    seen = init.signal;
    return new Response(null, { status: 204 });
  }, '/api/x', { method: 'POST', signal: ctl.signal }, null);
  assert.equal(seen, ctl.signal);
  // a network failure is passed on as it is (api/client.ts turns it into a NetworkError)
  await assert.rejects(fetchWithin(async () => { throw new TypeError('Failed to fetch'); }, '/api/x', {}, 1_000), TypeError);
});
