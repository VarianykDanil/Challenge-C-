#!/usr/bin/env node
// Retakes the screenshots in this folder (the ones README.md shows) from a running Linear Hub, so they always show
// the current release. Run it after every release that changes these screens.
//
//   1. Start Linear Hub on a fresh demo database (trial mode, demo sign-ins on), for example in a scratch folder:
//        DB_PATH=/tmp/lh-shots/linear.sqlite LM_APP_SECRET_FILE=/tmp/lh-shots/app-secret \
//        LM_UPLOADS_DIR=/tmp/lh-shots/uploads LM_STATEMENTS_DIR=/tmp/lh-shots/statements \
//        LM_BUSINESS_NOW=2026-10-27T11:30:00Z PORT=4300 npm start
//   2. node docs/screenshots/take-screenshots.mjs http://127.0.0.1:4300 [output folder]
//
// Needs Playwright with Chromium, which is not one of Linear Hub's dependencies: install it once outside the project
// (npm install -g playwright && npx playwright install chromium) and point PLAYWRIGHT_MODULE at it, e.g.
// PLAYWRIGHT_MODULE="$(npm root -g)/playwright". The demo company is invented, so the pictures hold no real person.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const base = (process.argv[2] ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const out = path.resolve(process.argv[3] ?? path.dirname(new URL(import.meta.url).pathname));
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.error('Playwright is not installed. Install it once, outside the project:');
  console.error('  npm install -g playwright && npx playwright install chromium');
  console.error('then run:  PLAYWRIGHT_MODULE="$(npm root -g)/playwright" node docs/screenshots/take-screenshots.mjs <address>');
  process.exit(1);
}

/** Each picture: the file, who is signed in (a demo account's role; none for the sign-in page), the page, the theme. */
const SHOTS = [
  { file: 'login.png', role: null, path: '/login', dark: false },
  { file: 'dashboard.png', role: 'leader', path: '/', dark: false },
  { file: 'dashboard-dark.png', role: 'leader', path: '/', dark: true },
  { file: 'events.png', role: 'leader', path: '/events', dark: false },
  { file: 'gauges.png', role: 'leader', path: '/gauges', dark: false },
  { file: 'leaderboard.png', role: 'leader', path: '/leaderboard', dark: false },
  { file: 'recruitment.png', role: 'recruiter', path: '/recruitment', dark: false },
  { file: 'finance.png', role: 'admin', path: '/finance', dark: false },
  { file: 'team.png', role: 'admin', path: '/team', dark: false },
];

async function signIn(context, role) {
  const res = await context.request.get(`${base}/api/auth/demo-accounts`);
  if (!res.ok()) throw new Error(`GET /api/auth/demo-accounts answered ${res.status()}: is this a demo database in trial mode?`);
  const { accounts = [] } = await res.json();
  const account = accounts.find((a) => a.role === role);
  if (!account) throw new Error(`No demo account with the role ${role}: start the server on a fresh demo database.`);
  const login = await context.request.post(`${base}/api/auth/login`, { data: { email: account.email, employeeId: account.employeeId } });
  if (!login.ok()) throw new Error(`Signing in as the demo ${role} answered ${login.status()}.`);
}

/** Closes the Needs attention pop-ups so they do not cover the page. */
async function dismissToasts(page) {
  for (let i = 0; i < 8; i++) {
    const button = page.getByRole('button', { name: /Dismiss notification/i });
    if (!(await button.count())) return;
    await button.first().click().catch(() => {});
    await page.waitForTimeout(150);
  }
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let failed = 0;
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: shot.dark ? 'dark' : 'light' });
    await context.addInitScript((theme) => { try { localStorage.setItem('lm-theme', theme); } catch { /* private mode */ } }, shot.dark ? 'dark' : 'light');
    try {
      if (shot.role) await signIn(context, shot.role);
      const page = await context.newPage();
      await page.goto(base + shot.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200); // charts finish drawing
      await dismissToasts(page);
      await page.screenshot({ path: path.join(out, shot.file) });
      console.log(`✔ ${shot.file}  (${shot.role ?? 'signed out'}, ${shot.path}${shot.dark ? ', dark' : ''})`);
    } catch (e) {
      failed++;
      console.error(`✖ ${shot.file}: ${e instanceof Error ? e.message : e}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} of ${SHOTS.length} failed.` : `All ${SHOTS.length} screenshots saved in ${out}.`);
process.exit(failed ? 1 : 0);
