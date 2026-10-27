#!/usr/bin/env node
/**
 * Runs the whole test suite (npm test) as if it were another date, once per date:
 *
 *   npm run test:dates                                   four awkward moments ahead of today (below)
 *   npm run test:dates -- 2027-06-01T09:30 2028-01-01    the dates you name (UK local time unless you add Z)
 *   npm run test:dates -- business:2027-06-01T09:30      only the business clock moved (LM_BUSINESS_NOW)
 *
 * A plain date moves the computer's clock for the tests (scripts/fake-now.mjs says what that moves and what it leaves
 * alone). A date written as business:<date> leaves the computer's clock alone and moves only the business clock, as
 * LM_BUSINESS_NOW does for demos: that finds a test that mixes the two clocks.
 *
 * A test that only passes on the day it was written fails here, long before the calendar catches up with it.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shim = pathToFileURL(path.join(root, 'scripts', 'fake-now.mjs')).href;

const pad = (n) => String(n).padStart(2, '0');
const local = (d, hh, mm) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hh)}:${pad(mm)}:00`;

/** The first `weekday` (0 = Sunday) on or after `d`. */
function onOrAfter(d, weekday) {
  const x = new Date(d);
  while (x.getDay() !== weekday) x.setDate(x.getDate() + 1);
  return x;
}

/** Moments that have broken date-dependent tests before, always ahead of today so they keep finding new ones. */
function defaultRuns(today = new Date()) {
  const y = today.getFullYear();
  return [
    local(new Date(y + 1, 11, 31), 23, 45), // the last minutes of a year, late at night
    local(onOrAfter(new Date(y + 2, 0, 3), 0), 23, 30), // a Sunday night in early January: last week was last year
    local(onOrAfter(new Date(y + 1, 6, 1), 1), 0, 0), // midnight starting a summer-time Monday: "00:01 today" is ahead
    `business:${local(onOrAfter(new Date(y + 1, 2, 1), 3), 9, 30)}`, // a spring Wednesday on the business clock only
  ];
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const runs = (args.length ? args : defaultRuns()).map((arg) => {
  const businessOnly = arg.startsWith('business:');
  const at = businessOnly ? arg.slice('business:'.length) : arg;
  if (Number.isNaN(new Date(at).getTime())) {
    console.error(`Not a date: ${arg}. Use the form 2027-06-01T09:30 (or business:2027-06-01T09:30).`);
    process.exit(2);
  }
  return { at, businessOnly };
});

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];
for (const { at, businessOnly } of runs) {
  const label = businessOnly ? `${at} (business clock only)` : at;
  console.log(`\n▶ npm test with the clock at ${label} (UK time)\n`);
  const started = Date.now();
  const env = { ...process.env, TZ: 'Europe/London' };
  delete env.LM_TEST_CLOCK_OFFSET_MS; // worked out afresh for each date
  delete env.LM_TEST_FAKE_NOW;
  delete env.LM_BUSINESS_NOW;
  if (businessOnly) env.LM_BUSINESS_NOW = at;
  else Object.assign(env, { LM_TEST_FAKE_NOW: at, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${shim}`.trim() });
  const r = spawnSync(npm, ['test'], { cwd: root, env, stdio: 'inherit' });
  results.push({ label, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000), status: r.status ?? r.signal });
}

console.log('\nTests on other dates:');
for (const r of results) console.log(`  ${r.ok ? 'passed' : `FAILED (exit ${r.status})`}  ${r.label}  ${r.seconds}s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
