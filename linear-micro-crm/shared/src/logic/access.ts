/**
 * Sign-in safety rules shared by the server and the app: the shape of a one-time setup code, and the plain sentences
 * people see for trial mode, setup codes, the fresh two-step code and the secure-connection rule.
 */

/** Letters and digits that cannot be mistaken for each other (no I, L, O, 0 or 1): 30 symbols. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ2345678';
/** Twelve symbols in three groups of four: about 59 bits, far more than anyone can guess in seven days. */
export const SETUP_CODE_LENGTH = 12;
/** How long a setup code works. */
export const SETUP_CODE_DAYS = 7;

/** "abcd efgh-jkmn" → "ABCD-EFGH-JKMN"; null when it cannot be a setup code. */
export function normaliseSetupCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/[\s\-–—_.]/g, '');
  if (clean.length !== SETUP_CODE_LENGTH) return null;
  for (const ch of clean) if (!SETUP_CODE_ALPHABET.includes(ch)) return null;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8)}`;
}

/** True for text the setup-code box can send (the app enables its button on this). */
export const isSetupCodeComplete = (input: string): boolean => normaliseSetupCode(input) !== null;

export const ACCESS_MESSAGES = {
  /** One sentence for a wrong, used or expired code, so the answer never says which. */
  setupCodeWrong: 'That setup code is not right, or it has been used or has expired. Ask an administrator for a new one.',
  setupCodeNeeded: 'Type the setup code an administrator gave you.',
  /** Trial mode: what a one-tap demo account may not do. */
  demoRefused: (what: string) =>
    `Demo accounts cannot ${what}. Sign in with your own administrator account, or go live first (npm run golive).`,
  /** A money or secret action over plain http from another device. */
  insecure:
    'For safety this only works over a secure connection. Open Linear Hub on the office computer itself, or use its https:// address.',
  /** A setup code made over plain http from another device is not shown. */
  setupCodeWithheld:
    'The setup code is not shown over an insecure connection. An administrator gives them one on the office computer or over https: Team → their name → Edit profile → Give a setup code.',
  /** Recovery codes made over plain http from another device are not shown. */
  recoveryCodesWithheld:
    'Two-step verification is on. Your recovery codes are not shown over an insecure connection: make new ones in Settings → Security on a secure connection.',
  trialTitle: 'Trial mode: demo sign-ins are on',
  trialTitleNoDemo: 'Trial mode: the demo company is still here',
  trialBody: 'Go live before real pay or bank details go in. Run npm run golive on the computer that runs Linear Hub.',
} as const;

/** The trial sentence for the banner and the Needs-attention item. */
export function trialHeadline(demoSignIns: boolean): string {
  return demoSignIns ? ACCESS_MESSAGES.trialTitle : ACCESS_MESSAGES.trialTitleNoDemo;
}

/** "Valid until Mon 3 Nov, 14:05" for a setup code (London time). */
export function setupCodeExpiryText(expiresAt: string): string {
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `Valid until ${day}, ${time}`;
}

/** The parts of a staff account an edit can change that decide who runs the office and how someone signs in. */
export interface StaffAccess {
  role: string;
  status: string;
  email: string;
  employeeId: string;
}

/** What needs the admin's code: `what` finishes "Demo accounts cannot …"; `why` is the form's sentence. */
export interface StaffEditStepUp {
  what: string;
  why: string;
}

const STEP_UP_REASONS = {
  makeAdmin: { what: 'make someone an administrator', why: 'Making someone an administrator needs your code.' },
  stopAdmin: { what: 'stop someone being an administrator', why: 'Stopping someone being an administrator needs your code.' },
  adminLeft: { what: 'set an administrator as left', why: 'Setting an administrator as left needs your code.' },
  email: { what: 'change someone’s sign-in email', why: 'Changing someone’s sign-in email needs your code.' },
  employeeId: { what: 'change someone’s employee ID', why: 'Changing someone’s employee ID needs your code.' },
} as const satisfies Record<string, StaffEditStepUp>;

/**
 * Whether adding (`existing` null) or editing a staff account needs the acting admin's fresh two-step code: making,
 * demoting or setting as left an administrator, and changing the email or employee ID someone signs in with (case
 * does not count). The first reason, or null. One code covers a change that is sensitive in several ways.
 */
export function staffEditStepUp(existing: StaffAccess | null, patch: Partial<StaffAccess> & Record<string, unknown>): StaffEditStepUp | null {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!existing) return patch.role === 'admin' ? STEP_UP_REASONS.makeAdmin : null;
  const wasAdmin = existing.role === 'admin';
  if (!wasAdmin && patch.role === 'admin') return STEP_UP_REASONS.makeAdmin;
  if (wasAdmin && patch.role !== undefined && patch.role !== 'admin') return STEP_UP_REASONS.stopAdmin;
  if (wasAdmin && patch.status === 'left' && existing.status !== 'left') return STEP_UP_REASONS.adminLeft;
  if (typeof patch.email === 'string' && !same(patch.email, existing.email)) return STEP_UP_REASONS.email;
  if (typeof patch.employeeId === 'string' && !same(patch.employeeId, existing.employeeId)) return STEP_UP_REASONS.employeeId;
  return null;
}
