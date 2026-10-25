// Release 1.2 — OWNED BY U1 sign-in-pin. Every sentence the PIN screens show (British English, kind, specific).
import { PIN_LOCK_AFTER_FAILURES, PIN_LOCK_MINUTES, PIN_MAX_LENGTH, PIN_MIN_LENGTH, SESSION_IDLE_HOURS_DEFAULT, SESSION_MAX_HOURS_DEFAULT } from '@lm/shared';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// London wall-clock, whatever zone the phone or laptop is set to, so the card says exactly what the server's 423 says.
const LONDON_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const LONDON_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const LONDON_DAY_MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });

/**
 * When a PIN lock ends, as the server's 423 sentence says it: "14:35", "14:35 tomorrow" or "00:00 on 23 Oct" in London
 * time (the minute rounded up, so trying at the time shown always works). '' for a missing or unreadable time.
 */
export function pinUnlockTime(iso: string | null | undefined, now = new Date()): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return '';
  const end = new Date(Math.ceil(ms / 60_000) * 60_000);
  const time = LONDON_TIME.format(end);
  const days = Math.round((Date.parse(LONDON_DATE.format(end)) - Date.parse(LONDON_DATE.format(now))) / 86_400_000);
  if (days <= 0) return time;
  return days === 1 ? `${time} tomorrow` : `${time} on ${LONDON_DAY_MONTH.format(end)}`;
}

export const PIN_COPY = {
  rulesHint: `${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits. Not 1234, 0000 or the digits of your employee ID.`,
  mismatch: 'The two PINs don’t match. Type the same PIN twice.',
  show: 'Show PIN',
  hide: 'Hide PIN',
  login: {
    heading: 'Enter your PIN',
    body: `The ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digit PIN you chose for your account.`,
    signingInAs: 'Signing in as',
    label: 'PIN',
    submit: 'Sign in',
    /** The only way back on the PIN step (the header's "Back" to the public page shows on step one only). */
    back: 'Back to email and employee ID',
    /** Release 1.4: a client account signs in with an access code. */
    backClient: 'Back to email and access code',
    forgot: 'Forgotten it? An administrator can reset your PIN, then you sign in with your email and employee ID.',
    wrong: 'That PIN isn’t right. Check it and try again.',
    triesLeft: (n: number) => `${plural(n, 'try', 'tries')} left before your PIN locks for a while.`,
    /** Only when the server's own sentence (with the unlock time) is missing. */
    locked: 'Too many wrong PINs. Try again later, or ask an administrator to reset your PIN.',
    tooMany: 'Too many attempts. Wait a few minutes before trying again.',
  },
  setup: {
    eyebrow: 'One more step',
    heading: 'Create your PIN',
    body: 'Your administrator now asks everyone for a PIN when they sign in. You will type it after your email and employee ID, so those two alone are never enough.',
    signedInAs: 'Signed in as',
    pinLabel: 'New PIN',
    confirmLabel: 'Type it again',
    save: 'Save PIN',
    signOut: 'Sign out',
    savedToast: 'PIN saved',
    savedToastBody: 'You will enter it each time you sign in. Any other devices have been signed out.',
  },
  twoFactor: {
    eyebrow: 'One more step',
    heading: 'Set up two-step verification',
    // Release 1.4 (package S): everyone, not only administrators
    body: 'Linear Hub now asks everyone for a 6-digit code from an authenticator app when they sign in. It takes about two minutes, and you only do it once.',
    clientBody: 'Your client account now needs a 6-digit code from an authenticator app each time you sign in, after your PIN. It takes about two minutes, and you only do it once.',
    start: 'Set up now',
    signOut: 'Sign out',
  },
  settings: {
    title: 'Sign-in PIN',
    description: `${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits you type after your email and employee ID. Setting or changing it signs you out on your other devices.`,
    on: 'On',
    off: 'Off',
    locked: 'Locked',
    required: 'Required',
    setAt: 'Set on',
    offHint: 'No PIN yet. Add one so your email and employee ID alone can never open your account.',
    lockedHint: (time: string) =>
      time
        ? `Locked after too many wrong PINs. Try again after ${time}, or ask an administrator to reset it.`
        : `Locked after too many wrong PINs. It unlocks by itself after a wait, or an administrator can reset it.`,
    lockRule: `${PIN_LOCK_AFTER_FAILURES} wrong PINs in a row lock it for ${PIN_LOCK_MINUTES} minutes, longer if it happens again.`,
    requiredHint: 'A PIN is required for everyone, so you can change yours but not remove it.',
    set: 'Set a PIN',
    change: 'Change PIN',
    remove: 'Remove',
    setTitle: 'Set your PIN',
    changeTitle: 'Change your PIN',
    removeTitle: 'Remove your PIN',
    removeBody: 'You will sign in with just your email and employee ID again. Enter your PIN to confirm.',
    currentLabel: 'Current PIN',
    currentNeeded: 'Enter your current PIN.',
    newLabel: 'New PIN',
    confirmLabel: 'Type it again',
    save: 'Save PIN',
    savedToast: 'PIN saved',
    savedToastBody: 'Any other devices have been signed out.',
    removedToast: 'PIN removed',
  },
  rules: {
    title: 'Sign-in rules',
    description: 'For everyone who signs in to Linear Hub. Changes apply straight away.',
    requirePin: 'Require a PIN for everyone',
    requirePinBody: 'Anyone without a PIN creates one before they can carry on, including people signed in now.',
    requirePinNeedsOwn: 'Set your own PIN first, so the rule cannot lock you out.',
    requirePinConfirmTitle: 'Require a PIN for everyone?',
    requirePinConfirmBody: 'Everyone without a PIN will be asked to create one before they can carry on, including anyone signed in right now. Demo accounts too.',
    // Release 1.4 (package S): no longer a switch — a plain line
    twoFactorEveryone: 'Two-step verification is required for everyone',
    twoFactorEveryoneBody:
      'Everyone, charity and client accounts included, signs in with a 6-digit code from an authenticator app. Anyone without it sets it up at their next sign-in. The demo sign-in accounts are left out while Linear Hub is still the demo.',
    maxAge: 'Sign out after',
    maxAgeHint: (hours: number) =>
      `Everyone is signed out ${plural(hours, 'hour', 'hours')} after signing in, whatever they are doing, and signs in again with their code. A shorter time applies at once; a longer one from each person’s next sign-in.${hours === SESSION_MAX_HOURS_DEFAULT ? '' : ` The default is ${SESSION_MAX_HOURS_DEFAULT} hours.`}`,
    turnOn: 'Turn on',
    idle: 'Sign out after inactivity',
    idleHint: (hours: number) =>
      `A device unused for ${plural(hours, 'hour', 'hours')} signs out by itself.${hours === SESSION_IDLE_HOURS_DEFAULT ? '' : ` The default is ${SESSION_IDLE_HOURS_DEFAULT} hours.`}`,
    hours: (n: number) => plural(n, 'hour', 'hours'),
    savedToast: 'Sign-in rules saved',
  },
  admin: {
    title: 'Sign-in PIN',
    body: 'Reset it if they have forgotten it, or to lift a lock before it ends by itself. They are signed out everywhere, sign in with their email and employee ID, and choose a new PIN.',
    lockedUntil: (time: string) => `until ${time}`,
    reset: 'Reset PIN',
    confirmTitle: 'Reset their PIN?',
    confirmBody: 'will be signed out of every device and will sign in with just their email and employee ID until they choose a new PIN.',
    toast: 'PIN reset',
    set: 'PIN set',
    none: 'No PIN',
    locked: 'Locked',
  },
} as const;
