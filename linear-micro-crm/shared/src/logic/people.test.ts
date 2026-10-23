import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPersonRefusal, canAddPeople, firstNameWithInitial, personInitials, personName, personSortKey, shareableSignInUrl, staffSignInInstructions,
} from './people.ts';

test('personName: first and last name, and the first name alone when there is no surname (no stray spaces)', () => {
  assert.equal(personName({ firstName: 'Amelia', lastName: 'Hart' }), 'Amelia Hart');
  assert.equal(personName({ firstName: 'Theo', lastName: '' }), 'Theo');
  assert.equal(personName({ firstName: ' Theo ', lastName: '  ' }), 'Theo');
  assert.equal(personName({ firstName: 'Mary', lastName: 'Ann  Lee' }), 'Mary Ann  Lee', 'inner spacing of a name is the person’s own');
  assert.equal(personName({ firstName: '', lastName: '' }), '');
  assert.equal(`${personName({ firstName: 'Theo', lastName: '' })} logged 3 sales`, 'Theo logged 3 sales');
});

test('personInitials: two letters from first and last name, one from the first name alone', () => {
  assert.equal(personInitials({ firstName: 'Amelia', lastName: 'Hart' }), 'AH');
  assert.equal(personInitials({ firstName: 'theo', lastName: '' }), 'T');
  assert.equal(personInitials({ firstName: '', lastName: '' }), '');
});

test('firstNameWithInitial: "Olivia K." to tell two Olivias apart, plain "Olivia" without a surname (never "Olivia .")', () => {
  assert.equal(firstNameWithInitial({ firstName: 'Olivia', lastName: 'Kaur' }), 'Olivia K.');
  assert.equal(firstNameWithInitial({ firstName: 'Olivia', lastName: '' }), 'Olivia');
});

test('personSortKey: surname first, the first name standing in for a missing surname', () => {
  const people = [
    { firstName: 'Theo', lastName: '' },
    { firstName: 'Amelia', lastName: 'Hart' },
    { firstName: 'Zara', lastName: 'Ahmed' },
    { firstName: 'Olivia', lastName: '' },
    { firstName: 'Olivia', lastName: 'Kaur' },
  ];
  const sorted = [...people].sort((a, b) => personSortKey(a).localeCompare(personSortKey(b))).map(personName);
  assert.deepEqual(sorted, ['Zara Ahmed', 'Amelia Hart', 'Olivia Kaur', 'Olivia', 'Theo']);
});

test('canAddPeople: administrators, recruiters and leaders; never a rep or a client', () => {
  assert.equal(canAddPeople('admin'), true);
  assert.equal(canAddPeople('recruiter'), true);
  assert.equal(canAddPeople('leader'), true);
  assert.equal(canAddPeople('rep'), false);
  assert.equal(canAddPeople('client'), false);
  assert.equal(canAddPeople(undefined), false);
});

const leader = { role: 'leader' as const, teamId: 7, teamName: 'Sapiens' };
const recruiter = { role: 'recruiter' as const, teamId: null, teamName: null };
const admin = { role: 'admin' as const, teamId: null, teamName: null };

test('addPersonRefusal: an administrator may set anything', () => {
  assert.equal(addPersonRefusal(admin, { role: 'admin', position: 'owner', payPlanId: 3, status: 'left', avatarColor: '#000000', employeeId: 'LM-0500', teamId: null }), null);
});

test('addPersonRefusal: a leader adds a trainee or a field rep to their own team (the team defaults to theirs)', () => {
  assert.equal(addPersonRefusal(leader, { position: 'trainee' }), null);
  assert.equal(addPersonRefusal(leader, { position: 'field_rep', teamId: 7, role: 'rep', status: 'active' }), null);
  assert.equal(addPersonRefusal(leader, { position: 'trainee', payPlanId: null, avatarColor: undefined, employeeId: '  ' }), null, 'empty values are not attempts');
});

test('addPersonRefusal: a leader cannot add to another team, and a leader with no team cannot add at all', () => {
  const other = addPersonRefusal(leader, { position: 'trainee', teamId: 8 });
  assert.equal(other?.status, 403);
  assert.equal(other?.field, 'teamId');
  assert.equal(other?.message, 'You can add people to your own team (Sapiens) only.');
  assert.equal(addPersonRefusal(leader, { position: 'trainee', teamId: null })?.status, 403, 'no team is another team too');
  const teamless = addPersonRefusal({ role: 'leader', teamId: null, teamName: null }, { position: 'trainee' });
  assert.equal(teamless?.status, 403);
  assert.match(teamless!.message, /not on a team/);
  assert.equal(addPersonRefusal({ role: 'leader', teamId: 7 }, { position: 'trainee', teamId: 8 })?.message, 'You can add people to your own team only.');
});

test('addPersonRefusal: a recruiter adds to any team but must choose one', () => {
  assert.equal(addPersonRefusal(recruiter, { position: 'trainee', teamId: 8 }), null);
  assert.equal(addPersonRefusal(recruiter, { position: 'field_rep', teamId: 1 }), null);
  const none = addPersonRefusal(recruiter, { position: 'trainee' });
  assert.equal(none?.status, 400);
  assert.equal(none?.field, 'teamId');
  assert.equal(none?.message, 'Choose a team for them.');
});

test('addPersonRefusal: escalation attempts are refused with 403 and a plain sentence, never ignored', () => {
  for (const actor of [leader, recruiter]) {
    const base = { position: 'trainee', teamId: actor.role === 'leader' ? 7 : 8 };
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ role: 'leader' }, 'role', /Only an administrator can make someone a leader, recruiter or administrator/],
      [{ role: 'admin' }, 'role', /Only an administrator/],
      [{ role: 'client' }, 'role', /Only an administrator/],
      [{ position: 'team_leader' }, 'position', /You can add trainees and field representatives/],
      [{ position: 'owner' }, 'position', /trainees and field representatives/],
      [{ payPlanId: 3 }, 'payPlanId', /Only an administrator can choose a pay plan/],
      [{ status: 'left' }, 'status', /New people start as active/],
      [{ status: 'on_leave' }, 'status', /New people start as active/],
      [{ avatarColor: '#123456' }, 'avatarColor', /Only an administrator can choose an avatar colour/],
      [{ employeeId: 'LM-0001' }, 'employeeId', /Employee IDs are given automatically/],
    ];
    for (const [extra, field, re] of cases) {
      const r = addPersonRefusal(actor, { ...base, ...extra });
      assert.equal(r?.status, 403, `${actor.role} ${JSON.stringify(extra)}`);
      assert.equal(r?.field, field);
      assert.match(r!.message, re);
      assert.match(r!.message, /\.$/, 'a sentence');
    }
  }
});

test('addPersonRefusal: anyone else is refused', () => {
  assert.equal(addPersonRefusal({ role: 'rep', teamId: 7 }, { position: 'trainee' })?.status, 403);
  assert.equal(addPersonRefusal({ role: 'client', teamId: null }, { position: 'trainee' })?.status, 403);
});

test('staffSignInInstructions: the address, the email, the employee ID and the PIN step only when a PIN is required', () => {
  const text = staffSignInInstructions({
    firstName: 'Sam', email: 'sam.smith@linear-mcr.co.uk', employeeId: 'LM-0108', teamName: 'Sapiens',
    signInUrl: 'http://192.168.1.20:4000/login', pinRequired: false,
  });
  assert.match(text, /^Hello Sam,/);
  assert.match(text, /Linear Hub account with Linear MCR \(Sapiens team\)\./);
  assert.match(text, /1\. Open http:\/\/192\.168\.1\.20:4000\/login\./);
  assert.match(text, /2\. Enter your email \(sam\.smith@linear-mcr\.co\.uk\) and your employee ID: LM-0108\./);
  assert.doesNotMatch(text, /PIN/);
  assert.match(text, /Keep your employee ID to yourself/);
  const withPin = staffSignInInstructions({ firstName: ' ', email: 'a@b.example', employeeId: 'LM-0109', pinRequired: true });
  assert.match(withPin, /^Hello there,/);
  assert.match(withPin, /Linear Hub account with Linear MCR\./);
  assert.match(withPin, /1\. Open the Linear Hub sign-in page\./);
  assert.match(withPin, /3\. The first time, create a PIN of 4 to 6 digits\./);
  assert.ok(!withPin.includes('  '), 'no double spaces');
});

test('shareableSignInUrl: an address only this computer can open (localhost, 127.x, [::1]) is no use to someone else', () => {
  for (const url of ['http://localhost:4000/login', 'http://LOCALHOST/login', 'https://localhost:4443/login', 'http://127.0.0.1:4000/login', 'http://127.1.2.3/login', 'http://[::1]:4000/login', 'http://localhost./login', 'http://0.0.0.0:4000/login']) {
    assert.equal(shareableSignInUrl(url), null, url);
  }
  for (const url of ['http://192.168.1.20:4000/login', 'http://matts-macbook.local:4000/login', 'https://hub.example/login', 'http://localhost.example.com/login', 'http://127.example/login']) {
    assert.equal(shareableSignInUrl(url), url, url);
  }
  assert.equal(shareableSignInUrl(null), null);
  assert.equal(shareableSignInUrl(undefined), null);
  assert.equal(shareableSignInUrl('  '), null);
  assert.equal(shareableSignInUrl(' http://192.168.1.20:4000/login '), 'http://192.168.1.20:4000/login');
});

test('staffSignInInstructions: added on the computer that runs Linear Hub (localhost) → the general sign-in page, never a localhost link', () => {
  for (const signInUrl of ['http://localhost:4000/login', 'http://127.0.0.1:4000/login', 'http://[::1]:4000/login']) {
    const text = staffSignInInstructions({ firstName: 'Sam', email: 'sam@b.example', employeeId: 'LM-0108', teamName: 'Sapiens', signInUrl, pinRequired: false });
    assert.match(text, /1\. Open the Linear Hub sign-in page\./, signInUrl);
    assert.doesNotMatch(text, /localhost|127\.0\.0\.1|::1/, signInUrl);
  }
});
