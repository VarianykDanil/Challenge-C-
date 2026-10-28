/**
 * Release 1.3 — OWNED BY P5 learning-videos. This package's audit specs, in the shape of lib/auditSpecs.ts
 * (AuditRouteSpec: method, pattern, before, after → AuditDraft[]), registered through ./registry.ts.
 *
 *  POST   /videos            "Added video: “How to speak…” (YouTube link)"
 *  POST   /videos/upload     "Added video: “Monday's team talk” (upload, 312 MB)"
 *  PATCH  /videos/:id        "Updated video “…”: required no → yes" (nothing written when nothing changed)
 *  DELETE /videos/:id        "Deleted video “…”"
 *  POST   /videos/:id/poster "Added a still to video “…”" (the editor's browser, the first time it opens an upload)
 *  PUT    /videos/settings   "Changed learning video settings: leaders can add videos no → yes" (same values: nothing)
 *  POST   /videos/:id/progress  a viewing, not a change: one row only when it makes the video watched for that person
 *                            ("Watched “…”", or "Marked “…” as watched" for a Google Drive link), and one when an
 *                            editor's player gave the video its length ("Set the length of video “…” to 1:04 (from
 *                            Morgan Blake’s player); counted 2 people as watched"); every other report (every 15 s
 *                            while a video plays) writes nothing. PATCH and the still say whom a new length counted.
 * Snapshots use readable values (topic, audience, length "9:58", size "312 MB") and never a file path.
 */
import {
  VIDEO_AUDIENCE_LABELS,
  VIDEO_PROVIDER_LABELS,
  VIDEO_TOPIC_LABELS,
  auditChangeText,
  auditDiff,
  formatVideoLength,
  videoProviderOf,
  type AuditFieldChange,
  type VideoAudience,
  type VideoTopic,
  personName,
} from '@lm/shared';
import { get, type Db } from '../../db/connection.ts';
import { LEADERS_CAN_ADD_META_KEY } from '../../db/extensions/videos.ts';
import type { AuditCall, AuditDone, AuditDraft, AuditRouteSpec } from '../auditSpecs.ts';

type Snap = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const responseId = (done: AuditDone) => (isRecord(done.response) ? toId(done.response.id) : null);
const quoted = (s: Snap | null) => `“${typeof s?.title === 'string' && s.title ? s.title : 'a video'}”`;

/** "312 MB", "1.4 GB". */
export function fileSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}

/** A video as the trail shows it; null when there is no such row. */
export function videoSnapshot(db: Db, id: number): Snap | null {
  const r = get<{ id: number; title: string; description: string; topic: string; kind: string; url: string | null; size: number | null; durationS: number | null; required: number; audience: string; example: number; posterPath: string | null }>(
    db,
    `SELECT id, title, description, topic, kind, url, size, duration_s AS durationS, required, audience, example, poster_path AS posterPath FROM learning_videos WHERE id = ?`,
    [id],
  );
  if (!r) return null;
  const provider = r.kind === 'link' ? videoProviderOf(r.url) : null;
  return {
    id: r.id,
    title: r.title,
    description: r.description || null,
    topic: VIDEO_TOPIC_LABELS[r.topic as VideoTopic] ?? r.topic,
    audience: VIDEO_AUDIENCE_LABELS[r.audience as VideoAudience] ?? r.audience,
    required: r.required === 1,
    source: r.kind === 'link' ? `${provider ? VIDEO_PROVIDER_LABELS[provider] : 'Video'} link` : 'Upload',
    link: r.kind === 'link' ? r.url : null,
    length: r.durationS ? formatVideoLength(Number(r.durationS)) : null,
    fileSize: r.size ? fileSizeText(Number(r.size)) : null,
    ...(r.kind === 'upload' ? { still: r.posterPath !== null } : {}),
    example: r.example === 1,
  };
}

function added(db: Db, done: AuditDone): AuditDraft[] {
  const id = responseId(done);
  const after = id ? videoSnapshot(db, id) : null;
  const how = after ? (after.source === 'Upload' ? `upload${after.fileSize ? `, ${String(after.fileSize)}` : ''}` : String(after.source)) : '';
  return [{ entity: 'video', entityId: id, summary: `Added video: ${quoted(after)}${how ? ` (${how})` : ''}`, before: null, after }];
}

interface Before {
  id: number | null;
  before: Snap | null;
  /** Viewings watched before the call (a length arriving counts the people who had already seen 90% of it). */
  completed: number;
}

/** How many viewings of the video are watched. */
const completedViews = (db: Db, id: number | null): number =>
  id ? Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM video_views WHERE video_id = ? AND completed_at IS NOT NULL`, [id])?.n ?? 0) : 0;

/** "; counted 2 people as watched" (re-review fix: a side effect of a length arriving is on the trail too). */
const countedText = (n: number) => (n > 0 ? `; counted ${n} ${n === 1 ? 'person' : 'people'} as watched` : '');

const loadBefore = (db: Db, call: AuditCall): Before => {
  const id = toId(call.params.id);
  return { id, before: id ? videoSnapshot(db, id) : null, completed: completedViews(db, id) };
};

/** "description, length 10:00 → 9:58": a description is named, never quoted (it can be long). */
function changeText(diff: AuditFieldChange[]): string {
  const described = diff.some((d) => d.field === 'description');
  const rest = auditChangeText(diff.filter((d) => d.field !== 'description'));
  return [described ? 'description' : '', rest].filter(Boolean).join(', ');
}

const leadersCanAdd = (db: Db): boolean => get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [LEADERS_CAN_ADD_META_KEY])?.value === '1';

interface ProgressBefore {
  id: number | null;
  completedAt: string | null;
  /** The video's length before the report (an editor's player may give it one). */
  length: number | null;
  completed: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  { method: 'POST', pattern: '/videos/upload', after: (db, done) => added(db, done) } satisfies AuditRouteSpec<undefined>,
  {
    method: 'PUT',
    pattern: '/videos/settings',
    before: (db) => ({ leadersCanAddVideos: leadersCanAdd(db) }),
    after(_db, done, before: Snap | undefined) {
      const res = isRecord(done.response) ? done.response : {};
      const after: Snap = { leadersCanAddVideos: res.leadersCanAdd === true };
      const diff = auditDiff(before ?? null, after);
      if (before && !diff.length) return [];
      const text = auditChangeText(diff);
      return [{ entity: 'settings', entityId: null, summary: text ? `Changed learning video settings: ${text}` : 'Changed learning video settings', before: before ?? null, after }];
    },
  } satisfies AuditRouteSpec<Snap>,
  { method: 'POST', pattern: '/videos', after: (db, done) => added(db, done) } satisfies AuditRouteSpec<undefined>,
  {
    method: 'PATCH',
    pattern: '/videos/:id',
    before: loadBefore,
    after(db, _done, state: Before | undefined) {
      const id = state?.id ?? null;
      const before = state?.before ?? null;
      const after = id ? videoSnapshot(db, id) : null;
      const diff = auditDiff(before, after);
      if (before && after && !diff.length) return [];
      const text = changeText(diff);
      const name = quoted(after ?? before);
      const counted = countedText(completedViews(db, id) - (state?.completed ?? 0));
      return [{ entity: 'video', entityId: id, summary: `${text ? `Updated video ${name}: ${text}` : `Updated video ${name}`}${counted}`, before, after }];
    },
  } satisfies AuditRouteSpec<Before>,
  {
    method: 'POST',
    pattern: '/videos/:id/poster',
    before: loadBefore,
    after(db, _done, state: Before | undefined) {
      const id = state?.id ?? null;
      const after = id ? videoSnapshot(db, id) : null;
      const before = state?.before ?? null;
      const name = quoted(after ?? before);
      const lengthAdded = !before?.length && after?.length;
      const counted = countedText(completedViews(db, id) - (state?.completed ?? 0));
      return [{ entity: 'video', entityId: id, summary: `${before?.still ? 'Replaced the still of' : 'Added a still to'} video ${name}${lengthAdded ? ` (length ${String(after!.length)})` : ''}${counted}`, before, after }];
    },
  } satisfies AuditRouteSpec<Before>,
  {
    method: 'DELETE',
    pattern: '/videos/:id',
    before: loadBefore,
    after(_db, _done, state: Before | undefined) {
      return [{ entity: 'video', entityId: state?.id ?? null, summary: `Deleted video ${quoted(state?.before ?? null)}`, before: state?.before ?? null, after: null }];
    },
  } satisfies AuditRouteSpec<Before>,
  {
    method: 'POST',
    pattern: '/videos/:id/progress',
    before(db, call): ProgressBefore {
      const id = toId(call.params.id);
      const length = id ? (get<{ d: number | null }>(db, `SELECT duration_s AS d FROM learning_videos WHERE id = ?`, [id])?.d ?? null) : null;
      if (!id || !call.me) return { id, completedAt: null, length, completed: 0 };
      const row = get<{ completedAt: string | null }>(db, `SELECT completed_at AS completedAt FROM video_views WHERE video_id = ? AND user_id = ?`, [id, call.me.id]);
      return { id, completedAt: row?.completedAt ?? null, length, completed: completedViews(db, id) };
    },
    after(db, done, state: ProgressBefore | undefined) {
      const res = isRecord(done.response) ? done.response : {};
      const id = state?.id ?? null;
      if (!id) return [];
      const drafts: AuditDraft[] = [];
      const video = videoSnapshot(db, id);
      const ownNow = !state?.completedAt && typeof res.completedAt === 'string';
      // re-review fix: an editor's player gave the video its length (and so counted the people who had seen 90% of it)
      const lengthNow = get<{ d: number | null }>(db, `SELECT duration_s AS d FROM learning_videos WHERE id = ?`, [id])?.d ?? null;
      if (state && state.length === null && lengthNow !== null) {
        const who = done.me ? personName(done.me) : 'an editor';
        const others = completedViews(db, id) - state.completed - (ownNow ? 1 : 0);
        drafts.push({
          entity: 'video',
          entityId: id,
          summary: `Set the length of video ${quoted(video)} to ${formatVideoLength(Number(lengthNow))} (from ${who}’s player)${countedText(others)}`,
          before: { length: null },
          after: { length: formatVideoLength(Number(lengthNow)) },
        });
      }
      if (!ownNow) return drafts; // still watching, or watched before
      // the route says how it became watched (a "Mark as watched" on a video already seen to 90% is a watch)
      const marked = typeof res.marked === 'boolean' ? res.marked : isRecord(done.body) && done.body.markWatched === true;
      const progress = { watched: formatVideoLength(Number(res.watchedS ?? 0)), length: video?.length ?? null };
      drafts.push({ entity: 'video', entityId: id, summary: marked ? `Marked ${quoted(video)} as watched` : `Watched ${quoted(video)}`, before: null, after: progress });
      return drafts;
    },
  } satisfies AuditRouteSpec<ProgressBefore>,
];
