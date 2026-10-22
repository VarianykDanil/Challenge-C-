/**
 * Release 1.3 — OWNED BY P2 invoices. Kind 'invoices' in the Needs-attention feed (dashboard top box and the bell):
 *
 *  - the field person (rep, leader): each of their invoices still to accept ("Check and accept your invoice"; "Your
 *    invoice was reissued" for a new version; "… by 12:00 tomorrow" once the deadline is under 24 hours away), and the
 *    office's answer to their dispute when it kept the invoice as it was (for 7 days). Always severity 'info': they
 *    sit in the bell and the top box but never pop up as a toast, which covered the open invoice's own buttons
 *    (Accept invoice, Send to the office) on phones and offered "Open My pay" on My pay itself;
 *  - admin: each disputed invoice ("Harry Donnelly says something's wrong"), and — on the day before and the day of the
 *    deadline — how many of the next payday's invoices are still waiting to be accepted.
 *
 * Read-only (the feed is cached; the invoices job writes the statuses): an issued invoice past its deadline counts as
 * deemed accepted here too. One grouped statement per caller (the feed's 1.1 budget of 12 holds with every provider
 * merged): the person's own invoices, or for an admin the disputes and the waiting count together.
 */
import { effectiveInvoiceStatus, isInvoicedRole, type AttentionItem } from '@lm/shared';
import { all } from '../../db/connection.ts';
import { addDays, formatShort, formatWeek, toBusinessISO } from '../dates.ts';
import type { AttentionProvider } from './types.ts';

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => GBP.format(n);
/** "12:00 Thu 22 Oct" from a naive London deadline. */
const deadlineText = (deadline: string) => `${deadline.slice(11, 16)} ${formatShort(deadline.slice(0, 10))}`;
const hoursUntil = (fromLocal: string, toLocal: string) => (Date.parse(`${toLocal}Z`) - Date.parse(`${fromLocal}Z`)) / 3_600_000;

interface OwnRow {
  id: number;
  number: string;
  version: number;
  status: 'issued' | 'accepted' | 'deemed_accepted' | 'disputed' | 'resolved';
  issuedAt: string;
  deemAt: string;
  total: number;
  weekStart: string;
  resolvedAt: string | null;
  resolutionAction: 'reissue' | 'keep' | null;
  resolutionNote: string | null;
}

interface DisputeRow {
  id: number;
  number: string;
  version: number;
  total: number;
  weekStart: string;
  disputedAt: string;
  reason: string;
  userName: string;
}

/** One row per disputed invoice (or a single row of nulls when none), each carrying the waiting count. */
type AdminRow = { [K in keyof DisputeRow]: DisputeRow[K] | null } & { waitingN: number; waitingDeemAt: string | null; waitingPayday: string | null };

export const provider: AttentionProvider = {
  name: 'invoices',
  items(db, me, now) {
    const items: AttentionItem[] = [];
    // the business clock as naive London time (the deadlines are written so)
    const local = toBusinessISO(new Date(now.nowISO));

    if (isInvoicedRole(me.role)) {
      const own = all<OwnRow>(
        db,
        `SELECT i.id, i.number, i.version, i.status, i.issued_at AS issuedAt, i.deem_at AS deemAt, i.total, p.week_start AS weekStart,
                i.resolved_at AS resolvedAt, i.resolution_action AS resolutionAction, i.resolution_note AS resolutionNote
         FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
         WHERE i.user_id = ? AND ((i.status = 'issued' AND p.status IN ('pending', 'failed')) OR (i.status = 'resolved' AND i.resolved_at >= ?))
         ORDER BY p.week_start`,
        [me.id, new Date(Date.parse(now.nowISO) - 7 * 86_400_000).toISOString()],
      );
      for (const r of own) {
        if (r.status === 'resolved') {
          items.push({
            key: `invoices:resolved:${r.id}:${r.resolvedAt}`,
            kind: 'invoices',
            severity: 'info',
            title: 'The office replied about your invoice',
            body: `${formatWeek(r.weekStart)}, ${money(r.total)}: kept as it is. "${(r.resolutionNote ?? '').slice(0, 140)}"`,
            href: '/finance?tab=me',
            actionLabel: 'Open My pay',
            at: r.resolvedAt ?? r.issuedAt,
          });
          continue;
        }
        if (effectiveInvoiceStatus(r.status, r.deemAt, local) !== 'issued') continue;
        const soon = hoursUntil(local, r.deemAt) <= 24;
        const reissued = r.version > 1;
        items.push({
          key: `invoices:open:${r.id}:v${r.version}`,
          kind: 'invoices',
          severity: 'info',
          title: reissued
            ? (r.resolutionAction === 'reissue' ? 'The office fixed your invoice' : 'Your invoice was reissued')
            : soon ? `Check and accept your invoice by ${deadlineText(r.deemAt)}` : 'Check and accept your invoice',
          body: `${formatWeek(r.weekStart)}, ${money(r.total)}. Accept it or say what's wrong by ${deadlineText(r.deemAt)}; after that it counts as accepted.`,
          href: '/finance?tab=me',
          actionLabel: 'Open My pay',
          at: r.issuedAt,
        });
      }
    }

    if (me.role === 'admin') {
      // One statement: the next deadline's invoices still waiting (a one-row count, kept by the LEFT JOIN when nothing is
      // disputed) beside each disputed invoice.
      const rows = all<AdminRow>(
        db,
        `SELECT w.n AS waitingN, w.deemAt AS waitingDeemAt, w.payday AS waitingPayday, d.*
         FROM (SELECT COUNT(*) AS n, MIN(i.deem_at) AS deemAt, MIN(p.due_date) AS payday FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
               WHERE i.status = 'issued' AND p.status IN ('pending', 'failed') AND i.deem_at > ?
                 AND i.deem_at <= ?) w
         LEFT JOIN (SELECT i.id, i.number, i.version, i.total, p.week_start AS weekStart, i.disputed_at AS disputedAt, i.dispute_reason AS reason,
                           u.first_name || ' ' || u.last_name AS userName
                    FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id JOIN users u ON u.id = i.user_id
                    WHERE i.status = 'disputed') d ON 1
         ORDER BY d.disputedAt`,
        [local, `${addDays(local.slice(0, 10), 1)}T23:59:59`],
      );
      const disputes = rows.filter((r): r is AdminRow & DisputeRow => r.id !== null);
      for (const d of disputes) {
        items.push({
          key: `invoices:dispute:${d.id}:v${d.version}`,
          kind: 'invoices',
          severity: 'warning',
          title: `${d.userName} says something's wrong`,
          body: `Invoice ${d.number}, ${formatWeek(d.weekStart)}, ${money(d.total)}: "${d.reason.slice(0, 140)}"`,
          href: '/finance?tab=company#disputes',
          actionLabel: 'Review the dispute',
          at: d.disputedAt,
        });
      }
      // the next deadline's invoices still waiting, on the day before and the day of that deadline
      const waiting = rows[0] ? { n: rows[0].waitingN, deemAt: rows[0].waitingDeemAt, payday: rows[0].waitingPayday } : undefined;
      if (waiting && waiting.n > 0 && waiting.deemAt) {
        items.push({
          key: `invoices:waiting:${waiting.deemAt.slice(0, 10)}`,
          kind: 'invoices',
          severity: 'info',
          title: `${waiting.n === 1 ? '1 invoice' : `${waiting.n} invoices`} not accepted yet`,
          body: `They count as accepted at ${deadlineText(waiting.deemAt)} unless disputed. Until then, Mark paid needs a reason.`,
          href: '/finance?tab=company#runs',
          actionLabel: 'Open Runs to pay',
          at: now.nowISO,
          count: waiting.n,
        });
      }
    }
    return items;
  },
};
