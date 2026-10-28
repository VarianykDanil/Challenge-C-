/**
 * One-time setup codes and the fresh two-step code for sensitive admin actions (findings SEC-4, SECURITY-MISSED-6,
 * SECURITY-MISSED-1). Knowing someone's email and employee ID must never be enough to start their account; one stolen
 * admin session must never be enough to make another admin, take over a sign-in or hand out codes.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_MESSAGES, normaliseSetupCode } from '@lm/shared';
import { all, get, run } from '../db/connection.ts';
import { CODE_NEEDED_MESSAGE } from '../lib/payments/code.ts';
import { issueSetupCode } from '../lib/setupCodes.ts';
import { totp } from '../lib/totp.ts';
import { FIXTURE_ACCOUNTS, currentCode, startTestServer, type Json, type TestServer } from './helpers.ts';

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const db = () => srv!.db;
const fx = () => srv!.fixture!;
const adminCode = () => currentCode(db(), fx().users.admin);
const planId = (position: string) => get<{ id: number }>(db(), `SELECT id FROM pay_plans WHERE position = ? ORDER BY id LIMIT 1`, [position])!.id;

function newPerson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'new.person@example.test', firstName: 'New', lastName: 'Person', role: 'rep', position: 'field_rep', teamId: fx().teams.a,
    payPlanId: planId('field_rep'), startDate: fx().today, status: 'active', phone: null, city: 'Manchester', ...over,
  };
}

const auditRows = (action: string) =>
  all<{ summary: string; before: string | null; after: string | null; userId: number | null }>(
    db(), `SELECT summary, before_json AS before, after_json AS after, user_id AS userId FROM audit_log WHERE action = ? ORDER BY id`, [action],
  );

// ───────────────────────────── setup codes at sign-in ─────────────────────────────

test('a new account cannot be started with the email and employee ID alone: it needs its one-time setup code (SEC-4)', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  const made = await admin.post('/users', newPerson());
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const code = made.json.setupCode as string;
  assert.ok(normaliseSetupCode(code), `a setup code is shown once: ${code}`);
  assert.ok(Date.parse(made.json.setupCodeExpiresAt) - Date.now() > 6.9 * 86_400_000, 'valid for 7 days');
  assert.match(made.json.signInInstructions, new RegExp(`type your one-time setup code: ${code}`));
  const creds = { email: 'new.person@example.test', employeeId: made.json.employeeId as string };

  // the stored form is a hash: the code itself is nowhere in the database
  const stored = all<{ h: string }>(db(), `SELECT code_hash AS h FROM setup_codes WHERE user_id = ?`, [made.json.id]);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]!.h, code);
  assert.ok(!JSON.stringify(all(db(), `SELECT * FROM audit_log`)).includes(code), 'never in the audit trail');

  // email + ID only: no session, the page asks for the setup code
  const anon = srv.anon();
  const step1 = await anon.post('/auth/login', creds);
  assert.equal(step1.status, 200);
  assert.deepEqual(step1.json, { requiresSetupCode: true });
  assert.equal(anon.cookie, '', 'no session without the code');
  // the old attack: whoever knows the email and ID starts setting up their own authenticator
  assert.equal((await anon.post('/auth/2fa/setup')).status, 401);

  // a wrong code: 401 with the one sentence, no session
  const wrong = await anon.post('/auth/login', { ...creds, setupCode: 'AAAA-BBBB-CCCC' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, ACCESS_MESSAGES.setupCodeWrong);
  assert.deepEqual(wrong.json.details, { requiresSetupCode: true, reason: 'wrong' });
  assert.equal(anon.cookie, '');

  // the right code (typed loosely): a session that the gate holds at two-step setup
  const ok = await anon.post('/auth/login', { ...creds, setupCode: code.toLowerCase().replace(/-/g, ' ') });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(anon.cookie);
  assert.equal(ok.json.user.twoFactorSetupRequired, true);
  assert.equal((await anon.get('/me/dashboard')).status, 403, 'held at the setup gate');
  const setup = await anon.post('/auth/2fa/setup');
  assert.equal(setup.status, 201);
  assert.equal((await anon.post('/auth/2fa/enable', { code: totp(setup.json.secret) })).status, 200);
  assert.equal((await anon.get('/me/dashboard')).status, 200);

  // single use: the same code never works again
  const again = await srv.anon().post('/auth/login', { ...creds, setupCode: code });
  assert.equal(again.status, 200, 'two-step is on now: the code step, not the setup code');
  assert.equal(again.json.requiresTwoFactor, true);
  const used = get<{ usedAt: string | null }>(db(), `SELECT used_at AS usedAt FROM setup_codes WHERE user_id = ?`, [made.json.id])!;
  assert.ok(used.usedAt, 'marked used');
  assert.ok(auditRows('POST /auth/login').some((r) => /setup code/.test(r.summary)), 'the sign-in with a setup code is recorded');
});

test('a setup code is single use and expires after 7 days; a new one replaces the old', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  const made = await admin.post('/users', newPerson());
  const creds = { email: 'new.person@example.test', employeeId: made.json.employeeId as string };
  const userId = made.json.id as number;
  // expired: refused with the same sentence
  run(db(), `UPDATE setup_codes SET expires_at = ? WHERE user_id = ?`, [new Date(Date.now() - 1000).toISOString(), userId]);
  const expired = await srv.anon().post('/auth/login', { ...creds, setupCode: made.json.setupCode });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error, ACCESS_MESSAGES.setupCodeWrong);
  // a fresh code from the admin works; the old one does not
  const first = issueSetupCode(db(), userId, { createdBy: fx().users.admin, reason: 'reissue' });
  const second = issueSetupCode(db(), userId, { createdBy: fx().users.admin, reason: 'reissue' });
  assert.equal((await srv.anon().post('/auth/login', { ...creds, setupCode: first.code })).status, 401, 'replaced');
  const c = srv.anon();
  assert.equal((await c.post('/auth/login', { ...creds, setupCode: second.code })).status, 200);
  assert.equal((await srv.anon().post('/auth/login', { ...creds, setupCode: second.code })).status, 401, 'used once');
});

test('"Require a PIN for everyone" no longer lets whoever signs in first pick the PIN: the setup code comes first (SECURITY-MISSED-6)', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  assert.equal((await admin.post('/auth/pin', { pin: '4917' })).status, 204);
  assert.equal((await admin.put('/auth/security-settings', { requirePin: true })).status, 200);
  const made = await admin.post('/users', newPerson());
  const creds = { email: 'new.person@example.test', employeeId: made.json.employeeId as string };
  const anon = srv.anon();
  const step1 = await anon.post('/auth/login', creds);
  assert.deepEqual(step1.json, { requiresSetupCode: true });
  assert.equal((await anon.post('/auth/pin', { pin: '7351' })).status, 401, 'no session, no PIN');
  const ok = await anon.post('/auth/login', { ...creds, setupCode: made.json.setupCode });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.pinSetupRequired, true, 'then the PIN');
  assert.equal((await anon.post('/auth/pin', { pin: '7351' })).status, 204);
});

test('an admin PIN reset hands out a setup code, and the next sign-in needs it even with two-step on', async () => {
  srv = await startTestServer();
  const rep = await srv.login('rep');
  assert.equal((await rep.post('/auth/pin', { pin: '4917' })).status, 204);
  const admin = await srv.login('admin');
  const reset = await admin.post(`/auth/pin/reset/${fx().users.rep}`, { code: adminCode() });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.ok(normaliseSetupCode(reset.json.setupCode));
  const creds = FIXTURE_ACCOUNTS.rep;
  const anon = srv.anon();
  assert.deepEqual((await anon.post('/auth/login', creds)).json, { requiresSetupCode: true }, 'the phone alone is not enough after a PIN reset');
  const step2 = await anon.post('/auth/login', { ...creds, setupCode: reset.json.setupCode });
  assert.equal(step2.json.requiresTwoFactor, true, 'then their usual two-step code');
  const done = await anon.post('/auth/login/2fa', { challengeToken: step2.json.challengeToken, code: currentCode(db(), fx().users.rep) });
  assert.equal(done.status, 200);
  // after that, a plain sign-in again (the code was the one-off)
  await anon.post('/auth/logout');
  const plain = await srv.anon().post('/auth/login', creds);
  assert.equal(plain.json.requiresTwoFactor, true);
});

test('after a PIN reset the setup code is used up only once the two-step step succeeds (an abandoned sign-in leaves it needed)', async () => {
  srv = await startTestServer();
  const rep = await srv.login('rep');
  assert.equal((await rep.post('/auth/pin', { pin: '4917' })).status, 204);
  const admin = await srv.login('admin');
  const reset = await admin.post(`/auth/pin/reset/${fx().users.rep}`, { code: adminCode() });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  const creds = FIXTURE_ACCOUNTS.rep;
  const setupCode = reset.json.setupCode as string;
  // the right setup code, then the sign-in stops at the two-step step
  const abandoned = await srv.anon().post('/auth/login', { ...creds, setupCode });
  assert.equal(abandoned.json.requiresTwoFactor, true);
  // someone with only the phone still cannot get in and choose the PIN
  assert.deepEqual((await srv.anon().post('/auth/login', creds)).json, { requiresSetupCode: true }, 'the code is still needed');
  // a wrong two-step code does not use it up either
  const wrong = await srv.anon().post('/auth/login/2fa', { challengeToken: abandoned.json.challengeToken, code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(get<{ r: number }>(db(), `SELECT setup_code_required AS r FROM users WHERE id = ?`, [fx().users.rep])!.r, 1);
  // the same code with the right two-step code signs in, and only then is it used
  const anon = srv.anon();
  const again = await anon.post('/auth/login', { ...creds, setupCode });
  assert.equal(again.json.requiresTwoFactor, true, JSON.stringify(again.json));
  const done = await anon.post('/auth/login/2fa', { challengeToken: again.json.challengeToken, code: currentCode(db(), fx().users.rep) });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.user.hasPin, false, 'the old PIN is gone: they can choose a new one');
  assert.equal(get<{ r: number }>(db(), `SELECT setup_code_required AS r FROM users WHERE id = ?`, [fx().users.rep])!.r, 0);
  assert.equal(get<{ n: number }>(db(), `SELECT COUNT(*) AS n FROM setup_codes WHERE user_id = ? AND used_at IS NOT NULL`, [fx().users.rep])!.n, 1);
});

test('a setup code held by a sign-in stops working when an administrator gives a new one before the two-step step', async () => {
  srv = await startTestServer();
  const rep = await srv.login('rep');
  assert.equal((await rep.post('/auth/pin', { pin: '4917' })).status, 204);
  const admin = await srv.login('admin');
  const reset = await admin.post(`/auth/pin/reset/${fx().users.rep}`, { code: adminCode() });
  const creds = FIXTURE_ACCOUNTS.rep;
  const anon = srv.anon();
  const step1 = await anon.post('/auth/login', { ...creds, setupCode: reset.json.setupCode });
  assert.equal(step1.json.requiresTwoFactor, true);
  // a new code replaces the old one (say the admin thought it was lost)
  issueSetupCode(db(), fx().users.rep, { createdBy: fx().users.admin, reason: 'reissue' });
  const late = await anon.post('/auth/login/2fa', { challengeToken: step1.json.challengeToken, code: currentCode(db(), fx().users.rep) });
  assert.equal(late.status, 401, JSON.stringify(late.json));
  assert.equal(late.json.error, ACCESS_MESSAGES.setupCodeWrong);
  assert.equal(late.json.details?.requiresSetupCode, true);
  assert.equal(get<{ r: number }>(db(), `SELECT setup_code_required AS r FROM users WHERE id = ?`, [fx().users.rep])!.r, 1);
});

test('existing accounts with two-step on are unaffected; one without gets a code from an admin (Team or the server command)', async () => {
  srv = await startTestServer();
  const rep = await srv.login('rep'); // the helper sets up two-step: the usual sign-in, no setup code
  assert.equal((await rep.get('/me/dashboard')).status, 200);
  // repA2 never set up two-step: email + ID asks for a code
  const creds = FIXTURE_ACCOUNTS.repA2;
  assert.deepEqual((await srv.anon().post('/auth/login', creds)).json, { requiresSetupCode: true });
  const admin = await srv.login('admin');
  const refusedNoCode = await admin.post(`/users/${fx().users.repA2}/setup-code`, {});
  assert.equal(refusedNoCode.status, 400);
  assert.equal(refusedNoCode.json.error, CODE_NEEDED_MESSAGE);
  const issued = await admin.post(`/users/${fx().users.repA2}/setup-code`, { code: adminCode() });
  assert.equal(issued.status, 200, JSON.stringify(issued.json));
  assert.equal(issued.json.userId, fx().users.repA2);
  assert.ok(normaliseSetupCode(issued.json.setupCode));
  const c = srv.anon();
  assert.equal((await c.post('/auth/login', { ...creds, setupCode: issued.json.setupCode })).status, 200);
  const rows = auditRows('POST /users/:id/setup-code');
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.summary, /^Gave Rita Rep a new setup code$/);
  assert.ok(!JSON.stringify(rows).includes(issued.json.setupCode), 'the code is never recorded');
  // never your own; only admins
  assert.equal((await admin.post(`/users/${fx().users.admin}/setup-code`, { code: adminCode() })).status, 400);
  for (const role of ['leader', 'recruiter', 'rep'] as const) {
    const other = await srv.login(role);
    assert.equal((await other.post(`/users/${fx().users.repA2}/setup-code`, { code: '123456' })).status, 403, role);
  }
});

// ───────────────────────────── step-up: the acting admin's fresh two-step code ─────────────────────────────

test('making an administrator needs the acting admin’s fresh two-step code (SECURITY-MISSED-1)', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  const noCode = await admin.post('/users', newPerson({ role: 'admin', position: 'owner', payPlanId: planId('owner'), email: 'shadow@example.test' }));
  assert.equal(noCode.status, 400, JSON.stringify(noCode.json));
  assert.equal(noCode.json.error, CODE_NEEDED_MESSAGE);
  assert.equal(get(db(), `SELECT 1 FROM users WHERE email = 'shadow@example.test'`), undefined, 'nobody made');
  const wrong = await admin.post('/users', newPerson({ role: 'admin', position: 'owner', payPlanId: planId('owner'), email: 'shadow@example.test', code: '000000' === adminCode() ? '111111' : '000000' }));
  assert.equal(wrong.status, 400);
  const ok = await admin.post('/users', newPerson({ role: 'admin', position: 'owner', payPlanId: planId('owner'), email: 'shadow@example.test', code: adminCode() }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  // the new admin cannot sign in with email + ID alone
  assert.deepEqual((await srv.anon().post('/auth/login', { email: 'shadow@example.test', employeeId: ok.json.employeeId })).json, { requiresSetupCode: true });
  // a non-admin person needs no code
  assert.equal((await admin.post('/users', newPerson({ email: 'plain@example.test' }))).status, 201);
});

test('promoting to administrator, changing a sign-in email, and resetting two-step or a PIN all need the fresh code', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  const rep = fx().users.rep;
  const promote = await admin.patch(`/users/${rep}`, { role: 'admin' });
  assert.equal(promote.status, 400);
  assert.equal(promote.json.error, CODE_NEEDED_MESSAGE);
  assert.equal(get<{ role: string }>(db(), `SELECT role FROM users WHERE id = ?`, [rep])!.role, 'rep');
  const email = await admin.patch(`/users/${rep}`, { email: 'someone.else@example.test' });
  assert.equal(email.status, 400);
  assert.equal(email.json.error, CODE_NEEDED_MESSAGE);
  // other edits need no code (a phone number, a team)
  assert.equal((await admin.patch(`/users/${rep}`, { phone: '07700 900123' })).status, 200);
  // the same email again (case only) is not a change
  assert.equal((await admin.patch(`/users/${rep}`, { email: FIXTURE_ACCOUNTS.rep.email.toUpperCase() })).status, 200);
  assert.equal((await admin.patch(`/users/${rep}`, { role: 'admin', code: adminCode() })).status, 200);
  assert.equal((await admin.patch(`/users/${rep}`, { email: 'someone.else@example.test', code: adminCode() })).status, 200);

  const twoFa = await admin.post(`/users/${fx().users.repB}/2fa/reset`, {});
  assert.equal(twoFa.status, 400);
  assert.equal(twoFa.json.error, CODE_NEEDED_MESSAGE);
  const twoFaOk = await admin.post(`/users/${fx().users.repB}/2fa/reset`, { code: adminCode() });
  assert.equal(twoFaOk.status, 200);
  assert.ok(normaliseSetupCode(twoFaOk.json.setupCode), 'a reset hands out a setup code');

  const pin = await admin.post(`/auth/pin/reset/${fx().users.leader}`, {});
  assert.equal(pin.status, 400);
  assert.equal(pin.json.error, CODE_NEEDED_MESSAGE);

  // audited, and never with a code in the row
  const rows = [...auditRows('PATCH /users/:id'), ...auditRows('POST /users/:id/2fa/reset')];
  assert.ok(rows.some((r) => /Updated Remy Rep/.test(r.summary) && /role/i.test(r.summary)), JSON.stringify(rows.map((r) => r.summary)));
  assert.ok(rows.some((r) => /Reset two-step verification: Bo Rep/.test(r.summary)));
  assert.ok(!JSON.stringify(rows).includes(twoFaOk.json.setupCode));
});

test('an admin without two-step cannot do any of these: the code is required, not optional', async () => {
  srv = await startTestServer();
  // a second admin who has signed in with a setup code and not set up two-step yet: the gate holds them anyway
  const admin = await srv.login('admin');
  const made = await admin.post('/users', newPerson({ role: 'admin', position: 'owner', payPlanId: planId('owner'), email: 'second@example.test', code: adminCode() }));
  const second = srv.anon();
  await second.post('/auth/login', { email: 'second@example.test', employeeId: made.json.employeeId, setupCode: made.json.setupCode });
  const r = await second.post(`/users/${fx().users.rep}/setup-code`, {});
  assert.equal(r.status, 403);
  assert.equal((r.json as Json).twoFactorSetupRequired, true);
});

test('client accounts: an invite and a reset hand out setup codes; resets need the fresh code', async () => {
  srv = await startTestServer();
  const admin = await srv.login('admin');
  const invite = await admin.post(`/campaigns/${fx().campaignId}/client-accounts`, { firstName: 'Ivy', lastName: 'Invited', email: 'ivy@charity.example' });
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  assert.ok(normaliseSetupCode(invite.json.setupCode));
  assert.match(invite.json.instructions, /type your one-time setup code/);
  const creds = { email: 'ivy@charity.example', employeeId: invite.json.accessCode as string };
  assert.deepEqual((await srv.anon().post('/auth/login', creds)).json, { requiresSetupCode: true });
  const c = srv.anon();
  const ok = await c.post('/auth/login', { ...creds, setupCode: invite.json.setupCode });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.pinSetupRequired, true, 'a client account then creates its PIN');

  const id = invite.json.account.id as number;
  assert.equal((await admin.post(`/client-accounts/${id}/reset-2fa`, {})).status, 400);
  const r2 = await admin.post(`/client-accounts/${id}/reset-2fa`, { code: adminCode() });
  assert.equal(r2.status, 200);
  assert.ok(normaliseSetupCode(r2.json.setupCode));
  assert.equal((await admin.post(`/client-accounts/${id}/reset-pin`, {})).status, 400);
  const p = await admin.post(`/client-accounts/${id}/reset-pin`, { code: adminCode() });
  assert.equal(p.status, 200);
  assert.ok(normaliseSetupCode(p.json.setupCode));
});

test('a hire from recruitment gets a setup code, shown once to whoever hired them', async () => {
  srv = await startTestServer();
  const recruiter = await srv.login('recruiter');
  const cand = await recruiter.post('/recruitment/candidates', { firstName: 'Hana', lastName: 'Hire', email: 'hana.hire@example.test' });
  assert.equal(cand.status, 201, JSON.stringify(cand.json));
  const id = cand.json.id as number;
  // walk the stages to an offer, then hire
  for (const stage of ['screening', 'interview', 'observation', 'offer'] as const) {
    const r = await recruiter.post(`/recruitment/candidates/${id}/stage`, { stage });
    assert.equal(r.status, 200, `${stage}: ${JSON.stringify(r.json)}`);
  }
  const hired = await recruiter.post(`/recruitment/candidates/${id}/stage`, { stage: 'hired', teamId: fx().teams.a });
  assert.equal(hired.status, 200, JSON.stringify(hired.json));
  assert.ok(hired.json.hiredSignIn, 'the sign-in details of the new account');
  assert.ok(normaliseSetupCode(hired.json.hiredSignIn.setupCode));
  assert.equal(hired.json.hiredSignIn.userId, hired.json.hiredUserId);
  assert.match(hired.json.hiredSignIn.signInInstructions, /setup code/);
  // a later read never shows it again
  assert.equal((await recruiter.get(`/recruitment/candidates/${id}`)).json.hiredSignIn, undefined);
});
