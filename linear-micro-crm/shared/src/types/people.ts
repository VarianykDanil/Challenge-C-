/**
 * Release 1.3.1: adding people (POST /users by an administrator, a recruiter or a leader) and the demo teams on the
 * sign-in page (GET /auth/demo-accounts).
 */
import type { Position, Role, UserWithTeam } from '../types.ts';

/** Who may add people: administrators (any role), recruiters (any team) and leaders (their own team). */
export const PEOPLE_ADDER_ROLES = ['admin', 'recruiter', 'leader'] as const satisfies readonly Role[];

/** The positions a recruiter or a leader may give a new person (always with the role `rep`). */
export const FIELD_ADD_POSITIONS = ['trainee', 'field_rep'] as const satisfies readonly Position[];
export type FieldAddPosition = (typeof FIELD_ADD_POSITIONS)[number];

/**
 * The 201 answer of POST /users: the new person as GET /users/:id shows them, except that the employee ID is always
 * filled in — this once, for a recruiter or a leader too, so they can pass on the sign-in details. Every later read
 * blanks it again for anyone but an administrator and the person. `signInInstructions` is the plain text to send them
 * (shared `staffSignInInstructions`, with the `signInUrl` the request gave).
 */
export interface AddPersonResult extends UserWithTeam {
  signInInstructions?: string;
  /**
   * The new account's one-time setup code ("ABCD-EFGH-JKMN"), shown this once: they need it, with their email and
   * employee ID, to sign in the first time. Null when it was not shown (an insecure connection from another device;
   * `setupCodeWithheld`): an administrator gives them one later from Team.
   */
  setupCode?: string | null;
  /** When the setup code stops working (ISO). */
  setupCodeExpiresAt?: string;
  setupCodeWithheld?: boolean;
}

/** One one-click demo sign-in on the sign-in page. */
export interface DemoAccountItem {
  /** "Theo (Team Leader)". */
  label: string;
  role: Role;
  email: string;
  employeeId: string;
  /** Demo team and demo client accounts: the name alone ("Theo", "Hannah Price"). Demo team accounts: the position. */
  name?: string;
  position?: Position;
  /** Release 1.3.1, demo client accounts only: the organisation ("Breast Cancer Now") and its campaign's sector ("charity"). */
  organisation?: string;
  sector?: string;
}

/**
 * Release 1.3.1: a demo team's accounts on the sign-in page (the Sapiens team): listed only on a demo database whose
 * seed or start-up step recorded them (meta `seed_demo_teams`), never matched by email or employee ID alone.
 */
export interface DemoTeamAccounts {
  name: string;
  color: string;
  accounts: DemoAccountItem[];
}

/**
 * POST /recruitment/candidates/:id/stage to `hired` answers the candidate plus this, once: the new account's sign-in
 * details for whoever hired them to pass on (the employee ID and the one-time setup code are never shown again).
 */
export interface HiredSignIn {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
  employeeId: string;
  teamName: string | null;
  /** Null when it was not shown (an insecure connection from another device): an administrator gives one later. */
  setupCode: string | null;
  setupCodeExpiresAt?: string;
  setupCodeWithheld?: boolean;
  signInInstructions: string;
}
