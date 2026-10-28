/**
 * Audit specs for the sign-in safety routes (setup codes), in the shape of lib/auditSpecs.ts, registered through
 * ./registry.ts. Rows never hold a setup code or its hash: only who got a new code, and who gave it.
 *
 *   POST /users/:id/setup-code   "Gave Rita Rep a new setup code" — filed under the person, the admin as the actor.
 *
 * The other routes this release changed keep their specs: POST /users (Added …), PATCH /users/:id (Updated … with the
 * role or email change), POST /users/:id/2fa/reset, POST /auth/pin/reset/:userId, the client account resets and the
 * sign-in (lib/auditSpecs.ts: "Signed in with a setup code"; a wrong one is a failed sign-in, lib/audit/signIns.ts).
 */
import { get, type Db } from '../../db/connection.ts';
import type { AuditCall, AuditRouteSpec } from '../auditSpecs.ts';

const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

const nameOf = (db: Db, id: number) =>
  get<{ name: string }>(db, `SELECT TRIM(first_name || ' ' || last_name) AS name FROM users WHERE id = ?`, [id])?.name || 'someone';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  {
    method: 'POST',
    pattern: '/users/:id/setup-code',
    before: (_db: Db, call: AuditCall) => ({ id: toId(call.params.id) }),
    after(db, _done, state) {
      const id = state?.id ?? null;
      if (!id) return [];
      return [{ entity: 'user', entityId: id, summary: `Gave ${nameOf(db, id)} a new setup code`, before: null, after: { setupCode: 'issued' } }];
    },
  } satisfies AuditRouteSpec<{ id: number | null }>,
];
