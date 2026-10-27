/**
 * The server commands around sign-in and the demo (findings REL-2, SEC-4):
 *  - `npm run seed` never wipes a database that has gone live or holds people of the office's own, never while Linear
 *    Hub has it open, and only after a typed START AGAIN and a checked backup;
 *  - `npm run setup-code -- <email>` gives someone a one-time setup code from the server itself;
 *  - `npm run 2fa:reset` and `npm run pin:reset` print the setup code the person then needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { get, openDb, run, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { goLive } from '../lib/goLive.ts';
import { consumeSetupCode } from '../lib/setupCodes.ts';
import { todayISO } from '../lib/dates.ts';
import { buildFixture, FIXTURE_ACCOUNTS } from './helpers.ts';

const SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const CODE_RE = /([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/;

const count = (db: Db, sql: string, params: (string | number)[] = []) => Number(get<{ n: number }>(db, sql, params)!.n);

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

function command(script: string, dbPath: string, args: string[], port = 1) {
  const dir = path.dirname(dbPath);
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_NO_WARNINGS: '1', TZ: 'Europe/London', DB_PATH: dbPath, PORT: String(port),
      LM_BACKUP_DIR: path.join(dir, 'backups'), LM_APP_SECRET_FILE: path.join(dir, 'app-secret'), LM_STATEMENTS_DIR: path.join(dir, 'statements'),
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('npm run seed: a new database straight away; an existing trial only after START AGAIN and a backup; never a live one or one with the office’s own people', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-seed-guard-'));
  try {
    const dbPath = path.join(dir, 'linear.sqlite');
    writeFileSync(path.join(dir, 'app-secret'), 'seed-guard-test-secret-0123456789ab\n', { mode: 0o600 });
    const port = await freePort();
    const seedCmd = (args: string[] = []) => command('src/db/seed.ts', dbPath, args, port);

    const fresh = seedCmd();
    assert.equal(fresh.code, 0, fresh.out);
    assert.match(fresh.out, /Seeded .*linear\.sqlite/);

    // something done in the trial, to see whether a refusal kept it
    const mark = () => {
      const db = openDb(dbPath);
      try {
        return get<{ title: string }>(db, `SELECT title FROM announcements ORDER BY id DESC LIMIT 1`)!.title;
      } finally {
        db.close();
      }
    };
    let db = openDb(dbPath);
    run(db, `INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES ('Trial note', 'x', 1, ?, 0)`, [new Date().toISOString()]);
    db.close();

    const noConfirm = seedCmd();
    assert.equal(noConfirm.code, 1, noConfirm.out);
    assert.match(noConfirm.out, /Nothing was changed/);
    assert.match(noConfirm.out, /--confirm "START AGAIN"/);
    assert.equal(mark(), 'Trial note');

    // the server has it open
    const holder = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode = WAL'); db.prepare('SELECT COUNT(*) FROM users').get(); console.log('ready'); setInterval(() => {}, 1000);`, dbPath],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await once(holder.stdout!, 'data');
      const busy = seedCmd(['--confirm', 'START AGAIN']);
      assert.equal(busy.code, 1, busy.out);
      assert.match(busy.out, /open in another process/);
    } finally {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }
    assert.equal(mark(), 'Trial note');

    const again = seedCmd(['--confirm', 'START AGAIN']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Backed up to .*\(checked\)/);
    assert.notEqual(mark(), 'Trial note', 'seeded afresh');
    assert.equal(readdirSync(path.join(dir, 'backups')).filter((n) => n.endsWith('.sqlite')).length, 1);

    // a person of the office's own (added in the trial): refused even with the words
    db = openDb(dbPath);
    run(
      db,
      `INSERT INTO users (employee_id, email, first_name, last_name, role, position, team_id, pay_plan_id, start_date, status, phone, avatar_color, city)
       SELECT 'LM-0500', 'kit.lane@office.example', 'Kit', 'Lane', 'rep', 'trainee', NULL, pay_plan_id, ?, 'active', NULL, '#0E7490', NULL FROM users WHERE id = 1`,
      [todayISO()],
    );
    db.close();
    const real = seedCmd(['--confirm', 'START AGAIN']);
    assert.equal(real.code, 1, real.out);
    assert.match(real.out, /people of your own/);
    assert.match(real.out, /Kit Lane/);

    // gone live: refused
    db = openDb(dbPath);
    run(db, `DELETE FROM users WHERE email = 'kit.lane@office.example'`);
    goLive(db, { owner: { firstName: 'Robin', lastName: 'Ash', email: 'robin.ash@office.example' } });
    const users = count(db, `SELECT COUNT(*) AS n FROM users`);
    db.close();
    const live = seedCmd(['--confirm', 'START AGAIN']);
    assert.equal(live.code, 1, live.out);
    assert.match(live.out, /has gone live/);
    db = openDb(dbPath);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM users`), users, 'nothing touched');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run setup-code -- <email>: a code for someone who has not finished setting up; nothing for someone with two-step on; an audit row', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-setup-code-'));
  try {
    const dbPath = path.join(dir, 'linear.sqlite');
    const db = openDb(dbPath);
    createSchema(db);
    buildFixture(db);
    const rep = get<{ id: number }>(db, `SELECT id FROM users WHERE email = ?`, [FIXTURE_ACCOUNTS.rep.email])!.id;
    const admin = get<{ id: number }>(db, `SELECT id FROM users WHERE email = ?`, [FIXTURE_ACCOUNTS.admin.email])!.id;
    run(db, `UPDATE users SET totp_secret_enc = 'v1:x:y:z', totp_enabled_at = ? WHERE id = ?`, [new Date().toISOString(), admin]);
    run(db, `UPDATE users SET status = 'left' WHERE email = ?`, [FIXTURE_ACCOUNTS.repB.email]);
    db.close();
    const cmd = (...args: string[]) => command('src/setupCode.ts', dbPath, args);

    const usage = cmd();
    assert.equal(usage.code, 1);
    assert.match(usage.out, /Usage: npm run setup-code -- <email>/);
    assert.match(command('src/setupCode.ts', path.join(dir, 'nope.sqlite'), [FIXTURE_ACCOUNTS.rep.email]).out, /There is no database at/);
    const unknown = cmd('nobody@fixture.test');
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /No one .* nobody@fixture\.test/);
    const left = cmd(FIXTURE_ACCOUNTS.repB.email);
    assert.equal(left.code, 1);
    assert.match(left.out, /has left/);
    const notNeeded = cmd(FIXTURE_ACCOUNTS.admin.email);
    assert.equal(notNeeded.code, 0, notNeeded.out);
    assert.match(notNeeded.out, /already has two-step verification on/);
    assert.match(notNeeded.out, /npm run 2fa:reset/);

    const done = cmd(FIXTURE_ACCOUNTS.rep.email.toUpperCase());
    assert.equal(done.code, 0, done.out);
    const code = CODE_RE.exec(done.out)?.[1];
    assert.ok(code, done.out);
    assert.match(done.out, /works once, until/);
    const after = openDb(dbPath);
    try {
      const audit = get<{ action: string; summary: string; after: string }>(after, `SELECT action, summary, after_json AS after FROM audit_log ORDER BY id DESC LIMIT 1`)!;
      assert.equal(audit.action, 'npm run setup-code');
      assert.match(audit.summary, /^Gave a setup code from the server command: /);
      assert.ok(!audit.after.includes(code!), 'never the code');
      assert.equal(consumeSetupCode(after, rep, code), true);
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run 2fa:reset and npm run pin:reset print the one-time setup code the person needs next', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-reset-codes-'));
  try {
    const dbPath = path.join(dir, 'linear.sqlite');
    const db = openDb(dbPath);
    createSchema(db);
    buildFixture(db);
    const admin = get<{ id: number }>(db, `SELECT id FROM users WHERE email = ?`, [FIXTURE_ACCOUNTS.admin.email])!.id;
    run(db, `UPDATE users SET totp_secret_enc = 'v1:x:y:z', totp_enabled_at = ? WHERE id = ?`, [new Date().toISOString(), admin]);
    run(db, `UPDATE users SET pin_hash = 'scrypt-hmac$16384$8$1$c2FsdA==$a2V5', pin_set_at = ? WHERE id = ?`, [new Date().toISOString(), admin]);
    db.close();

    const pin = command('src/pinReset.ts', dbPath, [FIXTURE_ACCOUNTS.admin.email]);
    assert.equal(pin.code, 0, pin.out);
    const pinCode = CODE_RE.exec(pin.out)?.[1];
    assert.ok(pinCode, pin.out);
    let check = openDb(dbPath);
    assert.equal(get<{ r: number }>(check, `SELECT setup_code_required AS r FROM users WHERE id = ?`, [admin])!.r, 1, 'even with two-step on, the next sign-in needs it');
    check.close();

    const tfa = command('src/twoFactorReset.ts', dbPath, [FIXTURE_ACCOUNTS.admin.email]);
    assert.equal(tfa.code, 0, tfa.out);
    const tfaCode = CODE_RE.exec(tfa.out)?.[1];
    assert.ok(tfaCode && tfaCode !== pinCode, tfa.out);
    check = openDb(dbPath);
    try {
      assert.equal(consumeSetupCode(check, admin, pinCode), false, 'the newer code replaced the older one');
      assert.equal(consumeSetupCode(check, admin, tfaCode), true);
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
