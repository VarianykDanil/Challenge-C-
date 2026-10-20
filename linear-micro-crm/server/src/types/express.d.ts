import type { UserWithTeam } from '@lm/shared';
import type { AuditRequestContext } from '../lib/audit.ts';

declare global {
  namespace Express {
    interface Request {
      /** Signed-in user, set by the `authenticate` middleware when the session cookie is valid. */
      user?: UserWithTeam;
      sessionToken?: string;
      /** Release 1.2 (U3, lib/audit.ts): what the audit middleware remembers between before and after the handler. */
      audit?: AuditRequestContext;
    }
  }
}

export {};
