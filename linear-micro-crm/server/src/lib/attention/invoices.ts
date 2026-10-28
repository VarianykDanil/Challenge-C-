/**
 * Release 1.3 — OWNED BY P2 invoices. Kind 'invoices' in the Needs-attention feed (dashboard top box and the bell):
 *
 *  - the field person (rep, leader): each of their invoices still to accept ("Check and accept your invoice"; "Your
 *    invoice changed: £300.00 (was £345.00)" for a new version whose total moved, "Your invoice was reissued" when only
 *    the paid lines did; "… by 12:00 Thu 22 Oct" once the deadline is under 24 hours away), and the
 *    office's answer to their dispute when it kept the invoice as it was (for 7 days). Always severity 'info': they
 *    sit in the bell and the top box but never pop up as a toast, which covered the open invoice's own buttons
 *    (Accept invoice, Send to the office) on phones and offered "Open My pay" on My pay itself;
 *  - admin: each disputed invoice ("Harry Donnelly says something's wrong"), — on the day before and the day of the
 *    deadline — how many of the next payday's invoices are still waiting to be accepted, and (MON-7) each VAT number
 *    waiting for the office to check it ("Check Remy Rep's VAT number"; no VAT is added until an administrator who is
 *    not the person, and did not type it in, confirms it). Not shown to the administrator the number belongs to.
 *
 * Read-only (the feed is cached; the invoices job writes the statuses): an issued invoice past its deadline counts as
 * deemed accepted here too. One grouped query per caller (the person's own invoices; the admin's disputes and the
 * waiting count share one UNION ALL), so the feed's 12-statement budget holds with every 1.3 provider merged.
 */
import { effectiveInvoiceStatus, formatVatNumber, invoiceDeadlineText, isInvoicedRole, type AttentionItem } from '@lm/shared';
import { all } from '../../db/connection.ts';
import { addDays, formatWeek, toBusinessISO } from '../dates.ts';
import type { AttentionProvider } from './types.ts';

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => GBP.format(n);
/** "12:00 Thu 22 Oct" from a naive London deadline ("midnight on Thu 22 Oct" for 00:00 on the Friday). */
const deadlineText = (deadline: string) => invoiceDeadlineText(deadline);
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
  /** The total of the version this one replaced (null for version 1). */
  previousTotal: number | null;
}

/**
 * One row per disputed invoice (kind 'dispute'), one row with the waiting count (kind 'waiting'), and one row per VAT
 * number waiting for the office (kind 'vat': id = the person, number = the VAT number, disputedAt = when it was typed
 * in, reason = who typed it in, n = 1 when the viewer typed it in themselves).
 */
interface OfficeRow {
  kind: 'dispute' | 'waiting' | 'vat';
  id: number | null;
  number: string | null;
  version: number | null;
  total: number | null;
  weekStart: string | null;
  disputedAt: string | null;
  reason: string | null;
  userName: string | null;
  n: number | null;
  deemAt: string | null;
}

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
                i.resolved_at AS resolvedAt, i.resolution_action AS resolutionAction, i.resolution_note AS resolutionNote,
                (SELECT v.total FROM invoice_versions v WHERE v.invoice_id = i.id AND v.version = i.version - 1) AS previousTotal
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
        const moved = r.previousTotal !== null && Math.round(r.previousTotal * 100) !== Math.round(r.total * 100);
        items.push({
          key: `invoices:open:${r.id}:v${r.version}`,
          kind: 'invoices',
          severity: 'info',
          title: reissued
            ? (r.resolutionAction === 'reissue'
              ? 'The office fixed your invoice'
              : moved ? `Your invoice changed: ${money(r.total)} (was ${money(r.previousTotal!)})` : 'Your invoice was reissued')
            : soon ? `Check and accept your invoice by ${deadlineText(r.deemAt)}` : 'Check and accept your invoice',
          body: `${formatWeek(r.weekStart)}, ${money(r.total)}. Accept it or say what's wrong by ${deadlineText(r.deemAt)}; after that it counts as accepted.`,
          href: '/finance?tab=me',
          actionLabel: 'Open My pay',
          at: r.issuedAt,
        });
      }
    }

    if (me.role === 'admin') {
      // one statement: each disputed invoice, then the next deadline's invoices still waiting (on the day before and the
      // day of that deadline) as a count
      const rows = all<OfficeRow>(
        db,
        `SELECT 'dispute' AS kind, i.id, i.number, i.version, i.total, p.week_start AS weekStart, i.disputed_at AS disputedAt,
                i.dispute_reason AS reason, TRIM(u.first_name || ' ' || u.last_name) AS userName, NULL AS n, NULL AS deemAt
         FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id JOIN users u ON u.id = i.user_id
         WHERE i.status = 'disputed'
         UNION ALL
         SELECT 'waiting', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, COUNT(*), MIN(i.deem_at)
         FROM invoices i JOIN payroll_runs p ON p.id = i.payroll_run_id
         WHERE i.status = 'issued' AND p.status IN ('pending', 'failed') AND i.deem_at > ? AND i.deem_at <= ?
         UNION ALL
         SELECT 'vat', u.id, u.vat_number, NULL, NULL, NULL, u.vat_changed_at, TRIM(c.first_name || ' ' || c.last_name),
                TRIM(u.first_name || ' ' || u.last_name), CASE WHEN u.vat_changed_by = ? THEN 1 ELSE 0 END, NULL
         FROM users u LEFT JOIN users c ON c.id = u.vat_changed_by
         WHERE u.vat_number IS NOT NULL AND u.vat_confirmed_at IS NULL AND u.status <> 'left' AND u.role <> 'client' AND u.id <> ?
         ORDER BY 1, 7`,
        [local, `${addDays(local.slice(0, 10), 1)}T23:59:59`, me.id, me.id],
      );
      for (const d of rows) {
        if (d.kind !== 'dispute') continue;
        items.push({
          key: `invoices:dispute:${d.id}:v${d.version}`,
          kind: 'invoices',
          severity: 'warning',
          title: `${d.userName} says something's wrong`,
          body: `Invoice ${d.number}, ${formatWeek(d.weekStart!)}, ${money(d.total ?? 0)}: "${(d.reason ?? '').slice(0, 140)}"`,
          href: '/finance?tab=company#disputes',
          actionLabel: 'Review the dispute',
          at: d.disputedAt!,
        });
      }
      for (const v of rows) {
        if (v.kind !== 'vat') continue;
        const first = (v.userName ?? '').split(' ')[0] || 'them';
        const vat = formatVatNumber(v.number ?? '');
        const typed = !v.reason
          ? `VAT number ${vat} is on ${first}'s invoice details.`
          : v.reason === v.userName ? `${first} typed in VAT number ${vat}.` : `${v.reason} typed in VAT number ${vat} for ${first}.`;
        items.push({
          key: `invoices:vat:${v.id}:${v.disputedAt ?? 'before'}`,
          kind: 'invoices',
          severity: 'warning',
          title: `Check ${v.userName}'s VAT number`,
          body: `${typed} Check it on HMRC's "Check a UK VAT number" service, then confirm it on ${first}'s page. No VAT is added to their pay until then.${v.n ? ' You typed it in, so another administrator confirms it.' : ''}`,
          href: `/team/${v.id}#invoice-details`,
          actionLabel: 'Check the VAT number',
          at: v.disputedAt ?? now.nowISO,
        });
      }
      const waiting = rows.find((r) => r.kind === 'waiting');
      if (waiting && (waiting.n ?? 0) > 0 && waiting.deemAt) {
        const n = waiting.n!;
        items.push({
          key: `invoices:waiting:${waiting.deemAt.slice(0, 10)}`,
          kind: 'invoices',
          severity: 'info',
          title: `${n === 1 ? '1 invoice' : `${n} invoices`} not accepted yet`,
          body: `They count as accepted at ${deadlineText(waiting.deemAt)} unless disputed. Until then, Mark paid needs a reason.`,
          href: '/finance?tab=company#runs',
          actionLabel: 'Open Runs to pay',
          at: now.nowISO,
          count: n,
        });
      }
    }
    return items;
  },
};
