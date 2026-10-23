/**
 * Release 1.3 — OWNED BY P6 client-portal (the client role's column and the tables below were laid down by
 * r3-foundation and are the contract; P6 adds the office's read receipts, the requested date and the demo rows).
 *
 *  - users.client_campaign_id: the campaign a `client` account belongs to (NULL for staff). Read by the client guard
 *    (middleware/clientGuard.ts) and authenticate (req.user.clientCampaignId). The demo client account
 *    (Hannah Price, Breast Cancer Now, CL-0001) is inserted by the CORE demo seed (db/seed.ts), not here.
 *  - client_posts: what a client posted from the portal — kind 'update' | 'announcement' | 'commission', title, body,
 *    the proposed rates and effective date for a commission change, status 'published' | 'pending' | 'approved' |
 *    'declined' | 'unpublished', the decision (who, when, the note the client sees) and the Announcements row it
 *    published. P6 adds `requested_from`: the date the client asked for (effective_from becomes the date Matt confirms),
 *    and `posted_at`: the REAL-clock instant a portal post arrived (created_at is the business clock, what the office
 *    reads); the 24-hour limit and the double-tap window count on it, as every rate limit does. NULL for demo rows.
 *  - client_post_reads (P6): which admin or leader has read which client post (the sidebar Campaigns badge and the
 *    Needs-attention items), once per person, like announcement_reads.
 *  - campaigns columns (the campaign page): long_description, brief, contact_name, contact_email, contact_phone. The
 *    demo seed fills them for the four seeded campaigns (columns this extension added; see ./types.ts).
 *
 * Demo rows (fresh seed only, from ctx.clients — Hannah Price of BCN): two published posts (an announcement and an
 * update, each with its Announcements row authored by Hannah, the one core-row insert the rules allow), a declined
 * commission change, a pending one (Matt's Needs-attention item), and, for every campaign rate the pay seed recorded as
 * a client's approved change (campaign_rates.source = 'client', P1's demo history), the approved post it came from
 * (linked through campaign_rates.client_post_id, the column P1 laid down for it). The owner has read the older posts.
 * The two published posts' Announcements rows also get read receipts from a share of the active staff
 * (announcement_reads, the audit extension's table, whose own seed ran before these rows existed).
 * Deterministic: no random stream, times from ctx.today / ctx.nowIso.
 *
 * Release 1.3.1, the charity account on an OLDER demo database (`ext:client:demo-account`, addDemoClientAccount below):
 * a demo database first seeded before 1.3 (the owner's Mac) has no demo client, so nothing showed under the demo
 * accounts. On start-up such a database gains Hannah once — the same row the core seed makes (lib/client.ts
 * insertDemoClientAccounts), the same marker, and the demo posts above — so the sign-in page shows her under "Charity
 * accounts". Only on a database the demo seed created (meta `seeded_at` and `seed_today`), never on a real one; skipped
 * without the flag while the core tables are empty (the fresh-install upgrade runs before the seed); never when the demo
 * seed already made her (its marker), nor when someone already holds her access code or email. Reports
 * `demo-account` only when it inserted her, so the first restart after a fresh seed reports nothing. Rules: ./types.ts.
 */
import { all, get, transaction, type Db } from '../connection.ts';
import { CLIENT_ACCOUNTS } from '../seed-data.ts';
import { clientPayPlanId, demoClientMarkers, insertDemoClientAccounts, writeDemoClientMarkers } from '../../lib/client.ts';
import { nowISO, todayISO } from '../../lib/dates.ts';
import { demoTeamMarkers, isDemoDatabase } from '../../lib/demoTeams.ts';
import type { DbExtension, SeedClientRef, SeedContext, SeedUserRef } from './types.ts';
import { addColumnIfMissing, metaFlag, setMetaFlag } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS client_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  rate_rep REAL,
  rate_payout REAL,
  effective_from TEXT,
  status TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT,
  decision_note TEXT,
  announcement_id INTEGER REFERENCES announcements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  requested_from TEXT,
  posted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_posts_campaign ON client_posts(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_client_posts_status ON client_posts(status);
CREATE TABLE IF NOT EXISTS client_post_reads (
  post_id INTEGER NOT NULL REFERENCES client_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_client_post_reads_user ON client_post_reads(user_id);
`;

/** The campaign page's brief for the four seeded campaigns (by code). Phone numbers are Ofcom's drama ranges. */
export const CAMPAIGN_BRIEFS: Record<string, { longDescription: string; brief: string; contactName: string; contactEmail: string; contactPhone: string }> = {
  BCN: {
    longDescription:
      'Breast Cancer Now is the UK research and support charity for everyone affected by breast cancer. Linear MCR signs up regular givers for them at private sites such as supermarkets and garden centres, and in shopping centres across the North West. Every sub is a monthly gift by Direct Debit, and the charity calls each new supporter within two weeks to say thank you.',
    brief:
      'Lead with the helpline and the nurse service, then the research.\nThe minimum gift is £8 a month; suggest £10.\nDonors must be 18 or over and the account holder.\nNever pressure anyone: if someone hesitates, give them a leaflet and thank them.\nWear the pink tabard and the charity ID badge at all times.',
    contactName: 'Hannah Price',
    contactEmail: 'hannah.price@breastcancernow.example',
    contactPhone: '0161 496 0732',
  },
  CHN: {
    longDescription:
      "Children's Hospice North runs two hospices and a hospice-at-home team for children with life-limiting conditions across the North of England. Linear MCR finds monthly donors at public events, retail sites and private sites. Each regular gift helps fund care at home and short breaks for whole families.",
    brief:
      'Talk about care for the whole family, at the hospice and at home.\nThe minimum gift is £6 a month; suggest £8.\nShow the "A day at the hospice" card and keep away from upsetting detail.\nDonors must be 18 or over.\nAt events, set up 30 minutes before the start and stay inside the marked pitch.',
    contactName: 'Rachel Okafor',
    contactEmail: 'rachel.okafor@childrenshospicenorth.example',
    contactPhone: '0113 496 0415',
  },
  VLT: {
    longDescription:
      "Volt Energy supplies electricity and gas to small and medium businesses. Linear MCR speaks to owners and managers on business parks and high streets in Greater Manchester and books a free switching quote with Volt's own team.",
    brief:
      "Ask for the person who pays the energy bills.\nA sale is a signed quote request with a photo of a recent bill.\nNever promise a price: Volt's team quotes within two working days.\nNo visits before 09:30 or after 17:00.",
    contactName: 'Tom Ashworth',
    contactEmail: 'tom.ashworth@voltenergy.example',
    contactPhone: '0161 496 0981',
  },
  FCB: {
    longDescription:
      'FibreCity builds full-fibre broadband in newly enabled residential areas. Linear MCR knocks on doors in each new patch and runs retail pop-ups, signing households up for installation.',
    brief:
      'Check the address is live on the FibreCity postcode checker before you pitch.\nPackages start at £25 a month; the 18-month contract has no price rise.\nInstallation is within 14 days; the customer must be the bill payer and 18 or over.\nLeave a calling card when nobody answers.',
    contactName: 'Ben Walsh',
    contactEmail: 'ben.walsh@fibrecity.example',
    contactPhone: '0161 496 0256',
  },
};

/** "YYYY-MM-DD" + n days (UTC arithmetic, so no clock change shifts the day). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week `date` is in. */
function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

/** A business-local time on a date, as an ISO instant (like db/seed.ts `ts`), never later than `nowIso`. */
function at(date: string, hhmm: string, nowIso: string): string {
  const iso = new Date(`${date}T${hhmm}:00`).toISOString();
  return iso < nowIso ? iso : nowIso;
}

interface DemoPost {
  kind: 'update' | 'announcement' | 'commission';
  title: string;
  body: string;
  rateRep?: number | null;
  ratePayout?: number | null;
  effectiveFrom?: string | null;
  status: 'published' | 'pending' | 'approved' | 'declined';
  createdAt: string;
  decidedAt?: string | null;
  decisionNote?: string | null;
}

function insertPost(db: Db, client: SeedClientRef, p: DemoPost, deciderId: number | null): number {
  let announcementId: number | null = null;
  if (p.status === 'published') {
    announcementId = Number(
      db.prepare(`INSERT INTO announcements (title, body, author_id, created_at, pinned) VALUES (?, ?, ?, ?, 0)`).run(p.title, p.body, client.id, p.createdAt).lastInsertRowid,
    );
  }
  const decided = p.status === 'approved' || p.status === 'declined';
  return Number(
    db
      .prepare(
        `INSERT INTO client_posts (campaign_id, author_id, kind, title, body, rate_rep, rate_payout, effective_from, requested_from, status, decided_by, decided_at, decision_note, announcement_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.campaignId, client.id, p.kind, p.title, p.body, p.rateRep ?? null, p.ratePayout ?? null, p.effectiveFrom ?? null,
        p.effectiveFrom ?? null, p.status, decided ? deciderId : null, decided ? (p.decidedAt ?? null) : null, p.decisionNote ?? null,
        announcementId, p.createdAt,
      ).lastInsertRowid,
  );
}

const money = (n: number) => `£${n.toFixed(2)}`;

/** The demo rows described in the header (fresh seed only). Exported for its own test. */
export function seedClientDemo(db: Db, ctx: Pick<SeedContext, 'today' | 'nowIso' | 'users' | 'clients' | 'campaigns'>): void {
  // Campaign briefs: only the columns this extension added to `campaigns`.
  const brief = db.prepare(`UPDATE campaigns SET long_description = ?, brief = ?, contact_name = ?, contact_email = ?, contact_phone = ? WHERE id = ?`);
  for (const c of ctx.campaigns) {
    const b = CAMPAIGN_BRIEFS[c.code.toUpperCase()];
    if (b) brief.run(b.longDescription, b.brief, b.contactName, b.contactEmail, b.contactPhone, c.id);
  }

  const owner = ctx.users.find((u) => u.employeeId.toUpperCase() === 'LM-0001' && u.role === 'admin') ?? ctx.users.find((u) => u.role === 'admin' && u.status === 'active');
  const ownerId = owner?.id ?? null;
  const leaders = ctx.users.filter((u) => u.role === 'leader' && u.status === 'active');
  const { today, nowIso } = ctx;
  const readBy = db.prepare(`INSERT OR IGNORE INTO client_post_reads (post_id, user_id, read_at) VALUES (?, ?, ?)`);

  for (const client of ctx.clients) {
    const day = (n: number) => addDays(today, -n);
    // A commission change the office declined, three and a half weeks ago.
    const declinedFrom = addDays(mondayOf(day(24)), 70);
    const declined = insertPost(db, client, {
      kind: 'commission',
      title: 'Lower payout per sub for the winter',
      body: 'Our budget for the winter quarter is tighter than we planned. Could we pay Linear £100 per sub from the date below?',
      ratePayout: 100,
      effectiveFrom: declinedFrom,
      status: 'declined',
      createdAt: at(day(24), '10:15', nowIso),
      decidedAt: at(day(22), '16:40', nowIso),
      decisionNote: 'We agreed £120 per sub until the end of March. Happy to talk about it at our next quarterly review.',
    }, ownerId);
    // An announcement for the fundraisers, nine days ago.
    const walk = insertPost(db, client, {
      kind: 'announcement',
      title: 'Pink Ribbon Walk: tell your supporters',
      body: 'Our Pink Ribbon Walk at Tatton Park is back next June. If a supporter asks about events, they can register their interest at breastcancernow.example/walk. Thank you all for a brilliant September.',
      status: 'published',
      createdAt: at(day(9), '09:40', nowIso),
    }, ownerId);
    // An update, three days ago (not read by the office yet).
    const update = insertPost(db, client, {
      kind: 'update',
      title: 'New welcome pack for October donors',
      body: 'From this week every new regular giver gets our updated welcome pack by post within 10 days. If a donor asks, the first letter confirms their gift and how to change it. The old leaflets can go in the recycling.',
      status: 'published',
      createdAt: at(day(3), '14:05', nowIso),
    }, ownerId);
    // A commission change waiting for Matt (his Needs-attention item), yesterday, from the Monday after next.
    const nextFrom = addDays(mondayOf(today), 14);
    insertPost(db, client, {
      kind: 'commission',
      title: 'Higher rate per sub for the winter appeal',
      body: `Our trustees approved a higher rate for the winter appeal. We would like fundraisers to get ${money(22)} per sub from the date below.`,
      rateRep: 22,
      effectiveFrom: nextFrom,
      status: 'pending',
      createdAt: at(day(1), '11:20', nowIso),
    }, ownerId);

    // The approved posts behind the pay seed's client rate changes (none until P1's demo history has them).
    const rates = db
      .prepare(`SELECT id, rep_rate AS repRate, effective_from AS effectiveFrom FROM campaign_rates WHERE campaign_id = ? AND source = 'client' AND client_post_id IS NULL ORDER BY effective_from`)
      .all(client.campaignId) as { id: number; repRate: number; effectiveFrom: string }[];
    const link = db.prepare(`UPDATE campaign_rates SET client_post_id = ? WHERE id = ?`);
    const approved: number[] = [];
    for (const r of rates) {
      if (r.effectiveFrom > today) continue;
      const postId = insertPost(db, client, {
        kind: 'commission',
        title: 'New rate per sub for the autumn',
        body: `We would like to pay fundraisers ${money(r.repRate)} per sub from the date below.`,
        rateRep: r.repRate,
        effectiveFrom: r.effectiveFrom,
        status: 'approved',
        createdAt: at(addDays(r.effectiveFrom, -6), '10:00', nowIso),
        decidedAt: at(addDays(r.effectiveFrom, -3), '16:30', nowIso),
      }, ownerId);
      link.run(postId, r.id);
      approved.push(postId);
    }

    // The owner has read the older posts; the leaders the announcement. The update and the pending change are new.
    if (ownerId) for (const id of [declined, walk, ...approved]) readBy.run(id, ownerId, nowIso);
    for (const l of leaders) readBy.run(walk, l.id, nowIso);

    // Who has read the client's announcements in Announcements ("Read by 22 of 28"): the audit extension's seed ran
    // before these rows existed, so they get receipts here, the same way: more readers the longer it has been up.
    seedClientAnnouncementReads(db, ctx, [walk, update]);
  }
}

/**
 * announcement_reads (the audit extension's table, never a core one) for the Announcements rows the demo posts above
 * published: a share of the active staff that grows with the post's age (35% when new, 90% after a week, like the
 * audit seed), each at a time between the post and now. Deterministic (no random numbers), idempotent.
 */
function seedClientAnnouncementReads(db: Db, ctx: Pick<SeedContext, 'nowIso' | 'users'>, postIds: number[]): void {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'announcement_reads'`).get()) return;
  const readers = ctx.users.filter((u) => u.status === 'active');
  const nowMs = Date.parse(ctx.nowIso);
  const insert = db.prepare(`INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)`);
  const rows = db
    .prepare(`SELECT a.id, a.created_at AS createdAt FROM client_posts p JOIN announcements a ON a.id = p.announcement_id WHERE p.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(postIds)) as { id: number; createdAt: string }[];
  for (const a of rows) {
    const postedMs = Date.parse(a.createdAt);
    if (!Number.isFinite(postedMs) || postedMs > nowMs) continue;
    const ageHours = (nowMs - postedMs) / 3_600_000;
    const share = Math.min(0.9, 0.35 + (ageHours / 168) * 0.55);
    readers.forEach((u, i) => {
      // every reader gets a fixed slot in 0..19 (spread by the announcement id); the first `share` of the slots read it
      if (((i * 7 + a.id * 3) % 20) / 20 >= share) return;
      const afterHours = Math.min(ageHours, 0.5 + ((i * 13 + a.id) % 47));
      insert.run(a.id, u.id, new Date(postedMs + afterHours * 3_600_000).toISOString());
    });
  }
}

/** meta flag: the one-off step below has run (or decided not to) on this database; it never runs again. */
export const DEMO_CLIENT_STEP_KEY = 'ext:client:demo-account';

/**
 * The one-off step described in the header: true when it inserted the demo charity account. Its demo posts are dated
 * from today's business date; read receipts come from the active staff, never the blank demo teams (team Sapiens stays
 * empty). A campaign brief is filled only where every brief field is still empty, so nothing Matt typed is replaced.
 */
export function addDemoClientAccount(db: Db): boolean {
  if (metaFlag(db, DEMO_CLIENT_STEP_KEY) || demoClientMarkers(db).length > 0) return false;
  if (!isDemoDatabase(db)) return false;
  // the core rows it needs are missing (a fresh install before its seed): try again on the next start
  if (!get(db, `SELECT 1 FROM users LIMIT 1`) || !get(db, `SELECT 1 FROM pay_plans LIMIT 1`) || !get(db, `SELECT 1 FROM campaigns LIMIT 1`)) return false;
  return transaction(db, () => {
    setMetaFlag(db, DEMO_CLIENT_STEP_KEY);
    // someone already holds the access code or the email (a real contact, or one typed in by hand): leave them be
    const free = CLIENT_ACCOUNTS.filter((c) => !get(db, `SELECT 1 FROM users WHERE employee_id = ? COLLATE NOCASE OR email = ? COLLATE NOCASE`, [c.code, c.email]));
    if (!free.length) return false;
    const today = todayISO();
    const clients = insertDemoClientAccounts(db, { today, payPlanId: clientPayPlanId(db), accounts: free });
    if (!clients.length) return false; // no Breast Cancer Now campaign on this database
    writeDemoClientMarkers(db, clients);
    const blank = new Set(demoTeamMarkers(db).flatMap((m) => m.accounts.map((a) => a.id)));
    const users = all<SeedUserRef>(
      db,
      `SELECT id, employee_id AS employeeId, first_name AS firstName, last_name AS lastName, role, position, team_id AS teamId, status, start_date AS startDate
       FROM users WHERE role <> 'client' ORDER BY id`,
    ).filter((u) => !blank.has(u.id));
    const campaigns = all<{ id: number; code: string; name: string }>(
      db,
      `SELECT id, code, name FROM campaigns
       WHERE long_description IS NULL AND brief IS NULL AND contact_name IS NULL AND contact_email IS NULL AND contact_phone IS NULL ORDER BY id`,
    );
    seedClientDemo(db, { today, nowIso: nowISO(), users, clients, campaigns });
    return true;
  });
}

export const extension: DbExtension = {
  name: 'client',
  sql: SQL,
  upgrade(db) {
    const added = [
      addColumnIfMissing(db, 'users', 'client_campaign_id', 'INTEGER'),
      addColumnIfMissing(db, 'campaigns', 'long_description', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'brief', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'contact_name', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'contact_email', 'TEXT'),
      addColumnIfMissing(db, 'campaigns', 'contact_phone', 'TEXT'),
      // P6: a database created at the foundation commit has client_posts without it.
      addColumnIfMissing(db, 'client_posts', 'requested_from', 'TEXT'),
      // P6: the real-clock moment of a portal post (the daily limit and the double-tap window; created_at is business time).
      addColumnIfMissing(db, 'client_posts', 'posted_at', 'TEXT'),
    ];
    // The guard and the portal look client accounts up by campaign (after the column exists; idempotent).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_client_campaign ON users(client_campaign_id)`);
    const changed = added.filter((name): name is string => name !== null);
    if (addDemoClientAccount(db)) changed.push('demo-account');
    return changed;
  },
  seed(db, ctx) {
    seedClientDemo(db, ctx);
  },
};
