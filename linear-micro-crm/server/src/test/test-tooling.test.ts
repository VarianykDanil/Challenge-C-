/**
 * Checks on the tools around the tests, so they keep finding what they were built to find:
 * - `npm run test:dates` (scripts/test-at.mjs) includes a day of 23 hours, when the UK clocks go forward;
 * - the CI workflow gives a Mac every extra loopback address the smoke test sends from (a Mac has only 127.0.0.1);
 * - when an address is missing, the smoke test says how to add it instead of a bare EADDRNOTAVAIL, and checks for the
 *   addresses before it starts, so a Mac gives one clear message rather than a run of failures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingAddressesMessage, missingLocalAddresses, requestVia } from './requestVia.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../..'); // linear-micro-crm/
const smokeSource = readFileSync(path.join(appRoot, 'server/src/smoke.ts'), 'utf8');
const workflowPath = [path.join(appRoot, '..', '.github/workflows/linear-hub-ci.yml'), path.join(appRoot, '.github/workflows/linear-hub-ci.yml')].find(existsSync);

/** Documentation addresses (RFC 5737) that no network card on this computer has: sending from one fails as a Mac does for 127.0.0.2. */
const ownAddresses = new Set(Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address)));
const [absentA, absentB] = ['198.51.100.71', '203.0.113.71', '192.0.2.71', '198.51.100.72', '203.0.113.72'].filter((a) => !ownAddresses.has(a));

/** Hours in a UK calendar day: 24, or 23 / 25 when the clocks change (the server test script sets TZ=Europe/London). */
function hoursIn(day: string): number {
  const start = new Date(`${day}T00:00:00`);
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return (next.getTime() - start.getTime()) / 3_600_000;
}

test('npm run test:dates runs, by default, on a day when the clocks go forward, and every default moment is ahead', () => {
  const r = spawnSync(process.execPath, ['scripts/test-at.mjs', '--list'], { cwd: appRoot, encoding: 'utf8', env: { ...process.env, TZ: 'Europe/London' } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const moments = r.stdout.trim().split('\n').map((line) => line.trim().replace(/^business:/, ''));
  assert.ok(moments.length >= 4, r.stdout);
  for (const m of moments) assert.ok(new Date(m).getTime() > Date.now(), `${m} is ahead of now`);
  const days = moments.map((m) => m.slice(0, 10));
  assert.ok(days.some((d) => hoursIn(d) === 23), `one default moment falls on a 23-hour day: ${days.join(', ')}`);
});

test('the CI workflow gives a Mac every loopback address the smoke test sends from, before the smoke test runs', (t) => {
  if (!workflowPath) return t.skip('no CI workflow next to the app');
  const used = [...new Set([...smokeSource.matchAll(/'(127\.0\.0\.\d+)'/g)].map((m) => m[1]!))].filter((a) => a !== '127.0.0.1');
  assert.ok(used.length > 0, 'the smoke test acts as other devices from extra loopback addresses');
  const workflow = readFileSync(workflowPath, 'utf8');
  const verify = workflow.slice(workflow.indexOf('\n  verify:'), workflow.indexOf('\n  audit:'));
  assert.match(verify, /os: \[[^\]]*macos-latest/, 'the verify job runs on a Mac');
  const smokeAt = verify.indexOf('npm run smoke -w server');
  assert.ok(smokeAt > 0, 'the verify job runs the smoke test');
  const aliasStep = verify.slice(0, smokeAt).split('\n      - ').find((step) => step.includes('ifconfig lo0 alias'));
  assert.ok(aliasStep, 'a step before the smoke test adds the loopback aliases');
  assert.match(aliasStep, /if: runner\.os == 'macOS'/, 'only on a Mac (Linux has the whole 127.x range already)');
  for (const a of used) assert.ok(aliasStep.includes(`sudo ifconfig lo0 alias ${a} up`), `the alias step adds ${a}`);
});

test('requestVia sends from the address it is given, and names the command that adds an address this computer lacks', async () => {
  const server = http.createServer((req, res) => res.end(req.socket.remoteAddress ?? ''));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const ok = await requestVia('127.0.0.1', 'GET', url, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.text, '127.0.0.1');
    const missing = await requestVia(absentA!, 'GET', url, {}).then(
      () => assert.fail('a request from an address this computer lacks cannot succeed'),
      (err: unknown) => err as Error & { cause?: { code?: string } },
    );
    assert.equal(missing.cause?.code, 'EADDRNOTAVAIL', String(missing));
    assert.ok(missing.message.startsWith(`Cannot send from ${absentA}: this computer does not have that address.`), missing.message);
    assert.ok(missing.message.includes(`sudo ifconfig lo0 alias ${absentA} up`), missing.message);
    assert.ok(missing.message.length <= 300, `fits the smoke test's FAIL line (${missing.message.length} characters)`);
  } finally {
    server.close();
  }
});

test('missingLocalAddresses finds the addresses this computer lacks, and the message gives the command for each', async () => {
  assert.deepEqual(await missingLocalAddresses(['127.0.0.1', absentA!, absentB!]), [absentA, absentB]);
  assert.deepEqual(await missingLocalAddresses(['127.0.0.1']), []);
  const message = missingAddressesMessage(['127.0.0.2', '127.0.0.3']);
  assert.match(message, /127\.0\.0\.2 and 127\.0\.0\.3/);
  assert.match(message, /sudo ifconfig lo0 alias 127\.0\.0\.2 up && sudo ifconfig lo0 alias 127\.0\.0\.3 up/);
  assert.match(message, /npm run smoke/);
});

test('the smoke test checks for every extra address it sends from before any check runs', () => {
  const used = [...new Set([...smokeSource.matchAll(/'(127\.0\.0\.\d+)'/g)].map((m) => m[1]!))].filter((a) => a !== '127.0.0.1');
  const call = /await missingLocalAddresses\(\[([^\]]*)\]\)/.exec(smokeSource);
  assert.ok(call, 'smoke.ts calls missingLocalAddresses');
  for (const a of used) assert.ok(call[1]!.includes(`'${a}'`), `the start-up check includes ${a}`);
  assert.ok(call.index < smokeSource.lastIndexOf('main().catch'), 'before main() runs');
});
