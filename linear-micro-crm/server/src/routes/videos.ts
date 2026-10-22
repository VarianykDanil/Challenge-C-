/**
 * Release 1.3 — /videos (learning videos: uploads streamed with byte ranges, or YouTube / Vimeo / Drive links, with
 * watch progress) — OWNED BY P5 learning-videos.
 *
 *  GET    /videos                     → LearningVideo[] (the videos the caller's role sees, with their own progress)
 *  GET    /videos/access              → VideoAccess (may the caller add videos? and, if so, the room for an upload)
 *  GET    /videos/settings, PUT …     → VideoSettings (admin)
 *  GET    /videos/team?userId=        → TeamVideoProgress (admin: everyone; leader: own team; ?userId one person) — cached
 *  POST   /videos  VideoLinkInput     → 201 LearningVideo (admin; leaders when allowed)
 *  POST   /videos/upload              → 201 LearningVideo (multipart, busboy streaming, 2 GB cap; same roles)
 *  GET    /videos/:id                 → LearningVideo
 *  GET    /videos/:id/stream          → the file, 200 or 206 byte ranges (private, no-store)
 *  GET    /videos/:id/poster          → the upload's still (JPEG)
 *  POST   /videos/:id/poster  { image: JPEG data URL, durationS? } → LearningVideo (an upload's editors: the browser takes
 *                                       the still — and the length if it is missing — from the stream the first time
 *                                       an editor opens it; the page's CSP lets it read the stream, not a local file)
 *  GET    /videos/:id/views           → VideoViewRow[] (admin)
 *  PATCH  /videos/:id  VideoUpdateInput → LearningVideo (admin; the leader who added it, while leaders may add)
 *  DELETE /videos/:id                 → 204 (same; an upload's files go with it)
 *  POST   /videos/:id/progress  VideoProgressInput → VideoProgress (anyone who sees the video)
 *
 * Who sees what (shared videoAudiencesFor): admins and leaders every audience, reps "everyone" and "reps", recruiters
 * "everyone"; a video outside the caller's audience answers 404, like one that does not exist. A client portal account
 * never gets here (the client guard). Progress is the parts of the video seen, merged (shared mergeWatchedRanges), so
 * a replay counts once and skipping ahead counts nothing; what a report adds is limited by the watch credit (shared
 * watchCreditAt: at most double speed since the last report, on the real clock), so a report cannot claim more than
 * a player could have shown; watched at 90% (isVideoComplete), never taken back. An upload without a length of its
 * own counts as watched only once it has one (lib/videos/progress.ts completeViewsAtLength).
 * Types: shared/src/types/videos.ts. Audit specs: lib/audit/videoSpecs.ts. Files: lib/videos/files.ts.
 */
import { createReadStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  VIDEO_AUDIENCES,
  VIDEO_LIMITS,
  VIDEO_MAX_BYTES,
  VIDEO_TOPICS,
  creditedWatchSeconds,
  isVideoComplete,
  mergeWatchedRanges,
  normaliseVideoUrl,
  normaliseWatchedRanges,
  videoAudiencesFor,
  videoEmbedUrl,
  videoLinkKey,
  videoProviderOf,
  videoRequiredFor,
  videoThumbnailUrl,
  watchCreditAt,
  watchedRangesSeconds,
  type LearningVideo,
  type Role,
  type TeamVideoCell,
  type TeamVideoColumn,
  type TeamVideoProgress,
  type TeamVideoProgressRow,
  type UserWithTeam,
  type VideoAccess,
  type VideoAudience,
  type VideoKind,
  type VideoProgress,
  type VideoSettings,
  type VideoTopic,
  type VideoViewRow,
  type WatchedRange,
} from '@lm/shared';
import { all, get, placeholders, run, type Db } from '../db/connection.ts';
import { LEADERS_CAN_ADD_META_KEY } from '../db/extensions/videos.ts';
import { bumpDataVersion } from '../lib/cache.ts';
import { nowISO } from '../lib/dates.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { idParam } from '../lib/validate.ts';
import {
  diskSpaceAt,
  formatByteSize,
  isJpeg,
  mp4DurationSeconds,
  parseRangeHeader,
  removeStaleUploads,
  removeStoredFile,
  resolveStoredPath,
  storedPathOf,
  uploadRoomBytes,
  videosDirFor,
  videosPathFor,
} from '../lib/videos/files.ts';
import { completeViewsAtLength, progressNowMs, watchCreditLimits } from '../lib/videos/progress.ts';
import { receiveVideoUpload } from '../lib/videos/upload.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

/** A 2 GB upload over a phone hotspot takes far longer than Node's default 5-minute limit on receiving a request. */
export const UPLOAD_REQUEST_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** Multipart framing and the text fields on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 2 * 1024 * 1024;

interface VideoRow {
  id: number;
  title: string;
  description: string;
  topic: VideoTopic;
  kind: VideoKind;
  url: string | null;
  filePath: string | null;
  posterPath: string | null;
  mime: string | null;
  size: number | null;
  durationS: number | null;
  required: number;
  audience: VideoAudience;
  example: number;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  myWatchedS?: number | null;
  myPositionS?: number | null;
  myCompletedAt?: string | null;
  myLastAt?: string | null;
  myMarked?: number | null;
}

const VIDEO_SELECT = `SELECT v.id, v.title, v.description, v.topic, v.kind, v.url, v.file_path AS filePath, v.poster_path AS posterPath,
  v.mime, v.size, v.duration_s AS durationS, v.required, v.audience, v.example, v.created_by AS createdBy,
  CASE WHEN c.id IS NULL THEN NULL ELSE c.first_name || ' ' || c.last_name END AS createdByName, v.created_at AS createdAt`;

const MY_SELECT = `, my.watched_s AS myWatchedS, my.position_s AS myPositionS, my.completed_at AS myCompletedAt, my.last_at AS myLastAt,
  my.marked AS myMarked
  FROM learning_videos v LEFT JOIN users c ON c.id = v.created_by
  LEFT JOIN video_views my ON my.video_id = v.id AND my.user_id = ?`;

const bool = (v: unknown) => v === 1 || v === true || v === '1';

/** Whole seconds of a length, or null. */
const durationSchema = z.number().finite().int('Give the length in whole seconds').min(1).max(VIDEO_LIMITS.durationMaxS);

const titleSchema = z.string({ required_error: 'Give the video a title' }).trim().min(1, 'Give the video a title').max(VIDEO_LIMITS.titleMax);
const descriptionSchema = z.string().trim().max(VIDEO_LIMITS.descriptionMax);
const topicSchema = z.enum(VIDEO_TOPICS as [VideoTopic, ...VideoTopic[]], { errorMap: () => ({ message: 'Pick a topic' }) });
const audienceSchema = z.enum(VIDEO_AUDIENCES as [VideoAudience, ...VideoAudience[]], { errorMap: () => ({ message: 'Pick who it is for' }) });

const linkSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.default(''),
  topic: topicSchema,
  url: z.string({ required_error: 'Paste the link' }).trim().min(1, 'Paste the link').max(VIDEO_LIMITS.urlMax),
  required: z.boolean().default(false),
  audience: audienceSchema.default('everyone'),
  durationS: durationSchema.nullable().optional(),
});

const updateSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    topic: topicSchema.optional(),
    required: z.boolean().optional(),
    audience: audienceSchema.optional(),
    durationS: durationSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

/** The text fields of the multipart upload (every value arrives as a string). */
const uploadFieldsSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.default(''),
  topic: topicSchema,
  audience: audienceSchema.default('everyone'),
  required: z.enum(['true', 'false', '1', '0', 'on', '']).default('false').transform((v) => v === 'true' || v === '1' || v === 'on'),
  durationS: z
    .string()
    .regex(/^\d{0,6}$/, 'Give the length in whole seconds')
    .default('')
    .transform((v) => (v ? Number(v) : null))
    .refine((v) => v === null || (v >= 1 && v <= VIDEO_LIMITS.durationMaxS), 'That length is not possible'),
});

const seconds = z.number().finite().min(0).max(VIDEO_LIMITS.durationMaxS);
const progressSchema = z.object({
  watchedS: seconds,
  positionS: seconds.optional(),
  ended: z.boolean().optional(),
  ranges: z.array(z.tuple([seconds, seconds])).max(VIDEO_LIMITS.rangesPerReport).optional(),
  durationS: z.number().finite().positive().max(VIDEO_LIMITS.durationMaxS).optional(),
  markWatched: z.boolean().optional(),
});

const JPEG_DATA_URL = 'data:image/jpeg;base64,';
const posterSchema = z
  .object({
    image: z
      .string({ required_error: 'Send the still' })
      .max(VIDEO_LIMITS.posterDataUrlMaxChars, 'The still is too big: up to 600 KB')
      .refine((v) => v.startsWith(JPEG_DATA_URL) && /^[A-Za-z0-9+/]+={0,2}$/.test(v.slice(JPEG_DATA_URL.length)), 'Send the still as a JPEG data URL'),
    durationS: z.number().finite().positive().max(VIDEO_LIMITS.durationMaxS).optional(),
  })
  .strict();

const settingsSchema = z.object({ leadersCanAdd: z.boolean({ required_error: 'Say whether leaders may add videos' }) }).strict();

interface Person {
  id: number;
  name: string;
  role: Role;
  teamId: number | null;
  teamName: string | null;
  avatarColor: string;
}

const PERSON_SELECT = `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.role, u.team_id AS teamId, t.name AS teamName,
  u.avatar_color AS avatarColor FROM users u LEFT JOIN teams t ON t.id = u.team_id`;

function parseStoredRanges(text: string | null | undefined): WatchedRange[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? normaliseWatchedRanges(v as [number, number][]) : [];
  } catch {
    return [];
  }
}

/** Uploads in flight per HTTP server, and the request limit it had before the first of them. */
const longUploads = new WeakMap<http.Server, { active: number; before: number }>();

/**
 * Lets an upload take as long as 2 GB over a hotspot needs: Node's http server ends any request still arriving after
 * `requestTimeout` (5 minutes by default), a setting of the whole server. It is raised to 3 hours while at least one
 * upload is arriving and put back as it was once the last one has finished, so every other request keeps the usual
 * limit the rest of the time.
 */
function allowLongUpload(req: Request, res: Response): void {
  const server = (req.socket as { server?: http.Server }).server;
  if (!server || typeof server.requestTimeout !== 'number') return;
  let state = longUploads.get(server);
  if (!state) {
    state = { active: 0, before: server.requestTimeout };
    longUploads.set(server, state);
  }
  if (state.active === 0) state.before = server.requestTimeout;
  state.active++;
  if (server.requestTimeout > 0 && server.requestTimeout < UPLOAD_REQUEST_TIMEOUT_MS) server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
  const s = state;
  let released = false;
  res.on('close', () => {
    if (released) return;
    released = true;
    s.active--;
    // put back only what this code set (someone else may have changed it since)
    if (s.active === 0 && server.requestTimeout === UPLOAD_REQUEST_TIMEOUT_MS && s.before !== UPLOAD_REQUEST_TIMEOUT_MS) server.requestTimeout = s.before;
  });
}

export function videosRouter(db: Db): Router {
  const router = Router();
  // unfinished uploads a stopped server left behind (nothing to do, and nothing created, while there is no folder yet)
  try {
    removeStaleUploads(videosPathFor(db));
  } catch (err) {
    console.error('Learning videos: could not tidy unfinished uploads', err);
  }

  const leadersCanAdd = (): boolean => get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [LEADERS_CAN_ADD_META_KEY])?.value === '1';
  const canAdd = (me: UserWithTeam): boolean => me.role === 'admin' || (me.role === 'leader' && leadersCanAdd());
  const canEdit = (me: UserWithTeam, v: Pick<VideoRow, 'createdBy'>, leadersMay = leadersCanAdd()): boolean =>
    me.role === 'admin' || (me.role === 'leader' && leadersMay && v.createdBy === me.id);

  const assertCanAdd = (me: UserWithTeam) => {
    if (canAdd(me)) return;
    throw forbidden(
      me.role === 'leader'
        ? 'Only administrators can add videos. An administrator can let leaders add them in Settings → Learning videos.'
        : 'Only administrators can add videos',
    );
  };

  const toVideo = (r: VideoRow, me: UserWithTeam, leadersMay: boolean): LearningVideo => {
    const isLink = r.kind === 'link';
    const v: LearningVideo = {
      id: r.id,
      title: r.title,
      description: r.description,
      topic: r.topic,
      kind: r.kind,
      url: isLink ? r.url : null,
      embedUrl: isLink && r.url ? videoEmbedUrl(r.url) : null,
      streamUrl: isLink ? null : `/api/videos/${r.id}/stream`,
      mime: r.mime,
      size: r.size === null ? null : Number(r.size),
      durationS: r.durationS === null ? null : Number(r.durationS),
      required: bool(r.required),
      audience: r.audience,
      createdBy: r.createdBy,
      createdByName: r.createdByName,
      createdAt: r.createdAt,
      example: bool(r.example),
      provider: isLink ? videoProviderOf(r.url) : null,
      thumbnailUrl: isLink ? videoThumbnailUrl(r.url) : r.posterPath ? `/api/videos/${r.id}/poster` : null,
      canEdit: canEdit(me, r, leadersMay),
    };
    if (r.myLastAt !== undefined) {
      v.my =
        r.myLastAt === null && r.myCompletedAt === null && r.myWatchedS === null
          ? null
          : {
              videoId: r.id,
              watchedS: Number(r.myWatchedS ?? 0),
              positionS: Number(r.myPositionS ?? 0),
              completedAt: r.myCompletedAt ?? null,
              lastAt: r.myLastAt ?? null,
              marked: Boolean(r.myCompletedAt) && bool(r.myMarked),
            };
    }
    return v;
  };

  /** A video the caller's role sees (with their progress), else 404 — the same answer as a video that does not exist. */
  const visibleRow = (me: UserWithTeam, id: number): VideoRow => {
    const audiences = videoAudiencesFor(me.role);
    const row = audiences.length
      ? get<VideoRow>(db, `${VIDEO_SELECT}${MY_SELECT} WHERE v.id = ? AND v.audience IN (${placeholders(audiences.length)})`, [me.id, id, ...audiences])
      : undefined;
    if (!row) throw notFound('Video');
    return row;
  };

  const loadVideo = (me: UserWithTeam, id: number): LearningVideo => toVideo(visibleRow(me, id), me, leadersCanAdd());

  const editableRow = (me: UserWithTeam, id: number): VideoRow => {
    const row = visibleRow(me, id);
    if (!canEdit(me, row)) {
      throw forbidden(me.role === 'leader' ? 'You can change only the videos you added' : 'Only administrators can change videos');
    }
    return row;
  };

  const settingsBody = (): VideoSettings => {
    const s = get<{ n: number; bytes: number | null }>(db, `SELECT COUNT(*) AS n, SUM(size) AS bytes FROM learning_videos WHERE kind = 'upload'`)!;
    return {
      leadersCanAdd: leadersCanAdd(),
      storage: { uploads: Number(s.n), bytes: Number(s.bytes ?? 0), folder: videosPathFor(db) },
    };
  };

  // ── reads ──

  router.get('/', (req, res) => {
    const me = currentUser(req);
    const audiences = videoAudiencesFor(me.role);
    const rows = audiences.length
      ? all<VideoRow>(db, `${VIDEO_SELECT}${MY_SELECT} WHERE v.audience IN (${placeholders(audiences.length)}) ORDER BY v.created_at DESC, v.id DESC`, [me.id, ...audiences])
      : [];
    const leadersMay = leadersCanAdd();
    const body: LearningVideo[] = rows.map((r) => toVideo(r, me, leadersMay));
    res.json(body);
  });

  router.get('/access', (req, res) => {
    const may = canAdd(currentUser(req));
    const space = may ? diskSpaceAt(videosPathFor(db)) : null;
    const body: VideoAccess = may ? { canAdd: true, uploadRoomBytes: space ? uploadRoomBytes(space) : null } : { canAdd: false };
    res.json(body);
  });

  router.get('/settings', requireRole('admin'), (_req, res) => {
    res.json(settingsBody());
  });

  router.put('/settings', requireRole('admin'), (req, res) => {
    const { leadersCanAdd: on } = settingsSchema.parse(req.body);
    run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [LEADERS_CAN_ADD_META_KEY, on ? '1' : '0']);
    res.json(settingsBody());
  });

  router.get('/team', requireRole('admin', 'leader'), (req, res) => {
    const me = currentUser(req);
    const raw = req.query.userId;
    let only: number | null = null;
    if (raw !== undefined && raw !== '') {
      only = Number(raw);
      if (!Number.isInteger(only) || only <= 0) throw badRequest('Invalid userId');
    }
    const required = all<{ id: number; title: string; durationS: number | null; audience: VideoAudience; topic: VideoTopic; required: number }>(
      db,
      `SELECT id, title, duration_s AS durationS, audience, topic, required FROM learning_videos ORDER BY created_at DESC, id DESC`,
    );
    const videos: TeamVideoColumn[] = required
      .filter((v) => bool(v.required))
      .map((v) => ({ id: v.id, title: v.title, durationS: v.durationS === null ? null : Number(v.durationS), audience: v.audience, topic: v.topic }));
    const audienceOf = new Map(required.map((v) => [v.id, v.audience]));

    // the people: one person (in scope), a leader's own team, or (admin) every active member of staff
    let people: Person[];
    if (only !== null) {
      const p = get<Person>(db, `${PERSON_SELECT} WHERE u.id = ? AND u.role <> 'client'`, [only]);
      if (!p) throw notFound('Person');
      if (me.role === 'leader' && p.id !== me.id && (me.teamId === null || p.teamId !== me.teamId)) {
        throw forbidden('You can only see the videos of your own team');
      }
      people = [p];
    } else if (me.role === 'leader' && me.teamId === null) {
      people = [];
    } else {
      const scoped = me.role === 'admin' ? '' : 'AND u.team_id = ?';
      people = all<Person>(
        db,
        `${PERSON_SELECT} WHERE u.status = 'active' AND u.role <> 'client' ${scoped} ORDER BY (t.name IS NULL), t.name, u.first_name, u.last_name`,
        me.role === 'admin' ? [] : [me.teamId],
      );
    }
    const ids = people.map((p) => p.id);
    const views = ids.length
      ? all<{ userId: number; videoId: number; watchedS: number; completedAt: string | null }>(
          db,
          `SELECT user_id AS userId, video_id AS videoId, watched_s AS watchedS, completed_at AS completedAt FROM video_views
            WHERE user_id IN (${placeholders(ids.length)})`,
          ids,
        )
      : [];
    const byUser = new Map<number, Map<number, { watchedS: number; completedAt: string | null }>>();
    for (const v of views) {
      if (!byUser.has(v.userId)) byUser.set(v.userId, new Map());
      byUser.get(v.userId)!.set(v.videoId, { watchedS: Number(v.watchedS), completedAt: v.completedAt });
    }
    const rows: TeamVideoProgressRow[] = people.map((p) => {
      const mine = byUser.get(p.id) ?? new Map();
      const sees = new Set(videoAudiencesFor(p.role));
      const cells: TeamVideoCell[] = videos
        .filter((v) => videoRequiredFor({ required: true, audience: v.audience }, p.role))
        .map((v) => ({ videoId: v.id, watchedS: mine.get(v.id)?.watchedS ?? 0, completedAt: mine.get(v.id)?.completedAt ?? null }));
      let watched = 0;
      for (const [videoId, view] of mine) {
        const audience = audienceOf.get(videoId);
        if (view.completedAt && audience && sees.has(audience)) watched++;
      }
      return {
        userId: p.id,
        userName: p.name,
        watchedRequired: cells.filter((c) => c.completedAt).length,
        watched,
        requiredTotal: cells.length,
        avatarColor: p.avatarColor,
        teamName: p.teamName,
        cells,
      };
    });
    const body: TeamVideoProgress = { required: videos.length, rows, videos };
    res.json(body);
  });

  // ── adding ──

  router.post('/', (req, res) => {
    const me = currentUser(req);
    assertCanAdd(me);
    const input = linkSchema.parse(req.body);
    const key = videoLinkKey(input.url);
    const url = normaliseVideoUrl(input.url);
    if (!key || !url) throw badRequest('Paste a YouTube, Vimeo or Google Drive link to the video', [{ path: 'url', message: 'Not a YouTube, Vimeo or Google Drive video link' }]);
    const same = all<{ title: string; url: string }>(db, `SELECT title, url FROM learning_videos WHERE kind = 'link' AND url IS NOT NULL`).find((v) => videoLinkKey(v.url) === key);
    if (same) throw conflict(`This video is already in Learning as “${same.title}”`);
    const id = run(
      db,
      `INSERT INTO learning_videos (title, description, topic, kind, url, duration_s, required, audience, example, created_by, created_at)
       VALUES (?, ?, ?, 'link', ?, ?, ?, ?, 0, ?, ?)`,
      [input.title, input.description, input.topic, url, input.durationS ?? null, input.required, input.audience, me.id, nowISO()],
    ).lastInsertRowid;
    res.status(201).json(loadVideo(me, id));
  });

  router.post('/upload', async (req, res) => {
    const me = currentUser(req);
    assertCanAdd(me);
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] ?? '')) {
      throw badRequest('Send the video as multipart/form-data: the fields, then the file');
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > VIDEO_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
      res.setHeader('Connection', 'close');
      throw new HttpError(413, 'Videos can be up to 2 GB');
    }
    const dir = videosDirFor(db);
    // Room on the disk first (a cloud volume is often 1 GB, with the database and its backups on it): refused before
    // the file is read, rather than filling the disk until the database cannot write.
    const space = diskSpaceAt(dir);
    if (space) {
      const room = uploadRoomBytes(space);
      const size = Number.isFinite(declared) && declared > 0 ? declared : 0;
      if (size > room || room === 0) {
        res.setHeader('Connection', 'close');
        throw new HttpError(
          507,
          size > 0 && room > 0
            ? `The server has room for ${formatByteSize(room)} more and this video is ${formatByteSize(size)}. Free some disk space on the server, or add the video as a YouTube, Vimeo or Google Drive link.`
            : 'The server is almost out of disk space. Free some disk space on the server, or add the video as a YouTube, Vimeo or Google Drive link.',
        );
      }
    }
    allowLongUpload(req, res);
    let fields: z.infer<typeof uploadFieldsSchema> | null = null;
    let received;
    try {
      received = await receiveVideoUpload(req, dir, {
        onVideoStart: (f) => {
          fields = uploadFieldsSchema.parse({ ...f });
        },
      });
    } catch (err) {
      // a refused upload may still be arriving: close the connection rather than read the rest of it
      res.setHeader('Connection', 'close');
      throw err;
    }
    const { video, poster } = received;
    let finalName: string | null = null;
    let posterName: string | null = null;
    try {
      const f = fields ?? uploadFieldsSchema.parse({ ...received.fields });
      finalName = `${video.uuid}.${video.ext}`;
      renameSync(video.tmpPath, path.join(dir, finalName));
      if (poster) {
        posterName = `${video.uuid}.jpg`;
        writeFileSync(path.join(dir, posterName), poster);
      }
      // the file's own length first (MP4 / MOV), else the one the browser read from it
      const own = video.ext === 'webm' ? null : mp4DurationSeconds(path.join(dir, finalName));
      const durationS = own !== null && own > 0 && own <= VIDEO_LIMITS.durationMaxS ? own : f.durationS;
      const id = run(
        db,
        `INSERT INTO learning_videos (title, description, topic, kind, file_path, poster_path, mime, size, duration_s, required, audience, example, created_by, created_at)
         VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [f.title, f.description, f.topic, storedPathOf(finalName), posterName ? storedPathOf(posterName) : null, video.mime, video.size, durationS, f.required, f.audience, me.id, nowISO()],
      ).lastInsertRowid;
      res.status(201).json(loadVideo(me, id));
    } catch (err) {
      rmSync(video.tmpPath, { force: true });
      if (finalName) rmSync(path.join(dir, finalName), { force: true });
      if (posterName) rmSync(path.join(dir, posterName), { force: true });
      throw err;
    }
  });

  // ── one video ──

  router.get('/:id', (req, res) => {
    res.json(loadVideo(currentUser(req), idParam(req)));
  });

  router.get('/:id/stream', (req, res, next) => {
    const me = currentUser(req);
    const v = visibleRow(me, idParam(req));
    if (v.kind !== 'upload') throw notFound('Video file');
    const file = resolveStoredPath(db, v.filePath);
    if (!file || !existsSync(file)) {
      throw new HttpError(404, 'The video file is missing on the server: restore the media folder from your backup, or upload the video again');
    }
    const stat = statSync(file);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    // If-Range with another validator: the file changed, send all of it
    const ifRange = req.headers['if-range'];
    const range = ifRange && ifRange !== etag ? ({ kind: 'full' } as const) : parseRangeHeader(req.headers.range, stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', v.mime ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    if (range.kind === 'unsatisfiable') {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
      res.end();
      return;
    }
    const start = range.kind === 'partial' ? range.start : 0;
    const end = range.kind === 'partial' ? range.end : stat.size - 1;
    if (range.kind === 'partial') {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    } else res.status(200);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD' || stat.size === 0) {
      res.end();
      return;
    }
    sendFileRange(res, file, start, end, next);
  });

  router.get('/:id/poster', (req, res) => {
    const v = visibleRow(currentUser(req), idParam(req));
    const file = resolveStoredPath(db, v.posterPath);
    if (!file || !existsSync(file)) throw notFound('Picture');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('image/jpeg').send(readFileSync(file));
  });

  router.post('/:id/poster', (req, res) => {
    const me = currentUser(req);
    const row = editableRow(me, idParam(req));
    if (row.kind !== 'upload' || !row.filePath) throw badRequest('Only an uploaded video has a still of its own');
    const input = posterSchema.parse(req.body);
    const bytes = Buffer.from(input.image.slice(JPEG_DATA_URL.length), 'base64');
    if (!isJpeg(bytes) || bytes.length > VIDEO_LIMITS.posterMaxBytes) throw badRequest('Send the still as a JPEG of up to 600 KB');
    // next to the video, under the same name: videos/<uuid>.mp4 → videos/<uuid>.jpg
    const name = `${path.basename(row.filePath).replace(/\.[a-z0-9]+$/i, '')}.jpg`;
    writeFileSync(path.join(videosDirFor(db), name), bytes);
    const length = input.durationS !== undefined ? Math.round(input.durationS) : null;
    const fills = row.durationS === null && length !== null && length >= 1;
    run(db, `UPDATE learning_videos SET poster_path = ?, duration_s = COALESCE(duration_s, ?) WHERE id = ?`, [storedPathOf(name), fills ? length : null, row.id]);
    // the length is known now: whoever has already seen 90% of it has watched it
    if (fills && completeViewsAtLength(db, row.id, length, nowISO())) bumpDataVersion();
    res.json(loadVideo(me, row.id));
  });

  router.get('/:id/views', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const v = visibleRow(me, idParam(req));
    const rows = all<{ userId: number; userName: string; avatarColor: string; teamName: string | null; watchedS: number; positionS: number; completedAt: string | null; lastAt: string | null; marked: number }>(
      db,
      `SELECT vv.user_id AS userId, u.first_name || ' ' || u.last_name AS userName, u.avatar_color AS avatarColor, t.name AS teamName,
              vv.watched_s AS watchedS, vv.position_s AS positionS, vv.completed_at AS completedAt, vv.last_at AS lastAt,
              vv.marked AS marked
         FROM video_views vv JOIN users u ON u.id = vv.user_id LEFT JOIN teams t ON t.id = u.team_id
        WHERE vv.video_id = ? AND u.role <> 'client'
        ORDER BY (vv.completed_at IS NULL), vv.completed_at DESC, vv.last_at DESC, u.first_name, u.last_name`,
      [v.id],
    );
    const body: VideoViewRow[] = rows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      watchedS: Number(r.watchedS),
      completedAt: r.completedAt,
      lastAt: r.lastAt,
      positionS: Number(r.positionS),
      avatarColor: r.avatarColor,
      teamName: r.teamName,
      // stored when it happened ("Mark as watched"), so a length changed later never turns a real watch into "Marked"
      marked: Boolean(r.completedAt) && bool(r.marked),
    }));
    res.json(body);
  });

  router.patch('/:id', (req, res) => {
    const me = currentUser(req);
    const row = editableRow(me, idParam(req));
    const input = updateSchema.parse(req.body);
    const sets: string[] = [];
    const params: (string | number | boolean | null)[] = [];
    const set = (column: string, value: string | number | boolean | null | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      params.push(value);
    };
    set('title', input.title);
    set('description', input.description);
    set('topic', input.topic);
    set('required', input.required);
    set('audience', input.audience);
    set('duration_s', input.durationS);
    run(db, `UPDATE learning_videos SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);
    // a new length: whoever has already seen 90% of it has watched it (a watched video is never taken back)
    if (typeof input.durationS === 'number') completeViewsAtLength(db, row.id, input.durationS, nowISO());
    res.json(loadVideo(me, row.id));
  });

  router.delete('/:id', (req, res) => {
    const me = currentUser(req);
    const row = editableRow(me, idParam(req));
    run(db, `DELETE FROM learning_videos WHERE id = ?`, [row.id]);
    // the files go once the row has (a stream already open keeps reading until it ends)
    removeStoredFile(db, row.filePath);
    removeStoredFile(db, row.posterPath);
    res.status(204).end();
  });

  router.post('/:id/progress', (req, res) => {
    const me = currentUser(req);
    const v = visibleRow(me, idParam(req));
    const input = progressSchema.parse(req.body);
    const upload = v.kind === 'upload';
    if (input.markWatched && upload) {
      throw badRequest('An uploaded video counts as watched once you have seen 90% of it');
    }
    const now = nowISO();
    // A video with no length of its own takes the one its player reports, from someone who may edit it (so nobody
    // else can shorten everyone's video). From anyone else the reported length only limits their own ranges, and
    // decides their own "watched" for a link only: an upload without a length of its own counts as watched once it has
    // one (then everyone who has already seen 90% of it is counted: completeViewsAtLength).
    let ownLength = v.durationS === null ? null : Number(v.durationS);
    const reported = input.durationS !== undefined && Math.round(input.durationS) >= 1 ? Math.round(input.durationS) : null;
    let filledLength = false;
    if (ownLength === null && reported !== null && canEdit(me, v)) {
      filledLength = run(db, `UPDATE learning_videos SET duration_s = ? WHERE id = ? AND duration_s IS NULL`, [reported, v.id]).changes > 0;
      ownLength = reported;
    }
    const length = ownLength ?? (upload ? null : reported);
    const cap = ownLength ?? reported ?? VIDEO_LIMITS.durationMaxS;
    const prev = get<{ watchedS: number; positionS: number; completedAt: string | null; ranges: string | null; marked: number; creditS: number | null; creditAt: number | null }>(
      db,
      `SELECT watched_s AS watchedS, position_s AS positionS, completed_at AS completedAt, ranges, marked, credit_s AS creditS, credit_at AS creditAt
         FROM video_views WHERE video_id = ? AND user_id = ?`,
      [v.id, me.id],
    );
    const before = Number(prev?.watchedS ?? 0);
    let ranges = parseStoredRanges(prev?.ranges);
    // what the player says has been seen in all: the merged ranges; a bare count only for a link (an upload's player
    // always sends the parts it showed, so a count alone adds nothing)
    let claimed = before;
    if (input.ranges) {
      ranges = mergeWatchedRanges(ranges, input.ranges, cap);
      claimed = watchedRangesSeconds(ranges);
    } else if (!upload) {
      claimed = Math.round(input.watchedS);
    }
    // counted at most as fast as a player at double speed could have shown it since the last report (the rest stays
    // in the ranges and counts as the credit refills)
    const limits = watchCreditLimits();
    const nowMs = progressNowMs();
    const available = watchCreditAt(prev?.creditAt == null ? null : { creditS: Number(prev.creditS ?? 0), atMs: Number(prev.creditAt) }, nowMs, limits.rate, limits.maxS);
    const credited = creditedWatchSeconds(before, Math.min(claimed, cap), available);
    const watched = Math.min(credited.watchedS, cap);
    const position = input.ended ? 0 : Math.min(cap, Math.round(input.positionS ?? Number(prev?.positionS ?? 0)));
    let completedAt = prev?.completedAt ?? null;
    let marked = Boolean(completedAt) && bool(prev?.marked);
    if (!completedAt) {
      const byWatching = isVideoComplete(watched, length);
      if (byWatching || input.markWatched) {
        completedAt = now;
        marked = !byWatching;
      }
    }
    run(
      db,
      `INSERT INTO video_views (video_id, user_id, watched_s, position_s, completed_at, last_at, ranges, marked, credit_s, credit_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id, user_id) DO UPDATE SET watched_s = excluded.watched_s, position_s = excluded.position_s,
         completed_at = COALESCE(video_views.completed_at, excluded.completed_at),
         marked = CASE WHEN video_views.completed_at IS NULL THEN excluded.marked ELSE video_views.marked END,
         last_at = excluded.last_at, ranges = excluded.ranges, credit_s = excluded.credit_s, credit_at = excluded.credit_at`,
      [v.id, me.id, watched, position, completedAt, now, ranges.length ? JSON.stringify(ranges) : null, marked ? 1 : 0, credited.creditS, nowMs],
    );
    // the editor's player gave the video its length: everyone else who has already seen 90% of it has watched it
    const othersDone = filledLength && ownLength !== null ? completeViewsAtLength(db, v.id, ownLength, now) : 0;
    // A report that makes a video watched changes what the cached team view shows: it clears the cache itself, so the
    // reports in between need not (see lib/videos/progress.ts isVideoProgressReport).
    if ((completedAt && !prev?.completedAt) || othersDone > 0) bumpDataVersion();
    const body: VideoProgress = { videoId: v.id, watchedS: watched, positionS: position, completedAt, lastAt: now, marked };
    res.json(body);
  });

  return router;
}

/** Streams bytes start–end (inclusive) of a file; a read error after the headers went out ends the connection. */
function sendFileRange(res: Response, file: string, start: number, end: number, next: (err?: unknown) => void): void {
  const stream = createReadStream(file, { start, end });
  stream.on('error', (err) => {
    if (!res.headersSent) next(err);
    else res.destroy(err);
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
