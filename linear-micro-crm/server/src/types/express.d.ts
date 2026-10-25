import type { SessionEndedDetails, SessionInfo, UserWithTeam } from '@lm/shared';
import type { AuditRequestContext } from '../lib/audit.ts';

declare global {
  namespace Express {
    interface Request {
      /** Signed-in user, set by the `authenticate` middleware when the session cookie is valid. */
      user?: UserWithTeam;
      sessionToken?: string;
      /** Release 1.2 (U3, lib/audit.ts): what the audit middleware remembers between before and after the handler. */
      audit?: AuditRequestContext;
      /**
       * Release 1.4 (package S): set by `authenticate` when this request found the session past its hours-from-sign-in
       * limit (and ended it), so the 401 can say why.
       */
      sessionEnded?: SessionEndedDetails;
      /** Release 1.4: when the signed-in session ends (GET /auth/me answers it). */
      sessionInfo?: SessionInfo;
    }
  }
}

export {};
