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
}

/** One one-click demo sign-in on the sign-in page. */
export interface DemoAccountItem {
  /** "Theo (Team Leader)". */
  label: string;
  role: Role;
  email: string;
  employeeId: string;
  /** Demo team accounts only: the name alone ("Theo") and the position, for the compact sign-in rows. */
  name?: string;
  position?: Position;
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
