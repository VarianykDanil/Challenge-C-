import type { UserWithTeam } from '@lm/shared';

declare global {
  namespace Express {
    interface Request {
      /** Signed-in user, set by the `authenticate` middleware when the session cookie is valid. */
      user?: UserWithTeam;
      sessionToken?: string;
    }
  }
}

export {};
