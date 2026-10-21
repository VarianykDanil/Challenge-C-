/**
 * Release 1.2 — OWNED BY L2 learning-pitch.
 *
 * campaign_pitches: one pitch per campaign (the script as plain text, the fact-check notes, who saved it and when).
 * The owner's BCN (Breast Cancer Now) pitch is added word for word, with its fact-check notes, for the BCN campaign:
 *  - on a fresh demo seed by `seed` (the campaigns exist by then);
 *  - on an existing database by `upgrade`, once (meta `ext:pitches:bcn`), when a BCN campaign exists. On a fresh install
 *    `upgrade` runs before the seed on an empty campaigns table: it then skips without setting the flag, and `seed`
 *    adds the pitch. Both write INSERT OR IGNORE on campaign_id, so they never clash, and `upgrade` reports a change only
 *    when a row went in. Rules: ./types.ts ("ORDER ON A FRESH INSTALL").
 * Other campaigns get no pitch: the page offers admins and leaders "Write the pitch".
 *
 * Since the 1.2 review: the fact check has one note per quoted line (each line its own suggested wording). A database seeded
 * by 1.2.0 holds the old merged notes (BCN_PITCH_FACTS_V1); `upgrade` swaps them for the new ones once (meta
 * `ext:pitches:facts-v2`), and only while the pitch is exactly as seeded: same title, script and notes, saved by the
 * owner (the seed's saver) or nobody. A pitch a person edited is never touched; who saved it and when stay as they were.
 */
import { nowISO } from '../../lib/dates.ts';
import type { Db } from '../connection.ts';
import { metaFlag, setMetaFlag, type DbExtension } from './types.ts';

/** The owner's BCN pitch, exactly as written (stage directions in brackets). Never "corrected" here: see the facts. */
export const BCN_PITCH_BODY = `Over 1000 women are dying from breast cancer every month
(Pause - 1 Second)

That's every 43 minutes someone is losing a mother, a daughter or a wife
(Pause - 1 Second)

(Slow smile and cautious)

I know that's a little bit heavy for a Monday afternoon ok I'm not here to depress you. I'll leave that giant over there ahahah

What we do is provide emotional and practical support to the individuals suffering and the families

Do you know anyone who has suffered from breast cancer

Yes -
If you don't mind me asking how was there support?

So you can see the significance of why we are here.

No - Count yourself lucky it's definitely on the rise in the UK.

Our mission is by 2050 anyone diagnosed will live and be supported to live well.

As of 1980 it was a 50% survival rate to as of 2025 87%

(Name) we we literally this close 🤏🏾 to our goal where we will have a world we're breast cancer isn't destroying lives.

Pretty amazing right!! (Close)

But unfortunately it does cost us millions of pounds a year. Now as smart as you're looking gonna guess you're not a millionaire and if you are, have you got some for me? (Smile and laugh)

But the amazing people like yourself who have stopped it said they'd love to help out and support as long as it was something small something they wouldn't miss a few quid out of the week a tenner a month.

You may not seem like much, but we all come together it definitely makes life changing difference.

I'm sure we can count on your support as well however I would need to check

You live in the UK
You bank in the UK
Cheeky question are you slightly over the age of 35?`;

const BCN_DEATHS_SOURCE =
  'https://breastcancernow.org/about-us/media/statements/breast-cancer-now-responds-to-news-that-197-000-deaths-from-breast-cancer-have-been-avoided-in-the-uk-in-the-last-37-years';

/**
 * The fact check of the BCN pitch, one note per quoted line, shown beside the line it quotes ("Check the figures") and
 * flagged in the teleprompter and flashcards. Format: shared parsePitchFacts. The script itself is never changed.
 */
export const BCN_PITCH_FACTS = `- "Over 1000 women ... every month": Breast Cancer Now says about 11,500 women die of breast cancer each year in the UK, nearly 1,000 a month. Suggested accurate wording: "Nearly 1,000 women are dying from breast cancer in the UK every month" Source: ${BCN_DEATHS_SOURCE}
- "every 43 minutes": 11,500 a year is about one every 45 minutes. Suggested accurate wording: "That's every 45 minutes someone is losing a mother, a daughter or a wife" Source: ${BCN_DEATHS_SOURCE}
- "it's definitely on the rise in the UK": not checked yet. Check it against the Breast Cancer Now campaign brief before you use it.
- "by 2050 anyone diagnosed will live and be supported to live well": matches Breast Cancer Now's stated aim (https://breastcancernow.org/about-us/who-we-are).
- "As of 1980 it was a 50% survival rate ... 2025 87%": not verified. Cancer Research UK reports breast cancer death rates down 46% since the early 1970s. Use the figure in the charity's current campaign brief.
- "over the age of 35": not checked yet. Check the age against the Breast Cancer Now campaign brief before you use it.
- UK fundraising rules (Fundraising Regulator's Code of Fundraising Practice) require statements to donors to be accurate and not misleading; the office should approve the final figures.`;

/** 1.2.0's seeded fact check (one note for two lines). Kept only so `upgrade` can recognise an untouched pitch. */
export const BCN_PITCH_FACTS_V1 = `- "Over 1000 women ... every month" and "every 43 minutes": Breast Cancer Now says about 11,500 women die of breast cancer each year in the UK = nearly 1,000 a month, about one every 45 minutes. Suggested accurate wording: "Nearly 1,000 women die from breast cancer in the UK every month. That's one every 45 minutes." Source: https://breastcancernow.org/about-us/media/statements/breast-cancer-now-responds-to-news-that-197-000-deaths-from-breast-cancer-have-been-avoided-in-the-uk-in-the-last-37-years
- "by 2050 anyone diagnosed will live and be supported to live well": matches Breast Cancer Now's stated aim (https://breastcancernow.org/about-us/who-we-are).
- "As of 1980 it was a 50% survival rate ... 2025 87%": not verified. Cancer Research UK reports breast cancer death rates down 46% since the early 1970s. Use the figure in the charity's current campaign brief.
- UK fundraising rules (Fundraising Regulator's Code of Fundraising Practice) require statements to donors to be accurate and not misleading; the office should approve the final figures.`;

export const BCN_PITCH_TITLE = 'The BCN pitch';
export const BCN_CAMPAIGN_CODE = 'BCN';
const BCN_FLAG = 'ext:pitches:bcn';
const FACTS_V2_FLAG = 'ext:pitches:facts-v2';

const SQL = `
CREATE TABLE IF NOT EXISTS campaign_pitches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  facts TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
`;

/** Adds the BCN pitch unless the campaign already has one. True when a row went in. */
function insertBcnPitch(db: Db, campaignId: number, updatedBy: number | null, updatedAt: string): boolean {
  const r = db
    .prepare(`INSERT OR IGNORE INTO campaign_pitches (campaign_id, title, body, facts, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(campaignId, BCN_PITCH_TITLE, BCN_PITCH_BODY, BCN_PITCH_FACTS, updatedBy, updatedAt);
  return Number(r.changes) > 0;
}

/** Once: adds the BCN pitch to an existing database that has a BCN campaign but no pitch. */
function upgradeAddBcnPitch(db: Db): string[] {
  if (metaFlag(db, BCN_FLAG)) return [];
  const bcn = db.prepare(`SELECT id FROM campaigns WHERE code = ? COLLATE NOCASE`).get(BCN_CAMPAIGN_CODE) as { id: number } | undefined;
  // Fresh install (or no BCN campaign yet): nothing to attach the pitch to; try again on a later start.
  if (!bcn) return [];
  const owner = db.prepare(`SELECT id FROM users WHERE position = 'owner' AND status = 'active' ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  const added = insertBcnPitch(db, Number(bcn.id), owner ? Number(owner.id) : null, nowISO());
  setMetaFlag(db, BCN_FLAG);
  return added ? ['campaign_pitches.bcn'] : [];
}

/**
 * Once: 1.2.0's merged BCN notes → one note per line, only on a pitch nobody has edited (title, script and notes as
 * seeded; saved by the owner, the seed's saver, or nobody). Leaves updated_by / updated_at alone. Skips without the flag
 * while there is no BCN pitch (a fresh install's upgrade runs before the seed; the seed writes the new notes).
 */
function upgradeSplitBcnFacts(db: Db): string[] {
  if (metaFlag(db, FACTS_V2_FLAG)) return [];
  const pitch = db
    .prepare(`SELECT p.id FROM campaign_pitches p JOIN campaigns c ON c.id = p.campaign_id WHERE c.code = ? COLLATE NOCASE`)
    .get(BCN_CAMPAIGN_CODE) as { id: number } | undefined;
  if (!pitch) return [];
  const r = db
    .prepare(
      `UPDATE campaign_pitches SET facts = ?
        WHERE id = ? AND title = ? AND body = ? AND facts = ?
          AND (updated_by IS NULL OR updated_by IN (SELECT id FROM users WHERE position = 'owner'))`,
    )
    .run(BCN_PITCH_FACTS, Number(pitch.id), BCN_PITCH_TITLE, BCN_PITCH_BODY, BCN_PITCH_FACTS_V1);
  setMetaFlag(db, FACTS_V2_FLAG);
  return Number(r.changes) > 0 ? ['campaign_pitches.bcn-facts-v2'] : [];
}

export const extension: DbExtension = {
  name: 'pitches',
  sql: SQL,
  upgrade(db) {
    return [...upgradeAddBcnPitch(db), ...upgradeSplitBcnFacts(db)];
  },
  seed(db, ctx) {
    const bcn = ctx.campaigns.find((c) => c.code.toUpperCase() === BCN_CAMPAIGN_CODE);
    if (!bcn) return;
    const owner = ctx.users.find((u) => u.position === 'owner' && u.status === 'active');
    insertBcnPitch(db, bcn.id, owner?.id ?? null, ctx.nowIso);
    setMetaFlag(db, BCN_FLAG);
    // The seed writes the one-note-per-line fact check already.
    setMetaFlag(db, FACTS_V2_FLAG);
  },
};
