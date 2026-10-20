/**
 * Release 1.2 — OWNED BY U1 sign-in-pin (laid down by r2-foundation). Pure PIN rules shared by the sign-in page,
 * Settings and the server (the server hashes with scrypt; nothing here ever stores or logs a PIN).
 */
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../types/pin.ts';

/** 4–6 digits, nothing else. (U1 may add rules such as refusing 0000 or 1234.) */
export function isPinFormatValid(pin: unknown): pin is string {
  return typeof pin === 'string' && pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH && /^\d+$/.test(pin);
}
