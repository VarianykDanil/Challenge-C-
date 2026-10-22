/**
 * Release 1.3 — OWNED BY P3 statements (laid down by r3-foundation). Kind 'statements', administrators only, one
 * grouped query (the statements waiting for the office from the last 60 days, and the mail settings):
 *
 *  - statements:review:<id>  warning — a statement that needs a look (rows not matched, no campaign or period, the
 *                            client's columns not saved yet, rows dated outside its period, an email Gmail could not
 *                            confirm came from the sender, or one that would replace an applied statement).
 *                            "BCN statement for 5–11 Oct 2026 needs a look" · Review
 *  - statements:failed:<id>  warning — a PDF that could not be read, with the reason. "A statement could not be read"
 *  - statements:ready:<id>   info — every row matched and the columns saved, waiting for Apply (an upload; email
 *                            statements in that state apply themselves). "BCN statement for 5–11 Oct 2026 ready to apply"
 *  - statements:mail:<hash>  danger — the automatic Gmail check is on and failing (the reason in plain words); a
 *                            different reason is a new item.
 * Applying, fixing or discarding a statement (or the check passing) makes its item disappear by itself.
 * Contract: ./types.ts.
 */
import { createHash } from 'node:crypto';
import { formatStatementPeriod, type AttentionItem } from '@lm/shared';
import { all } from '../../db/connection.ts';
import { MAIL_META_KEY } from '../statements/mail.ts';
import type { AttentionProvider } from './types.ts';

/** At most this many statement items (the newest), so a backlog never crowds out the rest of the top box. */
const MAX_STATEMENT_ITEMS = 6;
const LOOK_BACK_DAYS = 60;

interface Row {
  kind: 'statement' | 'mail';
  id: number | null;
  status: string | null;
  code: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  receivedAt: string | null;
  error: string | null;
  campaignId: number | null;
  unmatched: number | null;
  mappingSource: string | null;
  source: string | null;
  senderVerified: number | null;
  outside: number | null;
  replaces: number | null;
  mail: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const provider: AttentionProvider = {
  name: 'statements',
  items: (db, me, now) => {
    if (me.role !== 'admin') return [];
    const since = new Date(Date.parse(now.nowISO) - LOOK_BACK_DAYS * 86_400_000).toISOString();
    const rows = all<Row>(
      db,
      `SELECT * FROM (
         SELECT 'statement' AS kind, s.id, s.status, c.code, s.period_start AS periodStart, s.period_end AS periodEnd,
                s.received_at AS receivedAt, s.error, s.campaign_id AS campaignId,
                (SELECT COUNT(*) FROM statement_rows r WHERE r.statement_id = s.id AND r.match = 'none') AS unmatched,
                s.mapping_source AS mappingSource, s.source, s.sender_verified AS senderVerified,
                (SELECT COUNT(*) FROM statement_rows r WHERE r.statement_id = s.id AND (r.user_id IS NOT NULL OR r.match = 'none')
                    AND (COALESCE(r.sale_date, r.period_start, s.period_start) < s.period_start OR COALESCE(r.sale_date, r.period_end, s.period_end) > s.period_end)) AS outside,
                (SELECT o.id FROM statements o WHERE o.campaign_id = s.campaign_id AND o.status = 'applied' AND o.superseded_by IS NULL AND o.id <> s.id
                    AND o.period_start = s.period_start AND o.period_end = s.period_end LIMIT 1) AS replaces,
                NULL AS mail
           FROM statements s LEFT JOIN campaigns c ON c.id = s.campaign_id
          WHERE s.status IN ('needs_review', 'failed', 'parsed') AND s.received_at >= ?
          ORDER BY s.received_at DESC, s.id DESC
          LIMIT ${MAX_STATEMENT_ITEMS})
       UNION ALL
       SELECT 'mail', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, value FROM meta WHERE key = ?`,
      [since, MAIL_META_KEY],
    );
    const items: AttentionItem[] = [];
    for (const r of rows) {
      if (r.kind === 'mail') {
        let mail: { enabled?: boolean; lastError?: string | null; lastCheckAt?: string | null } = {};
        try {
          mail = JSON.parse(r.mail ?? '{}') as typeof mail;
        } catch {
          continue;
        }
        if (mail.enabled && mail.lastError) {
          items.push({
            key: `statements:mail:${createHash('sha256').update(mail.lastError).digest('hex').slice(0, 10)}`,
            kind: 'statements',
            severity: 'danger',
            title: 'The Gmail check for statements is failing',
            body: mail.lastError,
            href: '/settings#integrations',
            actionLabel: 'Fix it',
            at: mail.lastCheckAt ?? undefined,
          });
        }
        continue;
      }
      const period = r.periodStart && r.periodEnd ? ` for ${formatStatementPeriod(r.periodStart, r.periodEnd)}` : '';
      // the period tells two statements from the same client apart ("BCN statement for 5–11 Oct 2026 needs a look")
      const what = `${[r.code, 'statement'].filter(Boolean).join(' ')}${period}`;
      const href = `/finance/statements?statement=${r.id}`;
      if (r.status === 'failed') {
        items.push({ key: `statements:failed:${r.id}`, kind: 'statements', severity: 'warning', title: 'A statement could not be read', body: r.error ?? 'Open it to see why.', href, actionLabel: 'Open', at: r.receivedAt ?? undefined });
      } else if (r.status === 'parsed') {
        items.push({
          key: `statements:ready:${r.id}`, kind: 'statements', severity: 'info', title: `${what} ready to apply`,
          body: 'Every row is matched. Check the pay effect, then press Apply.', href, actionLabel: 'Review', at: r.receivedAt ?? undefined,
        });
      } else {
        const unmatched = r.unmatched ?? 0;
        const body = !r.campaignId
          ? 'Pick the campaign it is for, then check it and press Apply.'
          : unmatched
            ? `${plural(unmatched, 'row is', 'rows are')} not matched to anyone yet. Pick the person, then press Apply.`
            : !r.periodStart
              ? 'Set the period it covers, then press Apply.'
              : r.replaces
                ? 'It replaces a statement for the same period that is already applied. Check the pay effect, then press Apply.'
                : r.outside
                  ? `${plural(r.outside, 'row is', 'rows are')} dated outside its period. Check the dates with the PDF, then press Apply.`
                  : r.source === 'email' && r.senderVerified !== 1
                    ? `Gmail could not confirm the email came from ${r.code ?? 'the client'}. Check it with the PDF, then press Apply.`
                    : r.mappingSource !== 'template'
                      ? `Check the columns Linear Hub read, then press Apply. Later ${[r.code, 'statements'].filter(Boolean).join(' ')} in the same layout apply themselves.`
                      : 'Something on it needs checking before Apply: open it to see what.';
        items.push({ key: `statements:review:${r.id}`, kind: 'statements', severity: 'warning', title: `${what} needs a look`, body, href, actionLabel: 'Review', at: r.receivedAt ?? undefined, count: unmatched || undefined });
      }
    }
    return items;
  },
};
