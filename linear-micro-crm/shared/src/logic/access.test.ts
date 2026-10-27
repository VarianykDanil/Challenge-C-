import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_MESSAGES, SETUP_CODE_ALPHABET, SETUP_CODE_LENGTH, clientInviteInstructions, isSetupCodeComplete, normaliseSetupCode, setupCodeExpiryText,
  staffSignInInstructions, trialHeadline,
} from '../index.ts';

test('setup codes: forgiving to type (case, spaces, dashes), strict about the symbols', () => {
  assert.equal(normaliseSetupCode('abcd efgh jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(normaliseSetupCode('ABCD-EFGH-JKMN'), 'ABCD-EFGH-JKMN');
  assert.equal(normaliseSetupCode(' abcdefghjkmn '), 'ABCD-EFGH-JKMN');
  assert.equal(normaliseSetupCode('ABCD-EFGH-JKM'), null, 'too short');
  assert.equal(normaliseSetupCode('ABCD-EFGH-JKMNP'), null, 'too long');
  assert.equal(normaliseSetupCode('ABCD-EFGH-JKM0'), null, 'a zero is never in a code (it looks like O)');
  assert.equal(normaliseSetupCode('ABCD-EFGH-JKM1'), null, 'nor a one');
  assert.equal(normaliseSetupCode(123456789012), null);
  assert.equal(normaliseSetupCode(undefined), null);
  assert.equal(isSetupCodeComplete('abcd-efgh-jkmn'), true);
  assert.equal(isSetupCodeComplete('abcd'), false);
  for (const ch of 'ILO01') assert.ok(!SETUP_CODE_ALPHABET.includes(ch), `${ch} is easy to misread`);
  assert.ok(SETUP_CODE_ALPHABET.length ** SETUP_CODE_LENGTH > 2 ** 55, 'far too many codes to guess');
});

test('setup code expiry reads as a London date and time', () => {
  assert.equal(setupCodeExpiryText('2026-11-03T14:05:00.000Z'), 'Valid until Tue 3 Nov, 14:05');
  assert.equal(setupCodeExpiryText('2026-07-03T14:05:00.000Z'), 'Valid until Fri 3 Jul, 15:05', 'summer time');
  assert.equal(setupCodeExpiryText('nonsense'), '');
});

test('trial headline: says whether the one-tap demo sign-ins work', () => {
  assert.equal(trialHeadline(true), 'Trial mode: demo sign-ins are on');
  assert.equal(trialHeadline(false), 'Trial mode: the demo company is still here');
  assert.match(ACCESS_MESSAGES.trialBody, /^Go live before real pay or bank details go in\./);
  assert.match(ACCESS_MESSAGES.demoRefused('create an administrator'), /^Demo accounts cannot create an administrator\./);
});

test('staff sign-in instructions carry the one-time setup code, before the PIN and two-step steps', () => {
  const text = staffSignInInstructions({
    firstName: 'Sam', email: 'sam@example.test', employeeId: 'LM-0108', pinRequired: true,
    setupCode: 'ABCD-EFGH-JKMN', setupCodeExpiresAt: '2026-11-03T14:05:00.000Z',
  });
  assert.match(text, /\n2\. Enter your email \(sam@example\.test\) and your employee ID: LM-0108\./);
  assert.match(text, /\n3\. The first time, type your one-time setup code: ABCD-EFGH-JKMN\. It works once, until Tue 3 Nov, 14:05\./);
  assert.match(text, /\n4\. Then create a PIN of 4 to 6 digits\./);
  assert.match(text, /\n5\. Then set up two-step verification\./);
  assert.match(text, /Keep your employee ID, setup code, PIN and recovery codes to yourself\./);
  assert.ok(!text.includes('  '), 'no double spaces');
  // not shown (insecure connection): the step still says a code is needed, and where it comes from
  const withheld = staffSignInInstructions({ firstName: 'Sam', email: 'sam@example.test', employeeId: 'LM-0108', pinRequired: false, setupCode: null });
  assert.match(withheld, /\n3\. The first time, type the one-time setup code an administrator gives you\./);
  assert.match(withheld, /\n4\. Then set up two-step verification\./);
  assert.doesNotMatch(withheld, /[A-Z]{4}-[A-Z]{4}-[A-Z]{4}/);
});

test('client invite instructions carry the setup code too', () => {
  const text = clientInviteInstructions({
    firstName: 'Jo', email: 'jo@charity.example', accessCode: 'CL-0002', campaignName: 'A Charity', setupCode: 'WXYZ-2345-6789',
    setupCodeExpiresAt: '2026-11-03T14:05:00.000Z',
  });
  assert.match(text, /\n2\. Enter your email \(jo@charity\.example\) and your access code: CL-0002\./);
  assert.match(text, /\n3\. The first time, type your one-time setup code: WXYZ-2345-6789\. It works once, until Tue 3 Nov, 14:05\./);
  assert.match(text, /\n4\. Then create a PIN of 4 to 6 digits\./);
  assert.match(text, /\n5\. Then set up two-step verification\./);
  const none = clientInviteInstructions({ firstName: 'Jo', email: 'jo@charity.example', accessCode: 'CL-0002', campaignName: 'A Charity' });
  assert.match(none, /\n3\. The first time, type the one-time setup code Linear MCR gives you\./);
});
