/**
 * Release 1.3.1: people. Names that cope with a missing surname (the Sapiens demo accounts start with first names only;
 * Matt adds surnames in Team → Edit), who may add people and what they may set, and the sign-in details a new person
 * is given. Pure and deterministic, used by the server (POST /users, sentences that quote a name) and the client.
 */
import type { Role } from '../types.ts';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../types/pin.ts';
import { FIELD_ADD_POSITIONS, PEOPLE_ADDER_ROLES } from '../types/people.ts';

interface Named {
  firstName: string;
  lastName: string;
}

/** "Amelia Hart"; "Theo" when there is no surname — never a trailing space or a double space between the two. */
export function personName(p: Named): string {
  return [p.firstName.trim(), p.lastName.trim()].filter(Boolean).join(' ');
}

/** "AH"; "T" from the first name alone when there is no surname. */
export function personInitials(p: Named): string {
  return [p.firstName.trim(), p.lastName.trim()].filter(Boolean).map((s) => s[0]!.toUpperCase()).join('');
}

/** "Olivia K." (to tell two people with one first name apart); just "Olivia" when there is no surname. */
export function firstNameWithInitial(p: Named): string {
  const last = p.lastName.trim();
  return last ? `${p.firstName.trim()} ${last[0]!.toUpperCase()}.` : p.firstName.trim();
}

/**
 * Sort people by surname, then first name; someone without a surname sorts by their first name in its place (so Theo
 * sits among the T surnames, not at the top). Lower-case, for `localeCompare`. The SQL lists use the same rule
 * (server lib/people.ts personOrderSql: GET /users, Finance, the pay export, invoices, client accounts, "Read by").
 */
export function personSortKey(p: Named): string {
  const first = p.firstName.trim().toLowerCase();
  const last = p.lastName.trim().toLowerCase();
  return `${last || first} ${first}`;
}

/** Administrators, recruiters and leaders may add people (POST /users); reps and clients may not. */
export function canAddPeople(role: Role | null | undefined): boolean {
  return (PEOPLE_ADDER_ROLES as readonly string[]).includes(role ?? '');
}

/** Who is adding someone: their role and team (a leader's own team; teamName only words the refusal). */
export interface AddPersonActor {
  role: Role;
  teamId: number | null;
  teamName?: string | null;
}

/** The request as sent (before defaults): only what a non-administrator may or may not set. */
export interface AddPersonFields {
  role?: unknown;
  position?: unknown;
  teamId?: unknown;
  payPlanId?: unknown;
  status?: unknown;
  avatarColor?: unknown;
  employeeId?: unknown;
}

export interface AddPersonRefusal {
  status: 400 | 403;
  /** The request field the refusal is about. */
  field: string;
  message: string;
}

const sent = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

/**
 * Why POST /users refuses this person, or null when the actor may add them. An administrator may set anything (as
 * before 1.3.1). A recruiter or a leader adds field people only: role `rep` (the default), position trainee or
 * field_rep, status active (the default), the standard pay plan and avatar colour, an automatic employee ID — setting
 * any of the others is refused with 403 and a plain sentence, never silently ignored. A leader adds to their own team
 * (the default; another team → 403); a recruiter to any team, but must choose one (400). Anyone else → 403.
 * Checked in a fixed order: role, position, pay plan, status, avatar colour, employee ID, team.
 */
export function addPersonRefusal(actor: AddPersonActor, body: AddPersonFields): AddPersonRefusal | null {
  if (actor.role === 'admin') return null;
  if (!canAddPeople(actor.role)) {
    return { status: 403, field: 'role', message: 'Only administrators, recruiters and leaders can add people.' };
  }
  if (sent(body.role) && body.role !== 'rep') {
    return { status: 403, field: 'role', message: 'Only an administrator can make someone a leader, recruiter or administrator. You can add representatives.' };
  }
  if (sent(body.position) && !(FIELD_ADD_POSITIONS as readonly unknown[]).includes(body.position)) {
    return { status: 403, field: 'position', message: 'You can add trainees and field representatives. Ask an administrator to add anyone else.' };
  }
  if (sent(body.payPlanId)) {
    return { status: 403, field: 'payPlanId', message: 'Only an administrator can choose a pay plan. New people get the standard plan for their position.' };
  }
  if (sent(body.status) && body.status !== 'active') {
    return { status: 403, field: 'status', message: 'New people start as active. Only an administrator can set another status.' };
  }
  if (sent(body.avatarColor)) {
    return { status: 403, field: 'avatarColor', message: 'Only an administrator can choose an avatar colour.' };
  }
  if (sent(body.employeeId)) {
    return { status: 403, field: 'employeeId', message: 'Employee IDs are given automatically. Only an administrator can choose one.' };
  }
  if (actor.role === 'leader') {
    if (actor.teamId === null) {
      return { status: 403, field: 'teamId', message: 'You are not on a team yet, so you cannot add people. Ask an administrator to add them.' };
    }
    if (body.teamId !== undefined && body.teamId !== actor.teamId) {
      const team = actor.teamName?.trim();
      return { status: 403, field: 'teamId', message: team ? `You can add people to your own team (${team}) only.` : 'You can add people to your own team only.' };
    }
    return null;
  }
  // recruiter
  if (!sent(body.teamId)) return { status: 400, field: 'teamId', message: 'Choose a team for them.' };
  return null;
}

export interface StaffSignInText {
  firstName: string;
  email: string;
  employeeId: string;
  teamName?: string | null;
  /**
   * The sign-in page as the person adding them opened it ("http://192.168.1.20:4000/login"), when known. A localhost
   * address is left out (shareableSignInUrl).
   */
  signInUrl?: string | null;
  /** True while the office requires a PIN for everyone (Settings → Security): their first sign-in creates one. */
  pinRequired: boolean;
}

/**
 * The sign-in address to put in instructions for someone else, or null when there is none worth sending: an address
 * only the computer it was opened on can reach (localhost, 127.x.x.x, [::1], 0.0.0.0) — the owner adding people on the
 * MacBook that runs Linear Hub — would not open on the new person's phone, so the text names the sign-in page instead.
 */
export function shareableSignInUrl(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  const host = /^https?:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(u)?.[1]?.toLowerCase().replace(/\.$/, '') ?? '';
  if (host === 'localhost' || host === '[::1]' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host)) return null;
  return u;
}

/** The plain text a recruiter or leader sends a new person: where to sign in, with what, and (if asked) the PIN step. */
export function staffSignInInstructions(t: StaffSignInText): string {
  const url = shareableSignInUrl(t.signInUrl);
  const where = url ? `Open ${url}` : 'Open the Linear Hub sign-in page';
  const team = t.teamName?.trim();
  const steps = [
    `1. ${where}.`,
    `2. Enter your email (${t.email}) and your employee ID: ${t.employeeId}.`,
  ];
  if (t.pinRequired) {
    steps.push(`3. The first time, create a PIN of ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits. You will type it after your email and employee ID each time you sign in.`);
  }
  return [
    `Hello ${t.firstName.trim() || 'there'},`,
    '',
    `You have a Linear Hub account with Linear MCR${team ? ` (${team} team)` : ''}.`,
    '',
    ...steps,
    '',
    'Keep your employee ID to yourself: it is how you sign in.',
  ].join('\n');
}
