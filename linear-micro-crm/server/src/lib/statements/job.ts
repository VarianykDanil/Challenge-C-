/**
 * Release 1.3 — the statement mail job — OWNED BY P3 statements (laid down by r3-foundation).
 *
 * startStatementJob(db) is called once by index.ts at start-up (never in tests: route tests call P3's own functions
 * with a fake mail source). P3: every 15 minutes while the server runs, connect with imapflow (EXAMINE, read-only —
 * never flag, move or delete mail), search messages from the senders in campaign_statement_senders since the last seen
 * UID, store each PDF attachment under server/data/statements/, parse it and apply it when everything matched and the
 * campaign's template is known (else "Needs review" in Matt's top box). Every automatic step is audited with actor
 * "Linear Hub" (lib/audit/events.ts recordSystemEvent) and bumps the response cache (lib/cache.ts bumpDataVersion).
 * Returns a stop function. The timer is unref'd so it never keeps the process alive. Stub: starts nothing.
 */
import type { Db } from '../../db/connection.ts';

export function startStatementJob(db: Db): () => void {
  void db;
  return () => {};
}
