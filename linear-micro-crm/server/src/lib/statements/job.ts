/**
 * Release 1.3 — the statement mail job — OWNED BY P3 statements (laid down by r3-foundation).
 *
 * startStatementJob(db) is called once by index.ts at start-up (never in tests: tests call checkMail with a fake mail
 * source). Every 15 minutes while the server runs — and once a minute after start-up — it checks Matt's Gmail when the
 * check is switched on in Settings → Integrations (an address and an app password saved): EXAMINE (read-only — never
 * flag, move or delete mail), messages from the senders in campaign_statement_senders since the last seen UID, each PDF
 * attachment stored under server/data/statements/, parsed and applied when everything matched and the campaign's columns
 * are saved (else "Needs review" in Matt's top box). Every automatic step is audited with actor "Linear Hub"
 * (lib/audit/events.ts recordSystemEvent) and bumps the response cache. LM_STATEMENTS_JOB=0 turns it off. Returns a
 * stop function; the timers are unref'd so they never keep the process alive.
 */
import { STATEMENT_CHECK_EVERY_MINUTES } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { checkMail, readMailState } from './mail.ts';

const FIRST_CHECK_AFTER_MS = 60_000;

/** One automatic check, when it is switched on; problems are kept in the mail settings, never thrown. */
export async function runStatementJobOnce(db: Db): Promise<void> {
  const s = readMailState(db);
  if (!s.enabled || !s.address || !s.passwordEnc) return;
  try {
    const r = await checkMail(db);
    if (r.fetched) console.log(`Statements: fetched ${r.fetched} from Gmail (${r.applied} applied automatically)`);
  } catch (err) {
    console.error('Statements: the Gmail check failed', err);
  }
}

export function startStatementJob(db: Db): () => void {
  if (process.env.LM_STATEMENTS_JOB?.trim() === '0') return () => {};
  const tick = () => void runStatementJobOnce(db);
  const first = setTimeout(tick, FIRST_CHECK_AFTER_MS);
  first.unref();
  const every = setInterval(tick, STATEMENT_CHECK_EVERY_MINUTES * 60_000);
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
