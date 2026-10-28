/**
 * Going live after a trial week (review of REL-6). The owner tried Linear Hub on a 1.4 demo database: as the demo owner
 * and as a real administrator added in the trial, they made real records (a candidate, an announcement, an expense,
 * statements, a client ID on a demo campaign, a pay rate). The first start of 1.5 puts that database in trial mode, and
 * `npm run golive` must keep every one of those records and anything of the demo they hang on, remove the rest of the
 * demo company, and say what it keeps and why. A fresh 1.5 trial follows the same rules.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { goLive, planGoLive } from '../lib/goLive.ts';
import { sessionKey } from '../lib/sessionKey.ts';
import { configureStatementsDir, saveStatementFile, statementFilePath } from '../lib/statements/files.ts';
import { demoPeopleIds, isTrialMode, readSeedMarks } from '../lib/trialMode.ts';
import { setBusinessClock } from '../lib/dates.ts';

const TODAY = '2026-10-21';
const SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const count = (db: Db, sql: string, params: (string | number)[] = []) => Number(get<{ n: number }>(db, sql, params)!.n);
const idOf = (db: Db, sql: string, params: (string | number)[] = []) => get<{ id: number }>(db, sql, params)!.id;
const exists = (db: Db, table: string, id: number) => Boolean(get(db, `SELECT 1 FROM ${table} WHERE id = ?`, [id]));

let statementsDir = '';
before(() => {
  setBusinessClock(new Date(`${TODAY}T15:00:00`));
  statementsDir = mkdtempSync(path.join(os.tmpdir(), 'linear-golive-statements-'));
  configureStatementsDir(statementsDir);
});
after(() => {
  setBusinessClock(null);
  configureStatementsDir(null);
  rmSync(statementsDir, { recursive: true, force: true });
});

/** A demo database as the 1.4 seed left it: no trial-mode keys, no setup codes, session tokens stored as they are. */
function make14(db: Db): void {
  createSchema(db);
  seed(db, TODAY);
  run(db, `DELETE FROM meta WHERE key LIKE 'ext:access:%'`);
  run(db, `DROP TABLE setup_codes`);
  run(db, `ALTER TABLE users DROP COLUMN setup_code_required`);
}

/** An audit row as the app writes it for a request. */
function audit(db: Db, at: string, userId: number | null, action: string, entity: string | null, entityId: number | null, kind = 'change') {
  run(db, `INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    at, userId, action, entity, entityId, action, kind,
  ]);
}

function addPerson(db: Db, p: { employeeId: string; email: string; first: string; last: string; role: string; position: string; teamId: number | null }) {
  return run(
    db,
    `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
     SELECT ?, ?, ?, ?, ?, ?, ?, pay_plan_id, ?, 'active', NULL, '#0E7490', NULL FROM users WHERE id = 1`,
    [p.employeeId, p.email, p.first, p.last, p.role, p.position, p.teamId, TODAY],
  ).lastInsertRowid;
}

interface TrialWeek {
  robin: number;
  casey: number;
  avery: number;
  notice: number;
  expense: number;
  uploaded: number;
  mailed: number;
  rate: number;
  bcn: number;
  chn: number;
  vlt: number;
  fcb: number;
  keptByRobin: number;
  playedWith: number;
  robinToken: string;
  files: string[];
}

/** The owner's trial week on 1.4, written the way 1.4 wrote it (rows plus the audit trail of each request). */
function trialWeek(db: Db): TrialWeek {
  const seededAt = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'seeded_at'`)!.value;
  const at = (hours: number) => new Date(Date.parse(seededAt) + hours * 3_600_000).toISOString();
  const campaign = (code: string) => idOf(db, `SELECT id FROM campaigns WHERE code = ?`, [code]);
  const [bcn, chn, vlt, fcb] = ['BCN', 'CHN', 'VLT', 'FCB'].map(campaign) as [number, number, number, number];
  const team = idOf(db, `SELECT id FROM teams WHERE name = 'Northern Lights'`);

  // the demo owner (LM-0001, id 1) adds a real administrator and a real rep
  const robin = addPerson(db, { employeeId: 'LM-0201', email: 'robin.realperson@office.example', first: 'Robin', last: 'Realperson', role: 'admin', position: 'assistant_owner', teamId: null });
  audit(db, at(1), 1, 'POST /users', 'user', robin);
  const casey = addPerson(db, { employeeId: 'LM-0202', email: 'casey.realrep@office.example', first: 'Casey', last: 'Realrep', role: 'rep', position: 'field_rep', teamId: team });
  audit(db, at(1), 1, 'POST /users', 'user', casey);
  // 1.4 kept the session token itself
  const robinToken = 'a'.repeat(64);
  run(db, `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
    robinToken, robin, at(2), new Date(Date.parse(at(2)) + 14 * 3_600_000 * 24).toISOString(), at(2),
  ]);

  // real records the demo owner made
  const avery = run(
    db,
    `INSERT INTO candidates (first_name, last_name, email, source, stage, position_applied, applied_at, stage_updated_at, owner_id, next_action)
     VALUES ('Avery', 'Applicant', 'avery.applicant@office.example', 'other', 'applied', 'trainee', ?, ?, 1, 'Phone screen')`,
    [at(3), at(3)],
  ).lastInsertRowid;
  audit(db, at(3), 1, 'POST /recruitment/candidates', 'candidate', avery);
  const notice = run(db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES ('Real office note', 'Team meeting on Friday at 9.', 1, ?, 0)`, [at(4)])
    .lastInsertRowid;
  audit(db, at(4), 1, 'POST /announcements', 'announcement', notice);
  const expense = run(db, `INSERT INTO expenses (date, category, amount, description, campaign_id, event_id) VALUES (?, 'travel', 42.5, 'Real train tickets', NULL, NULL)`, [TODAY])
    .lastInsertRowid;
  audit(db, at(5), 1, 'POST /finance/expenses', 'expense', expense);
  // Casey's client ID at a demo campaign (BCN)
  run(db, `INSERT INTO user_client_refs (user_id, campaign_id, ref) VALUES (?, ?, 'BCN-CASEY-01')`, [casey, bcn]);
  audit(db, at(6), 1, 'PUT /statements/client-refs/:userId', 'user', casey);

  // the real administrator uploads a statement for CHN, and the mail check brings one in (no audit row)
  const pdfA = saveStatementFile(db, new TextEncoder().encode('%PDF-1.4 real CHN statement, uploaded'));
  const uploaded = run(
    db,
    `INSERT INTO statements (campaign_id, source, received_at, file_path, file_name, file_sha256, status) VALUES (?, 'upload', ?, ?, 'chn-october.pdf', ?, 'parsed')`,
    [chn, at(7), pdfA.relPath, pdfA.sha256],
  ).lastInsertRowid;
  audit(db, at(7), robin, 'POST /statements/upload', 'statement', uploaded);
  const pdfB = saveStatementFile(db, new TextEncoder().encode('%PDF-1.4 real CHN statement, by email'));
  const mailed = run(
    db,
    `INSERT INTO statements (campaign_id, source, message_id, received_at, file_path, file_name, file_sha256, status) VALUES (?, 'email', '<real-1@chn.example>', ?, ?, 'chn-week.pdf', ?, 'parsed')`,
    [chn, at(8), pdfB.relPath, pdfB.sha256],
  ).lastInsertRowid;
  // the real administrator sets a new rate on a demo campaign (VLT)
  const rate = run(
    db,
    `INSERT INTO campaign_rates (campaign_id, rep_rate, payout_rate, effective_from, source, approved_by, client_post_id, created_at) VALUES (?, 40, 160, ?, 'admin', ?, NULL, ?)`,
    [vlt, TODAY, robin, at(9)],
  ).lastInsertRowid;
  audit(db, at(9), robin, 'POST /pay/rates', 'campaign_rate', rate);

  // a demo candidate the real administrator works on, and one the owner only played with as the demo owner
  const keptByRobin = idOf(db, `SELECT id FROM candidates WHERE id < ? ORDER BY id LIMIT 1`, [avery]);
  audit(db, at(10), robin, 'PATCH /recruitment/candidates/:id', 'candidate', keptByRobin);
  const playedWith = idOf(db, `SELECT id FROM candidates WHERE id > ? AND id < ? ORDER BY id LIMIT 1`, [keptByRobin, avery]);
  audit(db, at(11), 1, 'POST /recruitment/candidates/:id/stage', 'candidate', playedWith);
  // a sign-in and a look at a record are not changes
  audit(db, at(12), 2, 'POST /auth/login', 'user', 2, 'sign_in');
  audit(db, at(12), 2, 'POST /audit/events', 'candidate', keptByRobin + 2, 'opened');

  return {
    robin, casey, avery, notice, expense, uploaded, mailed, rate, bcn, chn, vlt, fcb, keptByRobin, playedWith, robinToken,
    files: [pdfA.relPath, pdfB.relPath],
  };
}

test('a 1.4 demo database used for a trial week: the upgrade puts it in trial mode with seed marks below every record made in the trial', () => {
  const db = openDb(':memory:');
  try {
    make14(db);
    const week = trialWeek(db);
    createSchema(db); // the first start of 1.5

    assert.equal(isTrialMode(db), true);
    const demo = new Set(demoPeopleIds(db));
    assert.ok(demo.has(1) && demo.has(34), 'the seed’s staff are the demo company');
    for (const id of [week.robin, week.casey]) assert.equal(demo.has(id), false, 'people added in the trial are the office’s own');
    const marks = readSeedMarks(db);
    assert.ok((marks.candidates ?? 0) < week.avery, `candidates mark ${marks.candidates} is below Avery (${week.avery})`);
    assert.ok((marks.announcements ?? 0) < week.notice, 'announcements mark below the trial announcement');
    assert.ok((marks.expenses ?? 0) < week.expense, 'expenses mark below the trial expense');
    assert.ok((marks.statements ?? 0) < week.uploaded, 'statements mark below the uploaded statement');
    assert.ok((marks.statements ?? 0) < week.mailed, 'and below the one the mail check brought (no audit row: its received time tells)');
    assert.ok((marks.candidates ?? 0) >= week.playedWith, 'a demo candidate changed in the trial is still a demo row');
    // nobody signed out: the stored token is now the hash of the cookie
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE token = ?`, [week.robinToken]), 0);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE token = ?`, [sessionKey(week.robinToken)]), 1);
  } finally {
    db.close();
  }
});

test('golive after a 1.4 trial week keeps every record made in the trial and the demo records they hang on, and says why', () => {
  const db = openDb(':memory:');
  try {
    make14(db);
    const week = trialWeek(db);
    createSchema(db);
    const demo = demoPeopleIds(db);

    const plan = planGoLive(db);
    assert.equal(plan.ownerNeeded, false, 'Robin is an administrator of the office’s own');
    // the plan names the demo accounts that were used in the trial
    const owner = plan.usedDemoPeople.find((p) => p.employeeId === 'LM-0001');
    assert.ok(owner, 'the demo owner was used in the trial');
    assert.ok(owner.changes >= 6, `the demo owner made ${owner.changes} changes`);
    assert.equal(plan.usedDemoPeople.some((p) => p.employeeId === 'LM-0002'), true, 'a sign-in counts as use');
    // and the demo records it keeps, with the reason
    const kept = (table: string, id: number) => plan.keptDemoRecords.find((r) => r.table === table && r.id === id);
    assert.match(kept('campaigns', week.bcn)?.reason ?? '', /client ID.*Casey Realrep/);
    assert.match(kept('campaigns', week.bcn)?.label ?? '', /Breast Cancer Now \(BCN\)/);
    assert.match(kept('campaigns', week.chn)?.reason ?? '', /statement/);
    assert.match(kept('campaigns', week.vlt)?.reason ?? '', /pay rate.*Robin Realperson/);
    assert.match(kept('candidates', week.keptByRobin)?.reason ?? '', /changed by Robin Realperson/);
    assert.equal(kept('campaigns', week.fcb), undefined);
    // demo records only the demo accounts touched go, and are listed
    assert.ok(plan.removedUsedRecords.some((r) => r.table === 'candidates' && r.id === week.playedWith));
    assert.equal(plan.removedUsedRecords.some((r) => r.table === 'candidates' && r.id === week.keptByRobin + 2), false, 'a look is not a change');

    const result = goLive(db, {});
    assert.equal(result.owner, null);
    // everything made in the trial week stays
    for (const [table, id] of [
      ['candidates', week.avery], ['announcements', week.notice], ['expenses', week.expense], ['statements', week.uploaded],
      ['statements', week.mailed], ['campaign_rates', week.rate], ['candidates', week.keptByRobin],
    ] as const) {
      assert.ok(exists(db, table, id), `${table} #${id} stays`);
    }
    assert.equal(get<{ ref: string }>(db, `SELECT ref FROM user_client_refs WHERE user_id = ?`, [week.casey])?.ref, 'BCN-CASEY-01', 'Casey keeps the client ID');
    for (const id of [week.bcn, week.chn, week.vlt]) assert.ok(exists(db, 'campaigns', id), `campaign #${id} stays`);
    assert.equal(exists(db, 'campaigns', week.fcb), false, 'a demo campaign nothing of the office uses goes');
    assert.equal(exists(db, 'candidates', week.playedWith), false, 'a demo candidate only the demo accounts touched goes');
    // the trial announcement passes to the office's administrator (its author was the demo owner)
    assert.equal(get<{ a: number }>(db, `SELECT author_id AS a FROM announcements WHERE id = ?`, [week.notice])!.a, week.robin);
    // the demo company's people are gone; the office's own stay, signed out: Robin's 1.4 session (made with his email
    // and employee ID only) must not outlive the trial, or it could set up two-step without a setup code
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(demo)]), 0);
    assert.ok(exists(db, 'users', week.robin) && exists(db, 'users', week.casey));
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE token = ?`, [sessionKey(week.robinToken)]), 0);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions`), 0, 'everyone signs in again under the live rules');
    // statement files are never deleted (they are not in the database backup)
    for (const f of week.files) assert.ok(existsSync(statementFilePath(db, f)!), `${f} is still on disk`);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM statements`), 2, 'the demo statements went');
  } finally {
    db.close();
  }
});

test('golive makes an owner for the person going live when asked, even though a colleague they added stays an administrator', () => {
  const db = openDb(':memory:');
  try {
    make14(db);
    const week = trialWeek(db);
    createSchema(db);
    assert.equal(planGoLive(db).ownerNeeded, false);
    const result = goLive(db, { owner: { firstName: 'Sam', lastName: 'Owner', email: 'sam.owner@office.example' } });
    assert.equal(result.owner?.employeeId, 'LM-0001', 'the demo owner’s employee ID is free again');
    assert.equal(get<{ role: string }>(db, `SELECT role FROM users WHERE id = ?`, [result.owner!.id])?.role, 'admin');
    assert.equal(get<{ role: string }>(db, `SELECT role FROM users WHERE id = ?`, [week.robin])?.role, 'admin', 'the colleague stays an administrator');
  } finally {
    db.close();
  }
});

test('a fresh 1.5 trial: a demo campaign stays while a person of the office’s own has a client ID or a statement on it', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    seed(db, TODAY);
    const ids = Object.fromEntries(['BCN', 'CHN', 'VLT', 'FCB'].map((code) => [code, idOf(db, `SELECT id FROM campaigns WHERE code = ?`, [code])]));
    const campaign = (code: string) => ids[code]!;
    const kit = addPerson(db, { employeeId: 'LM-0500', email: 'kit.lane@office.example', first: 'Kit', last: 'Lane', role: 'rep', position: 'trainee', teamId: null });
    run(db, `INSERT INTO user_client_refs (user_id, campaign_id, ref) VALUES (?, ?, 'FCB-KIT')`, [kit, campaign('FCB')]);
    run(db, `INSERT INTO sale_confirmations (user_id, campaign_id, week_start, confirmed, statement_id, confirmed_at) VALUES (?, ?, '2026-10-12', 3, NULL, ?)`, [
      kit, campaign('CHN'), new Date().toISOString(),
    ]);
    // a statement the demo owner uploaded in the trial, on a demo campaign
    const statement = run(db, `INSERT INTO statements (campaign_id, source, received_at, file_name, status) VALUES (?, 'upload', ?, 'vlt.pdf', 'parsed')`, [
      campaign('VLT'), new Date().toISOString(),
    ]).lastInsertRowid;
    goLive(db, { owner: { firstName: 'Sam', lastName: 'Owner', email: 'sam.owner@office.example' } });
    assert.ok(exists(db, 'campaigns', campaign('FCB')), 'Kit’s client ID keeps FCB');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM user_client_refs WHERE user_id = ?`, [kit]), 1);
    assert.ok(exists(db, 'campaigns', campaign('CHN')), 'Kit’s confirmed sales keep CHN');
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM sale_confirmations WHERE user_id = ?`, [kit]), 1);
    assert.ok(exists(db, 'statements', statement));
    assert.ok(exists(db, 'campaigns', campaign('VLT')), 'the trial statement keeps VLT');
    assert.equal(exists(db, 'campaigns', campaign('BCN')), false, 'BCN is only the demo’s: it goes');
    // seed reads by the office's own people never keep a demo announcement
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM announcements`), 0);
  } finally {
    db.close();
  }
});

test('npm run golive lists the demo accounts used in the trial and the demo records it keeps, and never says it keeps what it removes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-golive-14-'));
  try {
    const dbPath = path.join(dir, 'linear.sqlite');
    writeFileSync(path.join(dir, 'app-secret'), 'golive-test-secret-0123456789abcdef\n', { mode: 0o600 });
    const db = openDb(dbPath);
    configureStatementsDir(path.join(dir, 'statements'));
    make14(db);
    const week = trialWeek(db);
    db.close();
    configureStatementsDir(statementsDir);

    const r = spawnSync(process.execPath, ['src/golive.ts', '--confirm', 'GO LIVE'], {
      cwd: SERVER_DIR,
      encoding: 'utf8',
      env: {
        ...process.env, NODE_NO_WARNINGS: '1', TZ: 'Europe/London', DB_PATH: dbPath, PORT: '1',
        LM_BACKUP_DIR: path.join(dir, 'backups'), LM_APP_SECRET_FILE: path.join(dir, 'app-secret'), LM_STATEMENTS_DIR: path.join(dir, 'statements'),
      },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /Used during the trial/);
    assert.match(out, /Morgan Blake \(LM-0001, admin\): \d+ changes/);
    assert.match(out, /demo records stay because something of yours uses them/i);
    assert.match(out, /Breast Cancer Now \(BCN\): client ID of Casey Realrep/);
    assert.match(out, /Changed during the trial but only by demo accounts, so they go/);
    assert.doesNotMatch(out, /everything made\s+in the app since the demo was set up/);
    const after = openDb(dbPath);
    assert.ok(exists(after, 'candidates', week.avery));
    assert.ok(exists(after, 'statements', week.uploaded));
    assert.equal(all(after, `SELECT 1 FROM user_client_refs WHERE user_id = ?`, [week.casey]).length, 1);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
