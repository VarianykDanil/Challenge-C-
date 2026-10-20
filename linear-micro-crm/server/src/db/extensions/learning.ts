/**
 * Release 1.2 — OWNED BY L1 learning-pack. Rules: ./types.ts.
 *
 *  learning_progress    one row per (person, COD pack lesson): the self-check (learned_at, last quiz score), the
 *                       teach-back in their own words, and the leader's / admin's sign-off ("taught").
 *  learning_milestones  the progression criteria the office ticks by hand (no data behind them), e.g. "4 + 1 or 3 + 2".
 *
 * Both are new tables, so an existing database needs no data step (`upgrade` changes nothing). `seed` writes demo
 * progress for a fresh demo database only, from its own random stream; it never touches a core table.
 */
import { LESSON_KEYS, type LessonKey } from '@lm/shared';
import type { Db } from '../connection.ts';
import type { DbExtension, SeedContext, SeedUserRef } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS learning_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_key TEXT NOT NULL,
  learned_at TEXT,
  quiz_score INTEGER,
  quiz_total INTEGER,
  teachback_text TEXT,
  teachback_at TEXT,
  taught_signed_off_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  taught_signed_off_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, lesson_key)
);
CREATE INDEX IF NOT EXISTS idx_learning_progress_pending ON learning_progress(teachback_at) WHERE taught_signed_off_at IS NULL;

CREATE TABLE IF NOT EXISTS learning_milestones (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (user_id, milestone_key)
);
`;

/** Demo teach-backs: what a rep might write in their own words for each lesson. */
const DEMO_TEACHBACKS: Record<LessonKey, string> = {
  'five-steps': 'Intro in 7–10 seconds with a smile, eye contact and excitement; short story answers who, what and why; presentation creates the problem and we are the solution; close with an assumptive statement; consolidate so they remember why they signed up.',
  'working-habits': 'Great attitude, be on time, be prepared, work the full 8 hours, work the territory properly, keep the attitude up, know your why and take control of your day.',
  'law-of-averages': 'The more stops I make the more sales come. If I keep the numbers up the ratios look after themselves, so I never stop stopping people.',
  'impulse-factors': 'GIFGUP: greed, indifference, fear of loss, group effect, urgency and power of suggestion. Greed is the most important one, fear of loss goes at the end in the qualifying questions.',
  'green-light-theory': '10% will never stop, 80% are indifferent and 10% are positive. I spend all my time on the positive ones, some time on the indifferent ones and none on the negatives.',
  'gumball-theory': 'Out of 100 gumballs only 3 are strawberry, so you have to put in the full £100 to get all 3. You never know when the sales drop, so give every person 100%.',
  'can-cant-controls': 'I can control my pitch, my pace and my attitude. I cannot control the weather, the footfall or the people, so I do not waste energy on them.',
  'buying-signs': 'Buying signs are see factors, nodding, positive questions, facing the stand, leaning in and open body language. Non-buying signs are the opposite.',
  'strategic-pause': 'Pausing on purpose adds effect and shows confidence. I pause after the big fact so it lands.',
  'bamboo-theory': 'Even when the results do not show, growth is happening under the surface. Keep doing the fundamentals and trust the process.',
  'pre-emptive-strike': 'Attack the negative before it comes up: "I know you are busy". Then follow straight up with urgency.',
  'attitude-regain': 'Your attitude is a battery: recharge it at 80%, not 20%. Take a break, eat, talk to your leader. Every time you lose it and get it back it grows like a muscle.',
  'bullet-theory': 'Six objections: no money, no time, other charities, bank details, direct debit and C.O.W.S. Use AIR, feel felt found and RRR, and always be closing after every overturn.',
  'straight-line-theory': 'Stay between the friend zone and the business zone. Use FORM to find hotspots and 2:1, two things about them and one about me, then back to the pitch.',
  'core-principles': '100% internal promotions, no seniority and everything comes down to performance: progression and pay.',
  'progression-structure': 'Entry level needs 14 sales a week or 12 two weeks in a row and the COD pack taught back. Leadership means training 3 people to leadership.',
  'direct-indirect-marketing': 'Direct is face to face: events, B2B, door to door and telesales. Indirect is billboards, social media, newspapers, TV and radio.',
  'assuming-the-role': 'Act like a leader before you are one: professional image, help the leaders with tablets and merchandise, and be a problem solver not a problem finder.',
  'theory-of-teachback': 'Keep it simple and check people understand, write the theory at the top of the whiteboard and underline it, never make anyone feel silly, and make it a conversation not a pitch.',
  'run-an-impact': 'I ran the impact at the morning meeting: everyone stood up, we set the targets for the day and the energy carried into the first hour.',
  'go-on-a-roadtrip': 'Went on the roadtrip with the team. Working a new territory kept the urgency up and I learned a lot from watching the other leaders.',
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIELD_POSITIONS = new Set(['trainee', 'field_rep', 'team_leader', 'crew_leader', 'assistant_owner', 'owner']);
const LEADER_POSITIONS = new Set(['team_leader', 'crew_leader', 'assistant_owner', 'owner']);

function seedLearning(db: Db, ctx: SeedContext): void {
  const rng = ctx.rng(0x4c31);
  const now = Date.parse(ctx.nowIso);
  const iso = (ms: number) => new Date(Math.min(ms, now)).toISOString();
  const admins = ctx.users.filter((u) => u.role === 'admin' && u.status === 'active');
  const leaderOf = new Map(ctx.teams.map((t) => [t.id, t.leaderId] as const));
  /** Who signs off: the person's team leader, else the first admin who is not them. */
  const signer = (u: SeedUserRef): number | null => {
    const lead = u.teamId !== null ? leaderOf.get(u.teamId) ?? null : null;
    if (lead !== null && lead !== u.id) return lead;
    return admins.find((a) => a.id !== u.id)?.id ?? null;
  };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO learning_progress
       (user_id, lesson_key, learned_at, quiz_score, quiz_total, teachback_text, teachback_at, taught_signed_off_by, taught_signed_off_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const milestone = db.prepare(
    `INSERT OR IGNORE INTO learning_milestones (user_id, milestone_key, value, set_by, set_at) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const u of ctx.users) {
    if (u.status !== 'active') continue;
    let learned: number;
    let taught: number;
    let sent: number;
    if (u.employeeId === 'LM-0010') {
      // The demo rep (Jordan Lee): 9 learned, 4 signed off, 2 teach-backs waiting for the leader.
      [learned, taught, sent] = [9, 4, 2];
    } else if (u.role === 'recruiter' || !FIELD_POSITIONS.has(u.position)) {
      [learned, taught, sent] = [3, 0, 0];
    } else if (LEADER_POSITIONS.has(u.position)) {
      [learned, taught, sent] = [LESSON_KEYS.length, LESSON_KEYS.length, 0];
    } else if (u.position === 'trainee') {
      learned = rng.int(2, 6);
      taught = rng.int(0, 1);
      sent = rng.chance(0.5) ? 1 : 0;
    } else {
      learned = rng.int(6, 16);
      taught = rng.int(1, Math.max(1, learned - 4));
      sent = rng.int(0, 2);
    }
    sent = Math.min(sent, learned - taught);
    const by = signer(u);
    // Lessons are learned in checklist order, a couple of days apart, ending a few days ago.
    const end = now - rng.int(1, 4) * DAY;
    for (let i = 0; i < learned; i++) {
      const key = LESSON_KEYS[i]!;
      const task = key === 'run-an-impact' || key === 'go-on-a-roadtrip';
      const learnedAt = end - (learned - i) * 2 * DAY - rng.int(0, 8) * HOUR;
      const writes = i < taught + sent;
      const teachAt = writes ? learnedAt + DAY + rng.int(0, 6) * HOUR : null;
      const signed = i < taught && by !== null;
      const signedAt = signed && teachAt !== null ? teachAt + rng.int(4, 30) * HOUR : null;
      insert.run(
        u.id, key, iso(learnedAt), task ? 1 : 3, task ? 1 : 3,
        writes ? DEMO_TEACHBACKS[key] : null, teachAt === null ? null : iso(teachAt),
        signed ? by : null, signedAt === null ? null : iso(signedAt),
        iso(signedAt ?? teachAt ?? learnedAt),
      );
    }
    // The office's ticks: a leader with one person already brought through, a campaign manager showing consistency.
    const admin = admins[0]?.id ?? null;
    if (u.position === 'team_leader' && rng.chance(0.5)) milestone.run(u.id, 'trained_leaders', 1, admin, iso(now - 20 * DAY));
    if (u.position === 'crew_leader') milestone.run(u.id, 'consistency', 1, admin, iso(now - 30 * DAY));
  }
}

export const extension: DbExtension = {
  name: 'learning',
  sql: SQL,
  // Two new tables (created by `sql` on every start): nothing to add to an existing database.
  upgrade: () => [],
  seed: seedLearning,
};
