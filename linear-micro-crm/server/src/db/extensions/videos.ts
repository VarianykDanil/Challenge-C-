/**
 * Release 1.3 — OWNED BY P5 learning-videos (laid down by r3-foundation: the tables are the contract; P5 adds the
 * columns below and the demo rows).
 *
 *  - learning_videos: kind 'upload' (file_path "videos/<uuid>.<ext>" under the media folder next to the database —
 *    server/data/media by default, git-ignored —, mime, size, poster_path for its still) or 'link' (url: YouTube /
 *    Vimeo / Google Drive); title, description, topic, duration, required (adds it to the Learning checklist of
 *    everyone it is required for), audience ('everyone' | 'leaders' | 'reps'), example (demo rows).
 *  - video_views: one row per (video, person): seconds seen (each part once), the position to resume from,
 *    completed_at (90 % seen, or "Mark as watched" on a Google Drive link), the last report, and `ranges` — the parts
 *    seen as JSON [[from, to], …] in whole seconds, so a replayed minute counts once (shared mergeWatchedRanges);
 *    `marked` (1 when "Mark as watched" made it watched, stored rather than worked out, so a length changed later
 *    never turns a real watch into "Marked"), and the watch credit (`credit_s` left after the last report and
 *    `credit_at`, real-clock milliseconds of that report: shared watchCreditAt; NULL for a viewing with no report yet).
 *  - meta `ext:videos:leaders_can_add` ('1' when Matt lets leaders add videos; absent or '0' otherwise).
 *
 * `upgrade` adds the P5 columns to tables made at the foundation commit (a fresh database has them from `sql`).
 * `seed` writes, for a fresh demo database only, three example LINK videos (public TED talks on YouTube, marked
 * example = 1 so every screen says "Example"; no file is uploaded) and some viewing for the demo people, from its own
 * random stream. It never touches a core table. The nightly backup copies the database only: back up the media
 * folder yourself (P5's Owner notes).
 */
import type { Db } from '../connection.ts';
import { addColumnIfMissing, type DbExtension, type SeedContext, type SeedUserRef } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS learning_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT 'other',
  kind TEXT NOT NULL,
  url TEXT,
  file_path TEXT,
  mime TEXT,
  size INTEGER,
  duration_s INTEGER,
  required INTEGER NOT NULL DEFAULT 0,
  audience TEXT NOT NULL DEFAULT 'everyone',
  example INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  poster_path TEXT
);

CREATE TABLE IF NOT EXISTS video_views (
  video_id INTEGER NOT NULL REFERENCES learning_videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watched_s INTEGER NOT NULL DEFAULT 0,
  position_s INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  last_at TEXT,
  ranges TEXT,
  marked INTEGER NOT NULL DEFAULT 0,
  credit_s REAL,
  credit_at INTEGER,
  PRIMARY KEY (video_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_video_views_user ON video_views(user_id);
`;

export const LEADERS_CAN_ADD_META_KEY = 'ext:videos:leaders_can_add';

/** The demo's example videos: public TED talks, lengths typed in by hand. */
export const EXAMPLE_VIDEOS = [
  {
    title: 'How to speak so that people want to listen',
    description:
      'Example video (a public TED talk by Julian Treasure) showing how Learning videos work: replace it with your own recorded talks. ' +
      'The habits that stop people listening, and how to use your voice — pace, pitch, volume and silence — for the intro and the pitch.',
    url: 'https://www.youtube.com/watch?v=eIho2S0ZahI',
    topic: 'pitching',
    durationS: 598,
    required: true,
    audience: 'everyone',
    daysAgo: 20,
  },
  {
    title: 'Your body language may shape who you are',
    description:
      'Example video (a public TED talk by Amy Cuddy). How you stand changes how others see you and how you feel: worth two minutes before an interview or a first stop of the day.',
    url: 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc',
    topic: 'interviews',
    durationS: 1262,
    required: false,
    audience: 'everyone',
    daysAgo: 16,
  },
  {
    title: 'How great leaders inspire action',
    description:
      'Example video (a public TED talk by Simon Sinek): start with why. Required for team leaders — the why behind the team, before the what and the how.',
    url: 'https://www.youtube.com/watch?v=qp0HIF3SfI4',
    topic: 'leadership',
    durationS: 1084,
    required: true,
    audience: 'leaders',
    daysAgo: 12,
  },
] as const;

const DAY = 86_400_000;
const HOUR = 3_600_000;

function seedVideos(db: Db, ctx: SeedContext): void {
  const rng = ctx.rng(0x5056);
  const now = Date.parse(ctx.nowIso);
  const iso = (ms: number) => new Date(Math.min(ms, now)).toISOString();
  const admin = ctx.users.find((u) => u.role === 'admin' && u.status === 'active') ?? null;
  const insertVideo = db.prepare(
    `INSERT INTO learning_videos (title, description, topic, kind, url, duration_s, required, audience, example, created_by, created_at)
     VALUES (?, ?, ?, 'link', ?, ?, ?, ?, 1, ?, ?)`,
  );
  const insertView = db.prepare(
    `INSERT OR IGNORE INTO video_views (video_id, user_id, watched_s, position_s, completed_at, last_at, ranges) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids = EXAMPLE_VIDEOS.map((v) =>
    Number(insertVideo.run(v.title, v.description, v.topic, v.url, v.durationS, v.required ? 1 : 0, v.audience, admin?.id ?? null, iso(now - v.daysAgo * DAY)).lastInsertRowid),
  );

  /** A view: watched to the end (completed) or `share` of the way (resume there). */
  const view = (videoIndex: number, u: SeedUserRef, share: number) => {
    const v = EXAMPLE_VIDEOS[videoIndex]!;
    const seen = Math.min(v.durationS, Math.round(v.durationS * share));
    const done = share >= 1;
    const at = now - rng.int(1, Math.max(1, v.daysAgo - 1)) * DAY - rng.int(0, 10) * HOUR;
    insertView.run(ids[videoIndex]!, u.id, seen, done ? 0 : seen, done ? iso(at) : null, iso(at), JSON.stringify([[0, seen]]));
  };

  for (const u of ctx.users) {
    if (u.status !== 'active') continue;
    if (u.role === 'admin') {
      // whoever added them has watched them
      view(0, u, 1);
      view(2, u, 1);
      continue;
    }
    if (u.employeeId === 'LM-0010') {
      // The demo rep (Jordan Lee): the required talk watched, the body-language one a third of the way (Resume).
      view(0, u, 1);
      view(1, u, 0.34);
      continue;
    }
    if (u.employeeId === 'LM-0002') {
      // The demo leader (Amelia Hart): the required talk watched; the leaders' one half way, still to finish.
      view(0, u, 1);
      view(2, u, 0.5);
      continue;
    }
    const r = rng.next();
    if (r < 0.55) view(0, u, 1);
    else if (r < 0.75) view(0, u, 0.2 + rng.next() * 0.6);
    if (rng.chance(0.3)) view(1, u, rng.chance(0.6) ? 1 : 0.15 + rng.next() * 0.5);
    if (u.role === 'leader' && rng.chance(0.5)) view(2, u, 1);
  }
}

function upgradeVideos(db: Db): string[] {
  return [
    // P5 columns on the foundation's tables (a database created at the foundation commit has the tables without them)
    addColumnIfMissing(db, 'learning_videos', 'poster_path', 'TEXT'),
    addColumnIfMissing(db, 'video_views', 'ranges', 'TEXT'),
    addColumnIfMissing(db, 'video_views', 'marked', 'INTEGER NOT NULL DEFAULT 0'),
    addColumnIfMissing(db, 'video_views', 'credit_s', 'REAL'),
    addColumnIfMissing(db, 'video_views', 'credit_at', 'INTEGER'),
  ].filter((c): c is string => c !== null);
}

export const extension: DbExtension = {
  name: 'videos',
  sql: SQL,
  upgrade: upgradeVideos,
  seed: seedVideos,
};
