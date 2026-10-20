import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ENTITIES,
  AUDIT_ENTITY_LABELS,
  AUDIT_REDACTED,
  auditChangeText,
  auditDayLabel,
  auditDiff,
  auditFieldLabel,
  auditHumanise,
  auditMoney,
  auditValueText,
  auditWeekLabel,
  isAuditEntity,
  isAuditRedactedKey,
  redactAuditSnapshot,
} from './audit.ts';

test('auditDiff: changed fields only, in the before order, then fields only the after has', () => {
  const before = { id: 7, userName: 'Jordan Lee', stops: 60, sales: 3, notes: null };
  const after = { id: 7, userName: 'Jordan Lee', stops: 65, sales: 4, notes: 'Rain after 2pm', checkedInAt: '2026-10-12T09:24:00' };
  assert.deepEqual(auditDiff(before, after), [
    { field: 'stops', before: 60, after: 65 },
    { field: 'sales', before: 3, after: 4 },
    { field: 'notes', before: null, after: 'Rain after 2pm' },
    { field: 'checkedInAt', before: null, after: '2026-10-12T09:24:00' },
  ]);
});

test('auditDiff: a create lists every filled field, a delete every field it had; ids are never listed', () => {
  assert.deepEqual(auditDiff(null, { id: 3, title: 'Rota', body: 'New rota', pinned: false, authorName: '' }), [
    { field: 'title', before: null, after: 'Rota' },
    { field: 'body', before: null, after: 'New rota' },
    { field: 'pinned', before: null, after: false },
  ]);
  assert.deepEqual(auditDiff({ id: 9, amount: 120, category: 'travel' }, null), [
    { field: 'amount', before: 120, after: null },
    { field: 'category', before: 'travel', after: null },
  ]);
  assert.deepEqual(auditDiff({ id: 1, userId: 4, userName: 'Jo Lee', employeeId: 'LM-0010' }, { id: 1, userId: 5, userName: 'Al Bo', employeeId: 'LM-0011' }), [
    { field: 'userName', before: 'Jo Lee', after: 'Al Bo' },
    { field: 'employeeId', before: 'LM-0010', after: 'LM-0011' },
  ], 'a reference id moves with its name; the employee ID is a value');
  assert.deepEqual(auditDiff(null, null), []);
  assert.deepEqual(auditDiff('x', 4), [], 'non-objects have no fields');
});

test("auditDiff: undefined and '' count as empty, nested values compare as JSON", () => {
  assert.deepEqual(auditDiff({ phone: '', city: undefined, tags: ['a', 'b'] }, { phone: null, city: null, tags: ['a', 'b'] }), []);
  assert.deepEqual(auditDiff({ tags: ['a'] }, { tags: ['a', 'b'] }), [{ field: 'tags', before: ['a'], after: ['a', 'b'] }]);
  assert.deepEqual(auditDiff({ n: 0 }, { n: null }), [{ field: 'n', before: 0, after: null }], '0 is a value, not empty');
});

test('redaction: PINs, two-step secrets, recovery codes, session tokens and passwords never survive, at any depth', () => {
  for (const k of ['pin', 'PIN', 'currentPin', 'pin_hash', 'pinHash', 'password', 'newPassword', 'token', 'sessionToken', 'challengeToken',
    'resetToken', 'secret', 'appSecret', 'totp_secret_enc', 'totpPendingEnc', 'code', 'recoveryCode', 'recoveryCodes', 'code_hash']) {
    assert.ok(isAuditRedactedKey(k), k);
  }
  for (const k of ['pinned', 'pinSet', 'campaignCode', 'gross', 'notes', 'email', 'employeeId']) assert.ok(!isAuditRedactedKey(k), k);
  const input = { name: 'Jordan', pin: '1234', nested: { sessionToken: 'abc', list: [{ recoveryCodes: ['x'], ok: 1 }] }, fn: () => 1, skip: undefined };
  const out = redactAuditSnapshot(input);
  assert.deepEqual(out, { name: 'Jordan', pin: AUDIT_REDACTED, nested: { sessionToken: AUDIT_REDACTED, list: [{ recoveryCodes: AUDIT_REDACTED, ok: 1 }] } });
  assert.equal(input.pin, '1234', 'the input is not changed');
  assert.equal(redactAuditSnapshot(null), null);
  assert.equal(redactAuditSnapshot(5), 5);
});

test('entities: one label each, and the guard accepts only known entities', () => {
  assert.equal(AUDIT_ENTITIES.length, 12);
  for (const e of AUDIT_ENTITIES) assert.ok(AUDIT_ENTITY_LABELS[e], e);
  assert.ok(isAuditEntity('payroll_run'));
  assert.ok(!isAuditEntity('payroll'));
  assert.ok(!isAuditEntity(3));
});

test('labels: known fields, humanised unknown ones, humanised keys', () => {
  assert.equal(auditFieldLabel('checkedInAt'), 'Check-in');
  assert.equal(auditFieldLabel('table'), 'To table');
  assert.equal(auditFieldLabel('fooBarBaz'), 'Foo bar baz');
  assert.equal(auditFieldLabel('foo_bar'), 'Foo bar');
  assert.equal(auditHumanise('feel-felt-found'), 'Feel felt found');
  assert.equal(auditHumanise('field_rep'), 'Field rep');
});

test('money, days and weeks read the British way', () => {
  assert.equal(auditMoney(945), '£945');
  assert.equal(auditMoney(1050), '£1,050');
  assert.equal(auditMoney(412.5), '£412.50');
  assert.equal(auditMoney(-0), '£0');
  assert.equal(auditMoney(Number.NaN), '£0');
  assert.equal(auditDayLabel('2026-10-05'), '5 Oct');
  assert.equal(auditWeekLabel('2026-10-05'), 'w/c 5 Oct');
  assert.equal(auditDayLabel('not a date'), 'not a date');
});

test('auditValueText: empty, yes/no, money, numbers, dates, wall-clock and zoned times, enums, long text', () => {
  assert.equal(auditValueText('notes', null), '—');
  assert.equal(auditValueText('notes', ''), '—');
  assert.equal(auditValueText('pinned', true), 'yes');
  assert.equal(auditValueText('active', false), 'no');
  assert.equal(auditValueText('gross', 945), '£945');
  assert.equal(auditValueText('stops', 1240), '1,240');
  assert.equal(auditValueText('paidDate', '2026-10-16'), '16 Oct');
  assert.equal(auditValueText('checkedInAt', '2026-10-12T09:24:00'), '12 Oct 09:24');
  // 13:00 UTC on 21 Oct 2026 is 14:00 in London (BST until 25 Oct)
  assert.equal(auditValueText('scheduledAt', '2026-10-21T13:00:00.000Z'), '21 Oct, 14:00');
  assert.equal(auditValueText('scheduledAt', '2026-11-21T13:00:00.000Z'), '21 Nov, 13:00');
  assert.equal(auditValueText('position', 'field_rep'), 'field rep');
  assert.equal(auditValueText('stage', 'interview'), 'interview');
  const long = 'A very long note about the weather, the footfall and the pitch.';
  const t = auditValueText('notes', long);
  assert.ok(t.length <= 40 && t.endsWith('…'), t);
});

test('auditChangeText: up to three changes, long text named only, skip list, "and N more"', () => {
  const changes = [
    { field: 'stops', before: 60, after: 65 },
    { field: 'sales', before: 3, after: 4 },
    { field: 'notes', before: null, after: 'Rain after two, moved inside the arcade for the afternoon' },
    { field: 'checkedInAt', before: null, after: '2026-10-12T09:24:00' },
    { field: 'taps', before: 3, after: 4 },
  ];
  assert.equal(auditChangeText(changes), 'stops 60 → 65, sales 3 → 4, notes and 2 more');
  assert.equal(auditChangeText(changes, { max: 5 }), 'stops 60 → 65, sales 3 → 4, notes, check-in — → 12 Oct 09:24, taps 3 → 4');
  assert.equal(auditChangeText(changes, { skip: ['stops', 'notes'], max: 2 }), 'sales 3 → 4, check-in — → 12 Oct 09:24 and 1 more');
  assert.equal(auditChangeText([{ field: 'gross', before: 900, after: 945.5 }]), 'gross £900 → £945.50');
  assert.equal(auditChangeText([]), '');
  assert.equal(auditChangeText([{ field: 'id', before: 1, after: 2 }], { skip: ['id'] }), '');
});
