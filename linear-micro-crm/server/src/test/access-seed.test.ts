/**
 * The demo seed's people and look (findings CLAIMS-MISSED-6, UX-9): the public repository holds no real person — the
 * demo owner is invented, the demo company uses an invented domain, and the starter team comes from the office's own
 * local file (never committed) or from an example of invented people. A sales demo never shows weeks that were never
 * paid ("Your pay for w/c 3 Aug is 74 days overdue").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, get, openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { seed } from '../db/seed.ts';
import { USERS } from '../db/seed-data.ts';
import { paydayForWeek } from '@lm/shared';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { loadStarterTeam, parseStarterTeam, STARTER_TEAM_EXAMPLE, starterTeamFileFor } from '../lib/starterTeam.ts';
import { demoPeopleIds } from '../lib/trialMode.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');

test('no real person in the seed: an invented owner and an invented company domain', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    seed(db, todayISO());
    const owner = get<{ name: string; email: string }>(db, `SELECT first_name || ' ' || last_name AS name, email FROM users WHERE employee_id = 'LM-0001'`)!;
    assert.equal(owner.name, 'Morgan Blake');
    assert.equal(owner.email, 'morgan.blake@linearhub.example');
    const staff = all<{ email: string }>(db, `SELECT email FROM users WHERE role <> 'client'`);
    assert.ok(staff.length > 30);
    for (const s of staff) assert.match(s.email, /@linearhub\.example$/, `${s.email}: the invented domain`);
    // the seed's own source too (the developer's real name and the customer's domain are gone)
    const source = ['server/src/db/seed-data.ts', 'server/src/db/seed.ts', 'server/starter-team.example.json']
      .map((f) => readFileSync(path.join(REPO, f), 'utf8')).join('\n');
    assert.doesNotMatch(source, /Varianyk|danil@|linear-mcr\.co\.uk/i);
    assert.ok(USERS.every((u) => !u.email), 'every demo email comes from the invented domain');
  } finally {
    db.close();
  }
});

test('the starter team: the example of invented people by default, the office’s local file when there is one', () => {
  const example = loadStarterTeam();
  assert.equal(example.source, 'example');
  assert.equal(example.file, STARTER_TEAM_EXAMPLE);
  assert.ok(example.accounts.every((a) => a.email.endsWith('@linearhub.example')));
  assert.equal(loadStarterTeam(null).source, 'example');
  assert.equal(loadStarterTeam('/nonexistent/starter-team.json').source, 'example', 'no local file: the example');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-starter-'));
  try {
    const dbPath = path.join(dir, 'linear.sqlite');
    const local = starterTeamFileFor(dbPath);
    assert.equal(local, path.join(dir, 'starter-team.json'), 'next to the database');
    writeFileSync(local, JSON.stringify({
      teams: [{ name: 'North', color: '#0E7490' }],
      accounts: [
        { firstName: 'Kit', lastName: 'Lane', email: 'Kit.Lane@Office.example', role: 'leader', position: 'team_leader', team: 'North', leadsTeam: true },
        { firstName: 'Lou', email: 'lou@office.example', role: 'rep', position: 'trainee', team: 'North' },
      ],
    }));
    const mine = loadStarterTeam(local);
    assert.equal(mine.source, 'local');
    assert.deepEqual(mine.accounts.map((a) => [a.employeeId, a.firstName, a.lastName ?? '', a.email]), [
      ['LM-0101', 'Kit', 'Lane', 'kit.lane@office.example'],
      ['LM-0102', 'Lou', '', 'lou@office.example'],
    ], 'IDs given from LM-0101, emails lower case, surnames optional');
    // the office's own people are not the demo company: golive keeps them
    const db = openDb(':memory:');
    try {
      createSchema(db);
      seed(db, todayISO(), { starterTeam: mine });
      const kit = get<{ id: number; lastName: string }>(db, `SELECT id, last_name AS lastName FROM users WHERE email = 'kit.lane@office.example'`)!;
      assert.equal(kit.lastName, 'Lane');
      assert.ok(!demoPeopleIds(db).includes(kit.id), 'a local starter is a real person');
      const ex = openDb(':memory:');
      try {
        createSchema(ex);
        seed(ex, todayISO());
        const ava = get<{ id: number }>(ex, `SELECT id FROM users WHERE email = 'ava@linearhub.example'`)!;
        assert.ok(demoPeopleIds(ex).includes(ava.id), 'an example starter belongs to the demo company');
      } finally {
        ex.close();
      }
    } finally {
      db.close();
    }
    // a broken local file is refused with a sentence, never silently swapped for invented people
    writeFileSync(local, '{ "teams": [], "accounts": [ { "firstName": "X" } ] }');
    assert.throws(() => loadStarterTeam(local), /The starter team file .*starter-team\.json cannot be used: X has no valid email\./);
    assert.throws(() => parseStarterTeam('nope', 'f.json', 'local'), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the local file is never committed
  assert.match(readFileSync(path.join(REPO, '.gitignore'), 'utf8'), /^server\/data\/starter-team\.json$/m);
});

test('the demo looks paid up: no week was left unpaid, and the only pending run is the week that just ended (UX-9)', () => {
  const db = openDb(':memory:');
  try {
    createSchema(db);
    const today = todayISO();
    seed(db, today);
    const unpaid = all<{ weekStart: string; dueDate: string; status: string }>(
      db, `SELECT week_start AS weekStart, due_date AS dueDate, status FROM payroll_runs WHERE status IN ('pending', 'failed')`,
    );
    assert.equal(unpaid.filter((r) => r.status === 'failed').length, 0, 'no failed transfers in the demo');
    const lastWeek = addDays(mondayOf(today), -7);
    for (const r of unpaid) {
      assert.equal(r.weekStart, lastWeek, `only last week's runs wait (found w/c ${r.weekStart})`);
      assert.equal(r.dueDate, paydayForWeek(lastWeek));
    }
    // Jordan (the demo rep) has nothing overdue
    const overdue = all(db, `SELECT 1 FROM payroll_runs p JOIN users u ON u.id = p.user_id WHERE u.employee_id = 'LM-0010' AND p.status IN ('pending', 'failed') AND p.due_date < ?`, [today]);
    assert.equal(overdue.length, 0);
  } finally {
    db.close();
  }
});
