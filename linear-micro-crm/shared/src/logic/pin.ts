/**
 * Release 1.2 — OWNED BY U1 sign-in-pin (laid down by r2-foundation). Pure PIN rules shared by the sign-in page,
 * Settings and the server (the server hashes with scrypt; nothing here ever stores or logs a PIN).
 */
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, SESSION_IDLE_HOURS_MAX, SESSION_IDLE_HOURS_MIN, SESSION_MAX_HOURS_MAX, SESSION_MAX_HOURS_MIN } from '../types/pin.ts';

/** 4–6 digits, nothing else. */
export function isPinFormatValid(pin: unknown): pin is string {
  return typeof pin === 'string' && pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH && /^[0-9]+$/.test(pin);
}

/** Why a new PIN is refused (null when it is fine). */
export type PinProblem = 'format' | 'repeated' | 'sequence' | 'common' | 'employee-id';

export const PIN_PROBLEM_MESSAGES: Record<PinProblem, string> = {
  format: `Use ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits, numbers only.`,
  repeated: 'Avoid one digit over and over, like 0000.',
  sequence: 'Avoid a run of digits, like 1234 or 9876.',
  common: 'That PIN is one of the most guessed. Pick another.',
  'employee-id': 'Avoid the digits of your employee ID.',
};

/**
 * The most guessed PINs that the repeated-digit and run rules do not already catch (published PIN frequency studies:
 * pairs, years, keypad columns and patterns).
 */
export const COMMON_PINS: readonly string[] = [
  '1212', '1004', '2000', '6969', '1122', '1313', '2001', '1010', '2580', '0852', '1230', '2468', '1357', '7410', '0258',
  '123123', '121212', '112233', '159753', '696969', '147258', '789456', '102030', '111222', '520520', '123321', '654456',
];

const isRepeated = (pin: string) => /^(\d)\1+$/.test(pin);

/** Each digit one up (or each one down) from the last: 0123, 3456, 9876, 543210. */
function isRun(pin: string): boolean {
  const step = Number(pin[1]) - Number(pin[0]);
  if (step !== 1 && step !== -1) return false;
  for (let i = 1; i < pin.length; i++) if (Number(pin[i]) - Number(pin[i - 1]) !== step) return false;
  return true;
}

/** The digits of an employee ID ("LM-0042" → "0042"), or '' when it has fewer than four. */
export function employeeIdDigits(employeeId: string | null | undefined): string {
  const digits = (employeeId ?? '').replace(/[^0-9]/g, '');
  return digits.length >= PIN_MIN_LENGTH ? digits : '';
}

/**
 * The first rule a new PIN breaks, checked in a fixed order (format, repeated, run, common, employee ID), or null.
 * Deterministic and the same on the phone and the server, so the hint under the field always matches the refusal.
 */
export function pinProblem(pin: unknown, opts: { employeeId?: string | null } = {}): PinProblem | null {
  if (!isPinFormatValid(pin)) return 'format';
  if (isRepeated(pin)) return 'repeated';
  if (isRun(pin)) return 'sequence';
  if (COMMON_PINS.includes(pin)) return 'common';
  const id = employeeIdDigits(opts.employeeId);
  if (id && (id.includes(pin) || pin.includes(id))) return 'employee-id';
  return null;
}

/** Keeps digits only, at most six: what the PIN fields accept as typed or pasted. */
export function sanitisePinInput(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, PIN_MAX_LENGTH);
}

/** A whole number of hours inside 1–72 (the session idle timeout an admin may choose). */
export function isSessionIdleHoursValid(hours: unknown): hours is number {
  return typeof hours === 'number' && Number.isInteger(hours) && hours >= SESSION_IDLE_HOURS_MIN && hours <= SESSION_IDLE_HOURS_MAX;
}

/**
 * True when a session last seen at `lastSeenMs` has been idle for longer than `idleHours` at `nowMs`. A session exactly
 * on the limit is still alive (the comparison is strict).
 */
export function isSessionIdle(lastSeenMs: number, nowMs: number, idleHours: number): boolean {
  return nowMs - lastSeenMs > idleHours * 3_600_000;
}

// ── Release 1.4 (package S): the absolute session limit ──

/** A whole number of hours inside 4–24 (the hours-from-sign-in limit an admin may choose). */
export function isSessionMaxHoursValid(hours: unknown): hours is number {
  return typeof hours === 'number' && Number.isInteger(hours) && hours >= SESSION_MAX_HOURS_MIN && hours <= SESSION_MAX_HOURS_MAX;
}

/** When a session signed in at `signedInMs` ends (ms since the epoch). */
export const sessionEndsAtMs = (signedInMs: number, maxHours: number): number => signedInMs + maxHours * 3_600_000;

/**
 * True once `maxHours` have passed since sign-in, whatever the activity: at exactly the limit the session has ended
 * (its cookie, whose Max-Age is the same, ends then too). An unreadable sign-in time counts as ended.
 */
export function isSessionPastMaxAge(signedInMs: number, nowMs: number, maxHours: number): boolean {
  if (!Number.isFinite(signedInMs)) return true;
  return nowMs >= sessionEndsAtMs(signedInMs, maxHours);
}

/** The sentence the sign-in page shows after the automatic sign-out (and the 401's `error`). */
export const sessionMaxAgeMessage = (hours: number): string =>
  `For security you are signed out ${hours} hours after signing in. Sign in again to carry on.`;
