// Release 1.3 fix round (I3) — OWNED BY P4 pdf-everywhere. The words of the audit PDF that do not come from the
// trail itself: who a row names and how much of the trail the file holds. Pure and free of app aliases, so the
// server's PDF test can run it (server/src/test/pdf-export.test.ts); auditPdf.ts builds the file with them.
import { isAuditAttemptOnAccount, isAuditFailedAttempt, type AuditEntryDetail } from '@lm/shared';

const COUNT = new Intl.NumberFormat('en-GB');
const entries = (n: number) => `${COUNT.format(n)} ${n === 1 ? 'entry' : 'entries'}`;

/**
 * The line that says how much of the trail the PDF holds, when that is not simply everything that matches. Without
 * the total (a page that passes only the entries on screen) it cannot know, so it says the file holds the entries
 * on screen and that more may match.
 */
export function auditCoverageLine(printed: number, total: number | undefined, allPages: boolean): string | null {
  if (total === undefined) return printed > 0 ? `The ${entries(printed)} on screen (more may match the filters)` : null;
  if (total <= printed) return null;
  return allPages
    ? `The newest ${COUNT.format(printed)} of ${COUNT.format(total)} matching entries`
    : `The ${entries(printed)} on screen, of ${COUNT.format(total)} that match`;
}

/**
 * Who a row names, as the Audit page says it (features/audit/kinds.tsx auditActorName, from the same shared rules):
 * the person who acted; "Attempt on Jordan Lee's account" for a failed try on the sign-in page (whoever typed it may
 * not be Jordan); "Unknown person" for a try with an email nobody has; otherwise "Linear Hub" (an automatic step).
 */
export function auditPdfWho(entry: Pick<AuditEntryDetail, 'userName' | 'kind' | 'action' | 'after'>): string {
  if (entry.userName) return isAuditAttemptOnAccount(entry) ? `Attempt on ${entry.userName}'s account` : entry.userName;
  return isAuditFailedAttempt(entry) ? 'Unknown person' : 'Linear Hub';
}
