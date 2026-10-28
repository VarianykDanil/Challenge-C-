// What a number typed into a Stepper means while it is being typed (stepperValue.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedStepperValue } from './stepperValue.ts';

test('a whole number in range counts at once, keystroke by keystroke (so the form checks it as you type)', () => {
  assert.deepEqual(typedStepperValue('9', 0, 999, 1), { value: 9, outOfRange: false });
  assert.deepEqual(typedStepperValue('12', 0, 999, 1), { value: 12, outOfRange: false });
  assert.deepEqual(typedStepperValue('0', 0, 999, 1), { value: 0, outOfRange: false });
});

test('half-typed or empty input changes nothing yet', () => {
  assert.deepEqual(typedStepperValue('', 0, 999, 1), { value: null, outOfRange: false });
  assert.deepEqual(typedStepperValue('-', 0, 999, 1), { value: null, outOfRange: false });
});

test('a number past the limits is flagged while typing (it is pulled into range when the field is left)', () => {
  assert.deepEqual(typedStepperValue('1500', 0, 999, 1), { value: null, outOfRange: true });
  assert.deepEqual(typedStepperValue('-3', 0, 999, 1), { value: null, outOfRange: true });
});

test('steps round to the nearest step', () => {
  assert.deepEqual(typedStepperValue('7', 0, 100, 5), { value: 5, outOfRange: false });
});
