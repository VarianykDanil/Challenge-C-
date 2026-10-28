/**
 * Release 1.4 — OWNED BY F payments-foundation. Kind 'payments' in the Needs-attention feed, for administrators only:
 *
 *  - someone changed their bank details and an admin has not confirmed them yet: "Jordan Lee changed their bank
 *    details" (warning; up to three by name, then one line for all), linking to Team → person → Bank details;
 *  - live payments that failed and whose run is still unpaid with no newer payment (one line: danger), linking to the
 *    payment (or Runs to pay when several payments are involved);
 *  - a bank file approved but not yet marked paid (info, one per payment, newest two), with the people and the money
 *    still waiting for the bank (review fix UI-1: a line the bank format refused is not in the file, so not counted).
 *    Live only (review fix money:3): a test bank file pays nobody (it carries no real bank details);
 *  - a connection whose last test or payment failed (warning);
 *  - review fix: a run whose figures changed after its payment was approved (the run is frozen while the money is on
 *    its way, and paid as approved): "Jordan Lee's pay changed while payment #3 was on its way" (warning; one line
 *    for several), until a correction for that week is added (a line whose "week it corrects" is that week).
 * Checks before paying and safer payments:
 *  - MON-1, leaders and the office: "3 days to confirm" — gauge days people logged themselves with no booking, no
 *    check-in or nothing logged, in unpaid weeks of the last five weeks (a leader: their own team, not their own days;
 *    the office: everyone), linking to Pay → Days to confirm; and the person themself (rep, leader): "1 of your days
 *    waits for your leader" (the office, for a leader), so a pay estimate that dropped says why;
 *  - MON-3, every member of staff: their own bank details were changed by someone else and they have not said yes or
 *    reported them: "Your bank details were changed by Ada Admin on Tue 20 Oct" … "Confirm or report it" (danger);
 *  - MON-3, the office: details an administrator typed in for someone wait for the person or ANOTHER administrator
 *    (shown to every administrator but the one who typed them), and details a person reported as not theirs (danger).
 *  - MONEY-MISSED-2, the office: an administrator asked to turn off "Two people approve each payment" (danger, to every
 *    administrator but the one who asked: a different one must agree), and two approvals being on with fewer than two
 *    administrators using two-step while a live connection exists, so live payments cannot be approved (warning).
 * One UNION ALL statement per call (the feed's budget, attention.test.ts); none for a role with nothing to see. Keys
 * carry the moment, so a new change or a new failure is new again in the bell.
 */
import { formatPence, payDayLabel, type AttentionItem } from '@lm/shared';
import { all, placeholders } from '../../db/connection.ts';
import { DAY_CHECK_LOOKBACK_DAYS, PAY_DAY_CHECKS_KEY } from '../payDays.ts';
import { listPaymentProviders } from '../payments/registry.ts';
import { TWO_APPROVALS_KEY, TWO_APPROVALS_OFF_REQUEST_KEY } from '../payments/settings.ts';
import type { AttentionProvider } from './types.ts';

/**
 * MON-1: waiting days (person, day) in the caller's scope, as one row (kind 'days'): the count and the latest entry's
 * time. `scope` narrows the people (a leader's team, without the leader).
 */
const WAITING_DAYS = (scope: string, kind: 'days' | 'mydays' = 'days') => `
  SELECT '${kind}' AS kind, COUNT(*) AS id, NULL AS name, MAX(at) AS at, COUNT(*) AS n, NULL AS amount, NULL AS reason, NULL AS batchId FROM (
    SELECT g.user_id, g.date, MAX(g.submitted_at) AS at
    FROM gauge_entries g JOIN users u ON u.id = g.user_id
    WHERE g.date >= ? AND g.date < ? ${scope} AND u.role <> 'client'
      AND EXISTS (SELECT 1 FROM meta m WHERE m.key = ? AND m.value = 'on')
      AND NOT EXISTS (SELECT 1 FROM pay_day_checks d WHERE d.user_id = g.user_id AND d.date = g.date)
      AND NOT EXISTS (SELECT 1 FROM payroll_runs p WHERE p.user_id = g.user_id AND p.week_start = date(g.date, '-6 days', 'weekday 1') AND p.status IN ('paid', 'late'))
    GROUP BY g.user_id, g.date
    HAVING MAX((g.stops + g.table_count + g.presentations + g.closes + g.taps + g.sales) > 0
               AND (EXISTS (SELECT 1 FROM event_roster r WHERE r.event_id = g.event_id AND r.user_id = g.user_id)
                    OR EXISTS (SELECT 1 FROM check_ins ci WHERE ci.user_id = g.user_id AND ci.event_id = g.event_id AND ci.date = g.date))) = 0
  )`;

/** MON-3: the caller's own bank details changed by someone else, not yet seen (kind 'notice'; reason: who). */
const OWN_NOTICE = `
  SELECT 'notice' AS kind, b.user_id AS id, NULL AS name, b.changed_at AS at, NULL AS n, NULL AS amount,
         TRIM(cu.first_name || ' ' || cu.last_name) AS reason, NULL AS batchId
  FROM bank_accounts b LEFT JOIN users cu ON cu.id = b.changed_by
  WHERE b.user_id = ? AND b.changed_by IS NOT NULL AND b.changed_by <> b.user_id AND b.reported_at IS NULL
    AND (b.person_seen_at IS NULL OR b.person_seen_at < b.changed_at)`;

/** MON-3: the "your bank details were changed" item. */
function noticeItem(rows: readonly Row[]): AttentionItem[] {
  const r = rows.find((x) => x.kind === 'notice');
  if (!r) return [];
  return [{
    key: `payments:bank-notice:${r.at ?? ''}`,
    kind: 'payments',
    severity: 'danger',
    title: `Your bank details were changed by ${r.reason || 'someone else'} on ${r.at ? payDayLabel(r.at.slice(0, 10)) : 'a recent day'}`,
    body: 'If they are yours, confirm them. If not, report it: nothing is paid to them until this is sorted out. Confirm or report it in Settings → Bank details.',
    href: '/settings#bank-details',
    actionLabel: 'Confirm or report it',
    at: r.at ?? undefined,
  }];
}

const daysSince = (today: string) => new Date(Date.parse(`${today}T12:00:00Z`) - DAY_CHECK_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);

/**
 * MON-1: the person's own days that wait (the 'mydays' row), so an estimate that dropped says why: for a rep their
 * leader confirms them; for a leader, the office.
 */
function myDaysItem(rows: readonly Row[], leader: boolean): AttentionItem[] {
  const days = rows.find((r) => r.kind === 'mydays');
  const n = Number(days?.n ?? 0);
  if (!days || n <= 0) return [];
  const who = leader ? 'the office' : 'your leader';
  return [{
    key: `payments:mydays:${n}:${days.at ?? ''}`,
    kind: 'pay',
    severity: 'info',
    title: n === 1 ? `1 of your days waits for ${who}` : `${n} of your days wait for ${who}`,
    body: `You logged ${n === 1 ? 'it' : 'them'} with no booking or check-in (or with nothing logged), so ${n === 1 ? 'it is' : 'they are'} not paid as a base day until ${who} confirms ${n === 1 ? 'it' : 'them'}. Next time, book onto the event and check in.`,
    href: '/finance?tab=me',
    actionLabel: 'Open My pay',
    at: days.at ?? undefined,
    count: n > 1 ? n : undefined,
  }];
}

/** MON-1: the "N days to confirm" item from the 'days' row (none when there are none). */
function daysItem(rows: readonly Row[], admin: boolean): AttentionItem[] {
  const days = rows.find((r) => r.kind === 'days');
  const n = Number(days?.n ?? 0);
  if (!days || n <= 0) return [];
  return [{
    key: `payments:days:${n}:${days.at ?? ''}`,
    kind: 'pay',
    severity: 'warning',
    title: `${n === 1 ? '1 day' : `${n} days`} to confirm`,
    body: admin
      ? 'Days people logged themselves with no booking or check-in (or nothing logged). They are not paid as base days until a leader or you confirm them.'
      : 'Your team logged these days themselves with no booking or check-in (or nothing logged). They are not paid as base days until you confirm them.',
    href: '/pay/days',
    actionLabel: 'Check the days',
    at: days.at ?? undefined,
    count: n,
  }];
}

interface Row {
  kind: 'bank' | 'failed' | 'file' | 'conn' | 'changed' | 'days' | 'mydays' | 'notice' | 'typed' | 'reported' | 'twooff' | 'twostuck';
  id: number;
  name: string | null;
  at: string | null;
  n: number | null;
  amount: number | null;
  reason: string | null;
  batchId: number | null;
}

const FAILED_LOOKBACK_DAYS = 30;

export const provider: AttentionProvider = {
  name: 'payments',
  items(db, me, now) {
    if (me.role === 'client') return [];
    const since5 = daysSince(now.today);
    if (me.role === 'leader' && me.teamId !== null) {
      const rows = all<Row>(
        db,
        `${WAITING_DAYS('AND u.team_id = ? AND g.user_id <> ?')} UNION ALL ${WAITING_DAYS('AND g.user_id = ?', 'mydays')} UNION ALL ${OWN_NOTICE}`,
        [since5, now.today, me.teamId, me.id, PAY_DAY_CHECKS_KEY, since5, now.today, me.id, PAY_DAY_CHECKS_KEY, me.id],
      );
      return [...noticeItem(rows), ...daysItem(rows, false), ...myDaysItem(rows, true)];
    }
    if (me.role !== 'admin') {
      const rows = all<Row>(db, `${WAITING_DAYS('AND g.user_id = ?', 'mydays')} UNION ALL ${OWN_NOTICE}`, [since5, now.today, me.id, PAY_DAY_CHECKS_KEY, me.id]);
      return [...noticeItem(rows), ...myDaysItem(rows, me.role === 'leader')];
    }
    const fileProviders = listPaymentProviders().filter((p) => p.info.kind === 'file').map((p) => p.info.id);
    const since = new Date(Date.parse(now.nowISO) - FAILED_LOOKBACK_DAYS * 86_400_000).toISOString();
    const rows = all<Row>(
      db,
      `SELECT 'bank' AS kind, b.user_id AS id, TRIM(u.first_name || ' ' || u.last_name) AS name, b.changed_at AS at, NULL AS n, NULL AS amount, NULL AS reason, NULL AS batchId
       FROM bank_accounts b JOIN users u ON u.id = b.user_id
       WHERE (b.confirmed_by_admin_at IS NULL OR b.confirmed_by_admin_at < b.changed_at) AND u.status <> 'left' AND u.role <> 'client'
         AND (b.changed_by IS NULL OR b.changed_by = b.user_id) AND b.reported_at IS NULL AND b.user_id <> ?
       UNION ALL
       SELECT 'typed', b.user_id, TRIM(u.first_name || ' ' || u.last_name), b.changed_at, NULL, NULL, TRIM(cu.first_name || ' ' || cu.last_name), NULL
       FROM bank_accounts b JOIN users u ON u.id = b.user_id LEFT JOIN users cu ON cu.id = b.changed_by
       WHERE (b.confirmed_by_admin_at IS NULL OR b.confirmed_by_admin_at < b.changed_at) AND u.status <> 'left' AND u.role <> 'client'
         AND b.changed_by IS NOT NULL AND b.changed_by <> b.user_id AND b.changed_by <> ? AND b.reported_at IS NULL
       UNION ALL
       SELECT 'reported', b.user_id, TRIM(u.first_name || ' ' || u.last_name), b.reported_at, NULL, NULL, TRIM(cu.first_name || ' ' || cu.last_name), NULL
       FROM bank_accounts b JOIN users u ON u.id = b.user_id LEFT JOIN users cu ON cu.id = b.changed_by
       WHERE b.reported_at IS NOT NULL AND u.status <> 'left'
       UNION ALL
       ${OWN_NOTICE}
       UNION ALL
       SELECT 'failed', i.id, TRIM(u.first_name || ' ' || u.last_name), i.updated_at, NULL, i.amount_pence, i.failure_reason, i.batch_id
       FROM payment_items i JOIN users u ON u.id = i.user_id JOIN payroll_runs p ON p.id = i.payroll_run_id
       WHERE i.live = 1 AND i.status = 'failed' AND p.status IN ('pending', 'failed') AND i.updated_at >= ?
         AND NOT EXISTS (SELECT 1 FROM payment_items j WHERE j.payroll_run_id = i.payroll_run_id AND j.id > i.id AND j.live = 1 AND j.status <> 'cancelled')
       UNION ALL
       SELECT 'changed', i.id, TRIM(u.first_name || ' ' || u.last_name), p.adjusted_at, NULL, i.amount_pence, i.status, i.batch_id
       FROM payment_items i JOIN payment_batches pb ON pb.id = i.batch_id JOIN users u ON u.id = i.user_id JOIN payroll_runs p ON p.id = i.payroll_run_id
       WHERE i.live = 1 AND i.status IN ('queued', 'submitted', 'processing', 'paid') AND pb.approved_at IS NOT NULL
         AND p.adjusted_at IS NOT NULL AND p.adjusted_at > pb.approved_at AND p.adjusted_at >= ?
         AND NOT EXISTS (SELECT 1 FROM pay_adjustments a WHERE a.user_id = i.user_id AND a.source_week_start = i.week_start AND a.created_at >= p.adjusted_at)
       UNION ALL
       SELECT 'file', b.id, c.name, COALESCE(b.approved_at, b.created_at),
              (SELECT COUNT(*) FROM payment_items x WHERE x.batch_id = b.id AND x.status IN ('submitted', 'processing')),
              (SELECT COALESCE(SUM(x.amount_pence), 0) FROM payment_items x WHERE x.batch_id = b.id AND x.status IN ('submitted', 'processing')), NULL, b.id
       FROM payment_batches b JOIN payment_connections c ON c.id = b.connection_id
       WHERE b.status IN ('submitted', 'processing') AND b.mode = 'live' AND b.provider IN (${placeholders(Math.max(1, fileProviders.length))})
       UNION ALL
       SELECT 'conn', c.id, c.name, c.last_checked_at, NULL, NULL, c.last_error, NULL
       FROM payment_connections c WHERE c.status = 'error' AND c.disconnected_at IS NULL
       UNION ALL
       ${WAITING_DAYS('')}
       UNION ALL
       SELECT 'twooff', CAST(json_extract(m.value, '$.by') AS INTEGER), TRIM(u.first_name || ' ' || u.last_name), json_extract(m.value, '$.at'), NULL, NULL, NULL, NULL
       FROM meta m LEFT JOIN users u ON u.id = json_extract(m.value, '$.by')
       WHERE m.key = ? AND json_valid(m.value) AND json_extract(m.value, '$.by') <> ?
         AND EXISTS (SELECT 1 FROM meta t WHERE t.key = ? AND t.value IN ('on', 'auto-on'))
       UNION ALL
       SELECT 'twostuck', 0, NULL, NULL, NULL, NULL, NULL, NULL
       FROM meta t WHERE t.key = ? AND t.value IN ('on', 'auto-on')
         AND (SELECT COUNT(*) FROM users a WHERE a.role = 'admin' AND a.status = 'active' AND a.totp_enabled_at IS NOT NULL) < 2
         AND EXISTS (SELECT 1 FROM payment_connections c WHERE c.mode = 'live' AND c.disconnected_at IS NULL)
       ORDER BY at DESC`,
      [
        me.id, me.id, me.id, since, since, ...(fileProviders.length ? fileProviders : ['-']), daysSince(now.today), now.today, PAY_DAY_CHECKS_KEY,
        TWO_APPROVALS_OFF_REQUEST_KEY, me.id, TWO_APPROVALS_KEY, TWO_APPROVALS_KEY,
      ],
    );
    const items: AttentionItem[] = [...noticeItem(rows), ...daysItem(rows, true)];
    // MONEY-MISSED-2: someone asked to turn off two approvals; a different administrator must agree (or keep it on)
    const off = rows.find((r) => r.kind === 'twooff');
    if (off) {
      items.push({
        key: `payments:two-approvals-off:${off.at ?? ''}`,
        kind: 'payments',
        severity: 'danger',
        title: `${off.name ?? 'An administrator'} wants to turn off two approvals`,
        body: 'Then one administrator could pay people alone. If you agree, turn it off in Settings → Payments with your code. If not, keep it on there.',
        href: '/settings#payments',
        actionLabel: 'Open Settings → Payments',
        at: off.at ?? undefined,
      });
    }
    if (rows.some((r) => r.kind === 'twostuck')) {
      items.push({
        key: 'payments:two-approvals-stuck',
        kind: 'payments',
        severity: 'warning',
        title: 'Live payments need a second administrator',
        body: 'Two people approve each payment, but only one administrator uses two-step verification. Add another administrator with two-step, or turn the setting off in Settings → Payments.',
        href: '/settings#payments',
        actionLabel: 'Open Settings → Payments',
      });
    }
    // MON-3: a person said the details typed in for them are not theirs
    for (const r of rows.filter((x) => x.kind === 'reported').slice(0, 3)) {
      items.push({
        key: `payments:bank-reported:${r.id}:${r.at ?? ''}`,
        kind: 'payments',
        severity: 'danger',
        title: `${r.name ?? 'Someone'} says the bank details ${r.reason ? `${r.reason} typed in` : 'typed in for them'} are not theirs`,
        body: 'Nothing is paid to those details. Check what happened, then type in their correct details with them.',
        href: `/team/${r.id}#bank-details`,
        actionLabel: 'Open their details',
        at: r.at ?? undefined,
      });
    }
    // MON-3: typed in by another administrator: you (a different administrator) may confirm them, or the person does
    for (const r of rows.filter((x) => x.kind === 'typed').slice(0, 3)) {
      items.push({
        key: `payments:bank-typed:${r.id}:${r.at ?? ''}`,
        kind: 'payments',
        severity: 'warning',
        title: `${r.reason ?? 'An administrator'} typed in ${r.name ?? 'someone'}'s bank details`,
        body: `Payments to them wait until ${(r.name ?? 'they').split(' ')[0]} confirms them, or you confirm them after checking with ${(r.name ?? 'them').split(' ')[0]}.`,
        href: `/team/${r.id}#bank-details`,
        actionLabel: 'Check details',
        at: r.at ?? undefined,
      });
    }

    const bank = rows.filter((r) => r.kind === 'bank');
    if (bank.length > 3) {
      items.push({
        key: `payments:bank:${bank.length}:${bank[0]!.at}`,
        kind: 'payments',
        severity: 'warning',
        title: `${bank.length} people changed their bank details`,
        body: 'Check them before paying: payments to new details wait until you confirm them in Team.',
        href: '/team',
        actionLabel: 'Open Team',
        at: bank[0]!.at ?? undefined,
        count: bank.length,
      });
    } else {
      for (const r of bank) {
        items.push({
          key: `payments:bank:${r.id}:${r.at}`,
          kind: 'payments',
          severity: 'warning',
          title: `${r.name ?? 'Someone'} changed their bank details`,
          body: 'Check them before paying: payments to the new account wait until you confirm them.',
          href: `/team/${r.id}#bank-details`,
          actionLabel: 'Check details',
          at: r.at ?? undefined,
        });
      }
    }

    const failed = rows.filter((r) => r.kind === 'failed');
    if (failed.length) {
      const first = failed[0]!;
      const batches = new Set(failed.map((r) => r.batchId));
      items.push({
        key: `payments:failed:${Math.max(...failed.map((r) => r.id))}:${failed.length}`,
        kind: 'payments',
        severity: 'danger',
        title: failed.length === 1 ? `A payment to ${first.name ?? 'someone'} failed` : `${failed.length} payments failed`,
        // review fix (UI-4): one full stop, also when the reason already ends with one
        body: `${first.name ?? 'Someone'}, ${formatPence(first.amount ?? 0)}: ${(first.reason ?? 'not paid').trim().replace(/\.+$/, '')}. ${failed.length === 1 ? 'Their week' : 'These weeks'} stay${failed.length === 1 ? 's' : ''} on Runs to pay.`,
        href: batches.size === 1 ? `/finance/pay/batches/${first.batchId}` : '/finance?tab=company#runs',
        actionLabel: batches.size === 1 ? 'Open the payment' : 'Open Runs to pay',
        at: first.at ?? undefined,
        count: failed.length,
      });
    }

    const changed = rows.filter((r) => r.kind === 'changed');
    if (changed.length) {
      const first = changed[0]!;
      const batches = new Set(changed.map((r) => r.batchId));
      const paid = first.reason === 'paid';
      items.push({
        key: `payments:changed:${Math.max(...changed.map((r) => r.id))}:${first.at}`,
        kind: 'payments',
        severity: 'warning',
        title: changed.length === 1
          ? `${first.name ?? 'Someone'}'s pay changed while payment #${first.batchId} was on its way`
          : `${changed.length} people's pay changed while their payments were on their way`,
        body: changed.length === 1
          ? `${paid ? 'It was paid' : 'It is paid'} as approved (${formatPence(first.amount ?? 0)}). Put any difference on a later week as an adjustment, saying which week it corrects.`
          : 'Each is paid as approved. Put any difference on a later week as an adjustment, saying which week it corrects.',
        href: batches.size === 1 ? `/finance/pay/batches/${first.batchId}` : '/finance/pay',
        actionLabel: batches.size === 1 ? 'Open the payment' : 'Open Pay people',
        at: first.at ?? undefined,
        count: changed.length > 1 ? changed.length : undefined,
      });
    }

    for (const r of rows.filter((x) => x.kind === 'file').slice(0, 2)) {
      items.push({
        key: `payments:file:${r.id}`,
        kind: 'payments',
        severity: 'info',
        title: `Payment #${r.id} is waiting for your bank`,
        body: `Upload the file to your bank and approve it there, then mark it paid here (${r.n ?? 0} ${r.n === 1 ? 'person' : 'people'}, ${formatPence(r.amount ?? 0)}).`,
        href: `/finance/pay/batches/${r.id}`,
        actionLabel: 'Open the payment',
        at: r.at ?? undefined,
      });
    }

    for (const r of rows.filter((x) => x.kind === 'conn').slice(0, 2)) {
      items.push({
        key: `payments:conn:${r.id}:${r.at}`,
        kind: 'payments',
        severity: 'warning',
        title: `${r.name ?? 'A payment connection'} needs a look`,
        body: r.reason ? `Its last test did not work: ${r.reason.slice(0, 200)}` : 'Its last test did not work. Test it again in Settings → Payments.',
        href: '/settings#payments',
        actionLabel: 'Open Settings',
        at: r.at ?? undefined,
      });
    }
    return items;
  },
};
