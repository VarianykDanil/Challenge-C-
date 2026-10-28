/**
 * Sign-in safety: trial mode, one-time setup codes, the fresh two-step code for sensitive admin actions, and the
 * secure-connection rule.
 *
 *  - POST /auth/login            { email, employeeId, pin?, setupCode? }. An account that has not finished setting up
 *                                (no two-step yet, or an admin reset its PIN) answers 200 LoginSetupCodeChallenge with
 *                                no session until a valid setup code comes with the same body; a wrong, used or expired
 *                                code answers 401 with `details: LoginSetupCodeDetails`.
 *  - POST /users/:id/setup-code  { code }  → SetupCodeIssued (admin; a fresh two-step code; secure connection only)
 *  - POST /users                 the 201 answer also carries `setupCode` (AddPersonResult)
 *  - POST /users/:id/2fa/reset   { code }  → SetupCodeIssued
 *  - POST /auth/pin/reset/:id    { code }  → SetupCodeIssued
 *  - GET  /auth/me               an administrator's answer also carries `trial` while the database is in trial mode
 */

/** Trial mode as an administrator sees it (GET /auth/me `trial`, the banner and the Needs-attention item). */
export interface TrialStatus {
  /** The database still holds the demo company (the seed set trial mode; `npm run golive` ends it). */
  trialMode: boolean;
  /** The one-tap demo sign-ins work right now (trial mode, LM_DEMO_ACCOUNTS is not 0, the demo staff are intact). */
  demoSignIns: boolean;
}

/** A one-time setup code as it is shown once: in the Sign-in details dialog, or printed by a command. */
export interface SetupCodeIssued {
  userId: number;
  /** "ABCD-EFGH-JKMN". Null when it was not shown because the request did not come over a secure connection. */
  setupCode: string | null;
  /** When it stops working (ISO, 7 days after it was made). */
  expiresAt: string;
  /** True when the code was made but not shown (insecure connection from another device): issue a new one securely. */
  withheld?: boolean;
}

/**
 * POST /auth/login answers 200 with this (no session cookie) when the email and employee ID are right but the account
 * still has to finish setting up: the page asks for the setup code and sends the same body again with `setupCode`.
 * Counts against the login rate limit, like the PIN step.
 */
export interface LoginSetupCodeChallenge {
  requiresSetupCode: true;
}

/** Carried in `details` of the 401 for a wrong, used or expired setup code (one message for all three). */
export interface LoginSetupCodeDetails {
  requiresSetupCode: true;
  reason: 'wrong';
}

/** The 403 a demo sign-in account gets for an action only a real account may take (trial mode). */
export interface TrialDemoRefusal {
  error: string;
  details: { code: 'demo_account'; trialMode: true };
}

/** The 403 for a money or secret action over an insecure connection from another device. */
export interface InsecureConnectionRefusal {
  error: string;
  details: { code: 'insecure_connection' };
}
