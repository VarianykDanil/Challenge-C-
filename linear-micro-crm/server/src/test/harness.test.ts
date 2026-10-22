/**
 * The route-test harness itself (helpers.ts), release 1.3 integration.
 *
 * r3-contracts "1.3 routes: anonymous → 401 on every new path" failed with "fetch failed" (ECONNRESET) in the full
 * `npm test` run and passed alone. The cause: its sign-ins and its next request are separated by a long synchronous
 * test (eight demo seeds: about 4.6 s alone, about 10 s while the other test files run in parallel). The test server
 * dropped idle keep-alive sockets after 6 s (Node's keepAliveTimeout 5 s + keepAliveTimeoutBuffer 1 s), on its own
 * timer; once the event loop had been blocked past that, the server's close and the next request on the same pooled
 * socket met. The harness now keeps idle connections open until close(). This test blocks the loop the same way and
 * resumes on the first timer after it, the moment the old timer fired: with Node's default it fails every time.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestClient, type TestServer } from './helpers.ts';

let srv: TestServer;
let admin: TestClient;

before(async () => {
  srv = await startTestServer();
  admin = await srv.login('admin');
});
after(async () => {
  await srv.close();
});

test('a request right after the event loop was blocked past the old 6 s idle timeout reuses the socket safely', async () => {
  const until = performance.now() + 6_500;
  while (performance.now() < until) {
    /* a synchronous step, like a demo seed on a busy machine */
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await srv.anon().get('/pay/settings')).status, 401);
  assert.equal((await admin.get('/auth/me')).status, 200, 'the signed-in client keeps working too');
});
