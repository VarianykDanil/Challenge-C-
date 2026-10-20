import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_PINS, employeeIdDigits, isPinFormatValid, isSessionIdle, isSessionIdleHoursValid, pinProblem, sanitisePinInput } from './pin.ts';

test('isPinFormatValid: 4–6 digits only', () => {
  for (const ok of ['0428', '04281', '042817']) assert.equal(isPinFormatValid(ok), true, ok);
  for (const bad of ['', '123', '1234567', '12a4', ' 1234', '12 34', 1234, null, undefined, '١٢٣٤']) assert.equal(isPinFormatValid(bad), false, String(bad));
});

test('pinProblem: format first', () => {
  assert.equal(pinProblem('12'), 'format');
  assert.equal(pinProblem('1234567'), 'format');
  assert.equal(pinProblem(undefined), 'format');
});

test('pinProblem: one digit repeated', () => {
  for (const p of ['0000', '1111', '99999', '777777']) assert.equal(pinProblem(p), 'repeated', p);
});

test('pinProblem: runs up or down, any length', () => {
  for (const p of ['1234', '0123', '3456', '6789', '9876', '4321', '12345', '123456', '543210', '654321']) assert.equal(pinProblem(p), 'sequence', p);
  // Not a run: wraps, gaps, mixed directions
  for (const p of ['7890', '1235', '1243', '2468']) assert.notEqual(pinProblem(p), 'sequence', p);
});

test('pinProblem: the most guessed PINs', () => {
  for (const p of COMMON_PINS) assert.equal(pinProblem(p), 'common', p);
  assert.equal(pinProblem('2468'), 'common');
});

test('pinProblem: the digits of the employee ID', () => {
  assert.equal(employeeIdDigits('LM-0042'), '0042');
  assert.equal(employeeIdDigits('LM-12'), '', 'fewer than four digits never block anything');
  assert.equal(pinProblem('0042', { employeeId: 'LM-0042' }), 'employee-id');
  assert.equal(pinProblem('004299', { employeeId: 'lm-0042' }), 'employee-id', 'contains the ID');
  assert.equal(pinProblem('4210', { employeeId: 'LM-14210' }), 'employee-id', 'inside a longer ID');
  assert.equal(pinProblem('0042'), null, 'without an ID it is fine');
  assert.equal(pinProblem('5821', { employeeId: 'LM-0042' }), null);
});

test('pinProblem: a good PIN passes, deterministically', () => {
  for (const p of ['5821', '0428', '73915', '480613']) {
    assert.equal(pinProblem(p, { employeeId: 'LM-0010' }), null, p);
    assert.equal(pinProblem(p, { employeeId: 'LM-0010' }), pinProblem(p, { employeeId: 'LM-0010' }));
  }
});

test('sanitisePinInput keeps at most six digits', () => {
  assert.equal(sanitisePinInput('12 34'), '1234');
  assert.equal(sanitisePinInput('1a2b3c4d5e6f7'), '123456');
  assert.equal(sanitisePinInput(''), '');
});

test('session idle hours: whole hours 1–72', () => {
  for (const ok of [1, 12, 72]) assert.equal(isSessionIdleHoursValid(ok), true, String(ok));
  for (const bad of [0, 73, 1.5, -1, '12', null, Number.NaN]) assert.equal(isSessionIdleHoursValid(bad), false, String(bad));
});

test('isSessionIdle: strictly past the limit', () => {
  const h = 3_600_000;
  assert.equal(isSessionIdle(0, 12 * h, 12), false, 'exactly on the limit is alive');
  assert.equal(isSessionIdle(0, 12 * h + 1, 12), true);
  assert.equal(isSessionIdle(0, 30 * 60_000, 1), false);
});
