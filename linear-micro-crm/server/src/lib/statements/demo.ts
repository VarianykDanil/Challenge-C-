/**
 * Release 1.3 — OWNED BY P3 statements. The demo seed's commission statements (a FRESH demo seed only — an upgraded
 * database never gets them), built from the seeded gauges so the numbers are the people's own, and lined up with P1's
 * seeded pay (sale_confirmations: what the charities' weekly statements already confirmed), so applying one never
 * contradicts what pay says:
 *
 *  1. Breast Cancer Now, LAST WEEK (P1's demo has not had BCN's statement for it yet — BCN's arrive nine days after the
 *     week — and its runs are not paid): one row per fundraiser with their BCN fundraiser ID, sign-ups, cancelled, paid
 *     subs and the amount (paid × BCN's payout). At least three people have one or two cancellations. Every row
 *     matches by fundraiser ID; the columns are not saved yet, so it waits for the office ("Needs review": check, then
 *     Apply).
 *     Applying it recalculates those unpaid weeks ("2 cancelled by BCN: the week's pay goes from … to …", or "the base
 *     still applied: no change").
 *  2. Children's Hospice North, the four pay weeks before last week: one row per sign-up (date, supporter ref,
 *     fundraiser, Active / Cancelled), whose cancellations per person and week are exactly what P1's seed confirmed for
 *     those weeks — so applying it reads "no change" — with one fundraiser written with an initial ("J. Lee"), so those
 *     rows wait for the office to pick the person.
 *  3. A CHN remittance advice that is not a statement: no table, so it shows how a PDF that cannot be read looks.
 * Wherever P1's seed has no confirmation for a person and week, the cancellations are drawn here. The PDFs are drawn
 * (lib/statements/render.ts) the first time someone opens one — ensureStatementFile — from the specs kept in meta
 * `ext:statements:demo`, so seeding writes no files. The senders and the BCN fundraiser IDs are seeded too; the demo
 * emails count as confirmed by Gmail. Randomness comes from ctx.rng (never the core seed's stream); nothing here writes
 * a core table (sale_confirmations is only read).
 */
import { formatStatementPeriod } from '@lm/shared';
import { all, get, run, type Db } from '../../db/connection.ts';
import type { SeedContext } from '../../db/extensions/types.ts';
import { addDays, mondayOf } from '../dates.ts';
import { readStatementFile, saveStatementFile } from './files.ts';
import { renderStatementPdf, type StatementPdfSpec } from './render.ts';
import { NO_TABLE_MESSAGE, storeStatement, type ParsedPdf } from './store.ts';

export const DEMO_STATEMENTS_META_KEY = 'ext:statements:demo';
export const DEMO_SENDERS = { BCN: 'commissions@breastcancernow.example', CHN: 'finance@childrenshospicenorth.example' } as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const longDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Logged {
  userId: number;
  role: string;
  name: string;
  firstName: string;
  lastName: string;
  date: string;
  sales: number;
}

function loggedFor(db: Db, campaignId: number, from: string, to: string): Logged[] {
  return all<Logged>(
    db,
    `SELECT g.user_id AS userId, u.role, u.first_name || ' ' || u.last_name AS name, u.first_name AS firstName, u.last_name AS lastName,
            g.date, SUM(g.sales) AS sales
       FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN users u ON u.id = g.user_id
      WHERE e.campaign_id = ? AND g.date BETWEEN ? AND ? AND u.role <> 'client'
      GROUP BY g.user_id, g.date HAVING SUM(g.sales) > 0
      ORDER BY g.date, u.last_name, u.first_name`,
    [campaignId, from, to],
  );
}

/** What P1's seed already confirmed per (person, pay week) for a campaign (its weekly statements). */
function seededConfirmations(db: Db, campaignId: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of all<{ userId: number; weekStart: string; confirmed: number }>(
    db,
    `SELECT user_id AS userId, week_start AS weekStart, confirmed FROM sale_confirmations WHERE campaign_id = ?`,
    [campaignId],
  )) {
    out.set(`${c.userId}|${c.weekStart}`, Number(c.confirmed));
  }
  return out;
}

/** A spec as the parser would read it back: the lines above the table are the title, subtitle and info lines. */
function parsedOf(spec: StatementPdfSpec, period: { start: string; end: string } | null, failure: string | null): ParsedPdf {
  const preamble = [spec.title, spec.subtitle, ...spec.lines];
  return {
    table: failure ? null : { headers: spec.headers, rows: spec.rows, totals: spec.totals ?? null, preamble },
    period,
    texts: [...preamble, ...(spec.notes ?? [])],
    failure,
  };
}

/** The earlier of a timestamp and the business clock (a demo email never arrives in the future). */
const notAfter = (iso: string, nowIso: string) => (Date.parse(iso) > Date.parse(nowIso) ? new Date(Date.parse(nowIso)).toISOString() : iso);

export function seedDemoStatements(db: Db, ctx: SeedContext): void {
  const campaigns = all<{ id: number; code: string; name: string; color: string; payout: number }>(
    db,
    `SELECT id, code, name, color, payout_per_sale AS payout FROM campaigns WHERE code IN ('BCN', 'CHN')`,
  );
  const bcn = campaigns.find((c) => c.code === 'BCN');
  const chn = campaigns.find((c) => c.code === 'CHN');
  if (!bcn || !chn) return;
  const rng = ctx.rng(3303);
  const specs: Record<string, StatementPdfSpec> = {};
  const today = ctx.today;
  const lastWeek = addDays(mondayOf(today), -7);

  run(db, `INSERT OR IGNORE INTO campaign_statement_senders (campaign_id, address) VALUES (?, ?), (?, ?)`, [bcn.id, DEMO_SENDERS.BCN, chn.id, DEMO_SENDERS.CHN]);

  // BCN fundraiser IDs for everyone who has worked BCN (the IDs on BCN's statements).
  const bcnPeople = all<{ userId: number }>(
    db,
    `SELECT DISTINCT g.user_id AS userId FROM gauge_entries g JOIN events e ON e.id = g.event_id JOIN users u ON u.id = g.user_id
      WHERE e.campaign_id = ? AND u.role <> 'client' ORDER BY g.user_id`,
    [bcn.id],
  );
  const refOf = new Map<number, string>();
  bcnPeople.forEach((p, i) => {
    const ref = `FR-${2041 + i * 3}`;
    refOf.set(p.userId, ref);
    run(db, `INSERT OR IGNORE INTO user_client_refs (user_id, campaign_id, ref) VALUES (?, ?, ?)`, [p.userId, bcn.id, ref]);
  });

  // 1. BCN, last week: totals per fundraiser.
  const bcnConfirmed = seededConfirmations(db, bcn.id);
  const week = lastWeek;
  const weekEnd = addDays(week, 6);
  const perPerson = new Map<number, { name: string; sales: number }>();
  for (const l of loggedFor(db, bcn.id, week, weekEnd)) {
    const p = perPerson.get(l.userId) ?? { name: l.name, sales: 0 };
    p.sales += l.sales;
    perPerson.set(l.userId, p);
  }
  const people = [...perPerson].map(([userId, p]) => ({ userId, ...p })).sort((a, b) => a.name.localeCompare(b.name));
  if (people.length) {
    const drawn = people.map((p) => (p.sales >= 3 && rng.chance(0.3) ? Math.min(p.sales, rng.chance(0.3) ? 2 : 1) : 0));
    // at least three people with cancellations, so Apply shows the cases side by side: the top sellers (2 for the top
    // one) — a big seller loses commission, a small one keeps the base
    const bySales = people.map((p, i) => ({ i, sales: p.sales })).sort((a, b) => b.sales - a.sales || a.i - b.i);
    for (const { i, sales } of bySales) {
      if (drawn.filter(Boolean).length >= 3) break;
      if (!drawn[i] && sales >= 2) drawn[i] = Math.min(sales, drawn.some(Boolean) ? 1 : 2);
    }
    // what pay already holds for the week wins over a draw (never the case for last week in P1's demo, but safe)
    const cancels = people.map((p, i) => {
      const seeded = bcnConfirmed.get(`${p.userId}|${week}`);
      return seeded === undefined ? drawn[i]! : Math.max(0, p.sales - seeded);
    });
    const rows = people.map((p, i) => {
      const paid = p.sales - cancels[i]!;
      return [refOf.get(p.userId) ?? '', p.name, String(p.sales), String(cancels[i]), String(paid), money(paid * bcn.payout)];
    });
    const sum = (k: number) => rows.reduce((n, r) => n + Number(r[k]), 0);
    const paidTotal = sum(4);
    const receivedAt = notAfter(`${today}T07:47:00.000Z`, ctx.nowIso);
    const spec: StatementPdfSpec = {
      title: bcn.name,
      subtitle: 'Face-to-face fundraising: commission statement',
      lines: [
        'Agency: Linear MCR Limited (agency no. AG-0417)',
        `Period: ${dmy(week)} to ${dmy(weekEnd)}`,
        `Statement no. BCN-F2F-${week.replace(/-/g, '')}`,
        `Issued: ${dmy(receivedAt.slice(0, 10))}`,
      ],
      headers: ['Fundraiser ID', 'Fundraiser name', 'Sign-ups', 'Cancelled', 'Paid subs', 'Amount'],
      rows,
      totals: ['Total', '', String(sum(2)), String(sum(3)), String(paidTotal), money(paidTotal * bcn.payout)],
      notes: [
        'Paid subs are sign-ups whose first Direct Debit was collected. Cancelled: the supporter cancelled before the first collection, or the Direct Debit failed.',
        `Questions about this statement: ${DEMO_SENDERS.BCN}`,
      ],
      widths: [70, 150, 60, 60, 60, 80],
      right: [false, false, true, true, true, true],
      createdAt: notAfter(`${today}T07:40:00.000Z`, ctx.nowIso),
      color: bcn.color,
    };
    const id = storeStatement(db, {
      parsed: parsedOf(spec, { start: week, end: weekEnd }, null),
      file: null,
      fileName: `BCN commission statement ${week}.pdf`,
      source: 'email',
      messageId: `<commission-${week}@breastcancernow.example>#1`,
      sender: DEMO_SENDERS.BCN,
      subject: `Commission statement: ${formatStatementPeriod(week, weekEnd)}`,
      receivedAt,
      campaignId: bcn.id,
      senderVerified: true,
    });
    specs[id] = spec;
  }

  // 2. CHN, the four pay weeks before last week: one row per sign-up, cancellations as P1's seed confirmed them.
  const chnConfirmed = seededConfirmations(db, chn.id);
  const from = addDays(lastWeek, -28);
  const to = addDays(lastWeek, -1);
  const chnReceived = `${addDays(to, 2)}T09:12:00.000Z`; // CHN's statements arrive two days after the week
  const logged = loggedFor(db, chn.id, from, to);
  if (logged.length) {
    // one rep written with an initial (the second rep by id who sold for CHN in the period)
    const reps = [...new Set(logged.filter((l) => l.role === 'rep').map((l) => l.userId))].sort((a, b) => a - b);
    const initialled = reps[1] ?? reps[0] ?? null;
    // per person and week: how many of their sign-ups are cancelled
    const byWeek = new Map<string, Logged[]>();
    for (const l of logged) {
      const key = `${l.userId}|${mondayOf(l.date)}`;
      byWeek.set(key, [...(byWeek.get(key) ?? []), l]);
    }
    const cancelledDays = new Map<string, number>(); // `${userId}|${date}` → cancelled sign-ups that day
    for (const [key, days] of byWeek) {
      const total = days.reduce((n, d) => n + d.sales, 0);
      const seeded = chnConfirmed.get(key);
      let k = seeded === undefined ? days.reduce((n, d) => n + Array.from({ length: d.sales }, () => rng.chance(0.08)).filter(Boolean).length, 0) : Math.max(0, Math.min(total, total - seeded));
      // the cancelled ones: from the week's last day backwards
      for (const d of [...days].sort((a, b) => b.date.localeCompare(a.date))) {
        if (!k) break;
        const take = Math.min(k, d.sales);
        cancelledDays.set(`${d.userId}|${d.date}`, take);
        k -= take;
      }
    }
    const rows: string[][] = [];
    let seq = 0;
    for (const l of logged) {
      const shown = l.userId === initialled ? `${l.firstName.slice(0, 1)}. ${l.lastName}` : l.name;
      const cancelled = cancelledDays.get(`${l.userId}|${l.date}`) ?? 0;
      for (let n = 0; n < l.sales; n++) {
        seq++;
        rows.push([dmy(l.date), `CHN-${from.slice(2, 4)}${from.slice(5, 7)}-${String(seq).padStart(4, '0')}`, shown, n >= l.sales - cancelled ? 'Cancelled' : 'Active']);
      }
    }
    const spec: StatementPdfSpec = {
      title: chn.name,
      subtitle: 'Agency sign-ups and cancellations',
      lines: ['Prepared for Linear MCR Limited', `Period: ${dmy(from)} to ${dmy(to)} (four weeks)`, `Reference CHN/AG/${from.replace(/-/g, '')}`, `Date: ${dmy(chnReceived.slice(0, 10))}`],
      headers: ['Sign-up date', 'Supporter ref', 'Fundraiser', 'Status'],
      rows,
      totals: null,
      notes: ['Status as at the date of this statement. Cancelled: the supporter cancelled within 30 days or the first gift failed.'],
      widths: [90, 110, 170, 100],
      createdAt: `${addDays(to, 2)}T09:05:00.000Z`,
      color: chn.color,
    };
    const id = storeStatement(db, {
      parsed: parsedOf(spec, { start: from, end: to }, null),
      file: null,
      fileName: `CHN agency statement ${from} to ${to}.pdf`,
      source: 'email',
      messageId: `<agency-${from}@childrenshospicenorth.example>#1`,
      sender: DEMO_SENDERS.CHN,
      subject: `Agency statement: four weeks to ${longDate(to)}`,
      receivedAt: chnReceived,
      campaignId: chn.id,
      senderVerified: true,
    });
    specs[id] = spec;
  }

  // 3. A CHN remittance advice: a letter, not a statement (no table to read).
  const adviceDay = addDays(today, -2);
  const advice: StatementPdfSpec = {
    title: chn.name,
    subtitle: 'Remittance advice',
    lines: ['To: Linear MCR Limited', `Payment date: ${longDate(adviceDay)}`, 'Amount paid: £14,850.00', 'Our reference: CHN/PAY/88213'],
    headers: [],
    rows: [],
    notes: ['This is a notice of payment, not a commission statement. Your statement is sent separately each month.'],
    createdAt: `${adviceDay}T14:30:00.000Z`,
    color: chn.color,
  };
  const adviceId = storeStatement(db, {
    parsed: parsedOf(advice, null, NO_TABLE_MESSAGE),
    file: null,
    fileName: 'CHN remittance advice.pdf',
    source: 'email',
    messageId: `<remittance-${adviceDay}@childrenshospicenorth.example>#1`,
    sender: DEMO_SENDERS.CHN,
    subject: 'Remittance advice',
    receivedAt: `${adviceDay}T14:41:00.000Z`,
    campaignId: chn.id,
    senderVerified: true,
  });
  specs[adviceId] = advice;

  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [DEMO_STATEMENTS_META_KEY, JSON.stringify(specs)]);
}

/** The demo spec of a statement, if it is one of the demo seed's. */
export function demoStatementSpec(db: Db, statementId: number): StatementPdfSpec | null {
  const row = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [DEMO_STATEMENTS_META_KEY]);
  if (!row) return null;
  try {
    return (JSON.parse(row.value) as Record<string, StatementPdfSpec>)[String(statementId)] ?? null;
  } catch {
    return null;
  }
}

/**
 * The statement's PDF: the stored file, or — for a demo statement whose file is not drawn yet — draws it now, keeps it
 * and records its path and SHA-256. null when there is no file.
 */
export async function ensureStatementFile(db: Db, statementId: number): Promise<Buffer | null> {
  const st = get<{ filePath: string | null }>(db, `SELECT file_path AS filePath FROM statements WHERE id = ?`, [statementId]);
  if (!st) return null;
  const stored = readStatementFile(db, st.filePath);
  if (stored) return stored;
  const spec = demoStatementSpec(db, statementId);
  if (!spec) return null;
  const buf = await renderStatementPdf(spec);
  const file = saveStatementFile(db, buf);
  run(db, `UPDATE statements SET file_path = ?, file_sha256 = ? WHERE id = ?`, [file.relPath, file.sha256, statementId]);
  return buf;
}
