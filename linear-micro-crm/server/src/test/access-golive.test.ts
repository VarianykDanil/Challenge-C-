/**
 * Going live (finding REL-6): `npm run golive` turns a trial database into the office's own. It refuses while Linear Hub
 * is running, backs up and checks the backup first, asks for GO LIVE, removes the demo company (its people, their
 * history and the records the demo seed made) and keeps the settings, the office's own people and what they made. When
 * no administrator of the office's own is left it makes the first real owner and prints their one-time setup code.
 * Running it again changes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema, isSeeded } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { goLive, planGoLive } from '../lib/goLive.ts';
import { consumeSetupCode, needsSetupCode } from '../lib/setupCodes.ts';
import { demoSignInsOn } from '../lib/demoTeams.ts';
import { trialStatus } from '../lib/trial.ts';
import { demoPeopleIds, isTrialMode, readSeedMarks } from '../lib/trialMode.ts';
import { addDays, todayISO } from '../lib/dates.ts';
import { addGauge } from './helpers.ts';

const SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const OWNER = { firstName: 'Robin', lastName: 'Ash', email: 'Robin.Ash@Office.example' };

const count = (db: Db, sql: string, params: (string | number)[] = []) => Number(get<{ n: number }>(db, sql, params)!.n);

/** What an office does in its trial: a person of its own in a demo team, their gauge on a demo event, its own campaign. */
function trialUse(db: Db) {
  const today = todayISO();
  const team = get<{ id: number }>(db, `SELECT id FROM teams WHERE name = 'Northern Lights'`)!.id;
  const kit = run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     SELECT 'LM-0500', 'kit.lane@office.example', 'Kit', 'Lane', 'rep', 'trainee', ?, pay_plan_id, ?, 'active', NULL, '#0E7490', NULL FROM users WHERE id = 1`,
    [team, today],
  ).lastInsertRowid;
  const event = get<{ id: number; date: string }>(db, `SELECT id, date FROM events WHERE team_id = ? AND date < ? ORDER BY date DESC LIMIT 1`, [team, today])!;
  addGauge(db, { eventId: event.id, userId: kit, date: event.date, stops: 20, sales: 2 });
  const campaign = run(
    db,
    `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
     VALUES ('Our Charity', 'OUR', 'charity', 'b2c', 90, 30, '#0E7490', 1, ?, NULL)`,
    [today],
  ).lastInsertRowid;
  // the trial owner (a one-tap demo account) wrote a real announcement after the seed
  const notice = run(db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES ('Welcome', 'Hello team', 1, ?, 0)`, [new Date().toISOString()])
    .lastInsertRowid;
  return { kit, team, event: event.id, campaign, notice };
}

test('goLive removes the demo company, keeps the office’s own people and records, and makes the first real owner', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    seed(db, todayISO());
    const demo = demoPeopleIds(db);
    const marks = readSeedMarks(db);
    assert.ok(demo.length > 30 && (marks.events ?? 0) > 100, 'the seed recorded its people and marks');
    const mine = trialUse(db);

    const plan = planGoLive(db);
    assert.equal(plan.trialMode, true);
    assert.equal(plan.removePeople.length, demo.length);
    assert.ok(plan.removePeople.some((p) => p.employeeId === 'LM-0001' && p.name === 'Morgan Blake'), 'the one-tap demo owner goes');
    assert.deepEqual(plan.keepPeople.map((p) => p.email), ['kit.lane@office.example']);
    assert.equal(plan.ownerNeeded, true, 'no administrator of the office’s own would be left');
    assert.ok((plan.removeRecords.events ?? 0) > 100);
    assert.throws(() => goLive(db, {}), /no administrator of your own would be left/i, 'an owner is needed');
    assert.throws(() => goLive(db, { owner: { ...OWNER, email: 'kit.lane@office.example' } }), /already used by Kit Lane/);
    assert.throws(() => goLive(db, { owner: { ...OWNER, email: 'not-an-email' } }), /email/);
    assert.equal(isTrialMode(db), true, 'a refusal changes nothing');

    const result = goLive(db, { owner: OWNER });
    // the demo company's people and their history are gone
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(demo)]), 0);
    assert.equal(result.removedPeople, demo.length);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM payroll_runs WHERE user_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(demo)]), 0);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions`), 0);
    // the records the seed made are gone, except what the office's own data hangs on
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM events WHERE id <= ?`, [marks.events!]), 1, 'only the demo event Kit logged on');
    assert.ok(get(db, `SELECT 1 FROM events WHERE id = ?`, [mine.event]));
    assert.ok(get(db, `SELECT 1 FROM teams WHERE id = ?`, [mine.team]), 'Kit’s team stays');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM teams`), 1, 'the other demo teams go');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM teams WHERE leader_id IS NOT NULL`), 0, 'no demo leader left in charge');
    assert.ok(get(db, `SELECT 1 FROM campaigns WHERE id = ?`, [mine.campaign]), 'the office’s own campaign stays');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM campaigns`), 2, 'and the one Kit’s event belongs to');
    for (const t of ['expenses', 'candidates', 'statements', 'learning_videos'] as const) {
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE id <= ?`, [marks[t] ?? 0]), 0, `${t}: the demo rows go`);
    }
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM announcements`), 1, 'only the announcement written in the trial');
    // Kit and their gauge stay
    const kit = get<{ teamId: number }>(db, `SELECT team_id AS teamId FROM users WHERE id = ?`, [mine.kit])!;
    assert.equal(kit.teamId, mine.team);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM gauge_entries WHERE user_id = ?`, [mine.kit]), 1);
    // settings stay
    assert.ok(count(db, `SELECT COUNT(*) AS n FROM pay_plans`) > 0);

    // the new owner: LM-0001 again, an administrator, signs in only with the setup code
    const owner = result.owner!;
    assert.ok(owner, 'an owner was made');
    const row = get<{ id: number; role: string; position: string; email: string; employeeId: string; name: string }>(
      db, `SELECT id, role, position, email, employee_id AS employeeId, first_name || ' ' || last_name AS name FROM users WHERE id = ?`, [owner.id],
    )!;
    assert.deepEqual({ ...row, id: 0 }, { id: 0, role: 'admin', position: 'owner', email: 'robin.ash@office.example', employeeId: 'LM-0001', name: 'Robin Ash' });
    // release check of 1.5.0: the owner's pay plan is the owner's plan, not the first plan (the trainee plan)
    assert.equal(get<{ p: string }>(db, `SELECT pp.position AS p FROM users u JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.id = ?`, [owner.id])?.p, 'owner');
    assert.match(owner.setupCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(get(db, `SELECT 1 FROM setup_codes WHERE code_hash = ?`, [owner.setupCode]), undefined, 'stored as a hash only');
    assert.equal(needsSetupCode(db, owner.id, { twoFactorEnabled: false, demoSignIn: false }), true);
    assert.equal(consumeSetupCode(db, owner.id, owner.setupCode), true);
    // the trial announcement now belongs to the owner (its author was a demo account)
    assert.equal(get<{ a: number }>(db, `SELECT author_id AS a FROM announcements WHERE id = ?`, [mine.notice])!.a, owner.id);

    // trial mode is over for good
    assert.equal(isTrialMode(db), false);
    assert.equal(trialStatus(db).trialMode, false);
    assert.equal(demoSignInsOn(db), false);
    assert.equal(isSeeded(db), true, 'the server never seeds it again');
    assert.equal(get(db, `SELECT 1 FROM meta WHERE key = 'seed_today'`), undefined);
    const audit = get<{ action: string; summary: string; userId: number | null }>(
      db, `SELECT action, summary, user_id AS userId FROM audit_log WHERE action = 'npm run golive'`,
    )!;
    assert.equal(audit.userId, null);
    assert.match(audit.summary, /^Went live from the server command: removed the demo company \(\d+ people, \d+ records\); made Robin Ash the owner; signed everyone out$/);

    // the start-up steps never put demo accounts back
    const users = count(db, `SELECT COUNT(*) AS n FROM users`);
    createSchema(db, { demoSteps: true });
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`), users);

    // again: nothing to do
    assert.equal(planGoLive(db).trialMode, false);
    assert.throws(() => goLive(db, { owner: OWNER }), /already live/);
  } finally {
    db.close();
  }
});

test('goLive keeps an administrator of the office’s own (no new owner) and removes the example starter team', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    seed(db, todayISO());
    assert.ok(get(db, `SELECT 1 FROM users WHERE email = 'ava@linearhub.example'`), 'the example starter team is there');
    const realAdmin = run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       SELECT 'LM-0600', 'sam.owner@office.example', 'Sam', 'Owner', 'admin', 'owner', NULL, pay_plan_id, ?, 'active', NULL, '#0E7490', NULL FROM users WHERE id = 1`,
      [addDays(todayISO(), -1)],
    ).lastInsertRowid;
    const plan = planGoLive(db);
    assert.equal(plan.ownerNeeded, false);
    const result = goLive(db, {});
    assert.equal(result.owner, null);
    assert.equal(get(db, `SELECT 1 FROM users WHERE email = 'ava@linearhub.example'`), undefined, 'example starters go');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`), 1);
    assert.ok(get(db, `SELECT 1 FROM users WHERE id = ?`, [realAdmin]));
    assert.deepEqual(result.notSetUp.map((p) => p.email), ['sam.owner@office.example'], 'Sam still has to finish setting up');
  } finally {
    db.close();
  }
});

// ───────────────────────────── the command ─────────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function golive(dbPath: string, port: number, args: string[], extra: Record<string, string> = {}) {
  const dir = path.dirname(dbPath);
  const r = spawnSync(process.execPath, ['src/golive.ts', ...args], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_NO_WARNINGS: '1', TZ: 'Europe/London', DB_PATH: dbPath, PORT: String(port),
      LM_BACKUP_DIR: path.join(dir, 'backups'), LM_APP_SECRET_FILE: path.join(dir, 'app-secret'), LM_STATEMENTS_DIR: path.join(dir, 'statements'), ...extra,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('npm run golive: refuses while the database is open or without GO LIVE; backs up first; prints the owner’s setup code; idempotent', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-golive-'));
  try {
    const dbPath = path.join(dir, 'linear.sqlite');
    writeFileSync(path.join(dir, 'app-secret'), 'golive-test-secret-0123456789abcdef\n', { mode: 0o600 });
    const db = openDb(dbPath);
    createSchema(db);
    seed(db, todayISO());
    const usersBefore = count(db, `SELECT COUNT(*) AS n FROM users`);
    db.close();
    // an uploaded statement PDF: the backup golive makes first holds the files too, like every other backup (1.5 keys)
    mkdirSync(path.join(dir, 'statements'), { recursive: true });
    writeFileSync(path.join(dir, 'statements', 'trial-week.pdf'), '%PDF-1.4 a statement from the trial week\n');
    const port = await freePort();
    const ownerArgs = ['--owner-email', OWNER.email, '--owner-first-name', OWNER.firstName, '--owner-last-name', OWNER.lastName];

    const missing = golive(path.join(dir, 'nope.sqlite'), port, ['--confirm', 'GO LIVE', ...ownerArgs]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /There is no database at .*nope\.sqlite/);

    // another process holds the database the way the server does
    const holder = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode = WAL'); db.prepare('SELECT COUNT(*) FROM users').get(); console.log('ready'); setInterval(() => {}, 1000);`, dbPath],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await once(holder.stdout!, 'data');
      const busy = golive(dbPath, port, ['--confirm', 'GO LIVE', ...ownerArgs]);
      assert.equal(busy.code, 1, busy.out);
      assert.match(busy.out, /open in another process/);
      assert.match(busy.out, /npm run stop/);
    } finally {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }

    const noConfirm = golive(dbPath, port, ownerArgs);
    assert.equal(noConfirm.code, 1, noConfirm.out);
    assert.match(noConfirm.out, /Nothing was changed/);
    assert.match(noConfirm.out, /--confirm "GO LIVE"/);
    const wrong = golive(dbPath, port, ['--confirm', 'go live please', ...ownerArgs]);
    assert.equal(wrong.code, 1, wrong.out);
    const noOwner = golive(dbPath, port, ['--confirm', 'GO LIVE']);
    assert.equal(noOwner.code, 1, noOwner.out);
    assert.match(noOwner.out, /--owner-email/);
    const check = openDb(dbPath);
    assert.equal(isTrialMode(check), true, 'refusals change nothing');
    assert.equal(count(check, `SELECT COUNT(*) AS n FROM users`), usersBefore);
    check.close();
    assert.equal(existsSync(path.join(dir, 'backups')), false, 'and make no backup');

    const done = golive(dbPath, port, ['--confirm', 'GO LIVE', ...ownerArgs]);
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Backed up to .*linear-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite \(checked\)/);
    assert.match(done.out, /Robin Ash/);
    const code = /one-time setup code: ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/.exec(done.out)?.[1];
    assert.ok(code, done.out);
    assert.match(done.out, /employee ID: LM-0001/);
    const backups = readdirSync(path.join(dir, 'backups')).filter((n) => n.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    const saved = openDb(path.join(dir, 'backups', backups[0]!));
    assert.equal(count(saved, `SELECT COUNT(*) AS n FROM users`), usersBefore, 'the backup holds the trial as it was');
    saved.close();
    const filesDir = path.join(dir, 'backups', backups[0]!.replace(/\.sqlite$/, '.files'));
    assert.ok(existsSync(path.join(filesDir, 'statements', 'trial-week.pdf')), `the uploaded files are in the backup too (${filesDir})`);
    const after = openDb(dbPath);
    assert.equal(isTrialMode(after), false);
    const owner = get<{ id: number }>(after, `SELECT id FROM users WHERE email = 'robin.ash@office.example'`)!;
    assert.equal(consumeSetupCode(after, owner.id, code), true, 'the printed code works once');
    assert.ok(!all(after, `SELECT 1 FROM users WHERE email LIKE '%@linearhub.example'`).length, 'no demo person left');
    after.close();

    const again = golive(dbPath, port, ['--confirm', 'GO LIVE', ...ownerArgs]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already live/);
    assert.equal(readdirSync(path.join(dir, 'backups')).filter((n) => n.endsWith('.sqlite')).length, 1, 'no second backup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
