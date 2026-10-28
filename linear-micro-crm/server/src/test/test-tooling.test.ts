/**
 * Checks on the tools around the tests, so they keep finding what they were built to find:
 * - `npm run test:dates` (scripts/test-at.mjs) includes a day of 23 hours, when the UK clocks go forward.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../..'); // linear-micro-crm/

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
