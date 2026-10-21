/**
 * Release 1.3 — OWNED BY P5 learning-videos (laid down by r3-foundation: tables are the contract; P5 adds the demo link
 * videos in `seed` — clearly marked `example = 1` — and further columns with addColumnIfMissing).
 *
 *  - learning_videos: kind 'upload' (file_path under server/data/media/videos/<uuid>.<ext>, git-ignored; mime, size)
 *    or 'link' (url: YouTube / Vimeo / Google Drive); title, description, topic, duration, required (adds it to
 *    everyone's Learning checklist), audience ('everyone' | 'leaders' | 'reps'), example (demo rows).
 *  - video_views: one row per (video, person): seconds watched, the position to resume from, completed_at (90 %) and
 *    the last report.
 *  - meta `ext:videos:leaders_can_add` ('1' when Matt lets leaders add videos).
 * The nightly backup copies the database only: back up server/data/media yourself (P5's Owner notes).
 * Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_views (
  video_id INTEGER NOT NULL REFERENCES learning_videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watched_s INTEGER NOT NULL DEFAULT 0,
  position_s INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  last_at TEXT,
  PRIMARY KEY (video_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_video_views_user ON video_views(user_id);
`;

export const extension: DbExtension = {
  name: 'videos',
  sql: SQL,
  upgrade: () => [],
};
