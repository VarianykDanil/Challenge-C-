// Release 1.3 — OWNED BY P6 client-portal. The PIN sentences a client account reads: the same rules as staff
// (shared pinProblem), in a client's words — an "access code" instead of an "employee ID". Used by the "Create your
// PIN" step (auth/PinSetupStep.tsx) and the portal's Security page (pages/ClientSecurity.tsx).
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, PIN_PROBLEM_MESSAGES, type PinProblem } from '@lm/shared';

export const CLIENT_PIN_COPY = {
  rulesHint: `${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits. Not 1234, 0000 or the digits of your access code.`,
  setupBody: 'Your client account needs a PIN. You will type it after your email and access code each time you sign in, so those two alone are never enough.',
  description: `${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits you type after your email and access code. Changing it signs you out on your other devices.`,
  forgotten: 'Forgotten it? Ask Linear MCR to reset your PIN. Then sign in with your email and access code and create a new one.',
} as const;

/** The shared PIN problem in a client's words ("…of your access code" instead of "…of your employee ID"). */
export function clientPinProblemMessage(problem: PinProblem): string {
  return problem === 'employee-id' ? 'Avoid the digits of your access code.' : PIN_PROBLEM_MESSAGES[problem];
}
