/**
 * Release 1.3 — P5 learning-videos contracts (laid down by r3-foundation; OWNED BY P5, which may add fields and types).
 *
 * Owner's decision 5 (quote): "Learning: Matt wants VIDEOS (recorded interviews, talks) people watch as part of
 * learning." Lead decision: upload to the server (mp4/webm/mov, up to 2 GB, streamed with byte ranges) OR a link
 * (YouTube, Vimeo, Google Drive). Optional "required" flag adds the video to everyone's Learning checklist.
 *
 * Endpoints (server/src/routes/videos.ts, mounted at /videos, owned by P5):
 *  - GET    /videos                      → LearningVideo[] (the caller's audience; with `my` progress)
 *  - GET    /videos/access               → VideoAccess (may the caller add videos?)
 *  - GET    /videos/:id                  → LearningVideo
 *  - GET    /videos/:id/stream           → the file with HTTP Range (206); auth required; Cache-Control: private, no-store
 *  - GET    /videos/:id/poster           → the upload's still (JPEG), when one was sent with it
 *  - POST   /videos  VideoLinkInput      → 201 LearningVideo (admin; leaders when allowed in settings)
 *  - POST   /videos/upload               → 201 LearningVideo (multipart, busboy streaming; same roles; VIDEO_UPLOAD_FIELDS)
 *  - PATCH  /videos/:id  VideoUpdateInput → LearningVideo (admin; a leader the videos they added, while allowed)
 *  - DELETE /videos/:id                  → 204 (same; an upload's file goes with it)
 *  - POST   /videos/:id/progress  VideoProgressInput → VideoProgress (every 15 s and on pause / end)
 *  - GET    /videos/:id/views            → VideoViewRow[] (admin: who watched)
 *  - GET    /videos/team?userId=         → TeamVideoProgress (leader: own team; admin: everyone; ?userId one person) — cached
 *  - GET    /videos/settings, PUT /videos/settings VideoSettings (admin)
 * Files: <data dir>/media/videos/<uuid>.<ext> (server/data/media by default; git-ignored; the nightly DB backup does
 * not copy media). Tables (server/src/db/extensions/videos.ts): learning_videos, video_views; meta
 * `ext:videos:leaders_can_add`.
 */

export type VideoKind = 'upload' | 'link';
export type VideoTopic = 'interviews' | 'pitching' | 'objections' | 'leadership' | 'other';
export const VIDEO_TOPICS: readonly VideoTopic[] = ['interviews', 'pitching', 'objections', 'leadership', 'other'];
export type VideoAudience = 'everyone' | 'leaders' | 'reps';
/** P5: the audiences in form order. */
export const VIDEO_AUDIENCES: readonly VideoAudience[] = ['everyone', 'leaders', 'reps'];
/** P5: where a link video plays from. */
export type VideoProvider = 'youtube' | 'vimeo' | 'drive';

/** 2 GB. */
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
/** P5: one of VIDEO_MIME_TYPES. */
export type VideoMime = (typeof VIDEO_MIME_TYPES)[number];
/** P5: the file extensions an upload may have, and the type each is stored and streamed as. */
export const VIDEO_FILE_EXTENSIONS: Readonly<Record<'mp4' | 'webm' | 'mov', VideoMime>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
/** A video counts as watched at 90 % of its length. */
export const VIDEO_COMPLETE_SHARE = 0.9;
/** The player reports progress every 15 seconds (and on pause and at the end). */
export const VIDEO_PROGRESS_INTERVAL_S = 15;

/** P5: input limits (the server enforces them; the forms show them). */
export const VIDEO_LIMITS = {
  titleMax: 120,
  descriptionMax: 2000,
  urlMax: 500,
  /** Six hours: the longest length a video may have. */
  durationMaxS: 6 * 60 * 60,
  /**
   * The still of an upload (a JPEG the browser takes from the video): 600 KB, so as a base64 data URL (about 820,000
   * characters) it fits the app's 1 MB JSON body limit (POST /videos/:id/poster). A 640 px frame is 30–90 KB.
   */
  posterMaxBytes: 600 * 1024,
  /** The longest `image` data URL POST /videos/:id/poster accepts ("data:image/jpeg;base64," + the base64 of 600 KB). */
  posterDataUrlMaxChars: 23 + Math.ceil((600 * 1024) / 3) * 4,
  /** Watched ranges sent in one progress report. */
  rangesPerReport: 200,
  /** Watched ranges kept per person and video (closer ones are joined beyond this). */
  rangesKept: 500,
} as const;

/**
 * P5: the multipart fields of POST /videos/upload, in the order the client sends them: the text fields, then the
 * optional `poster` file (image/jpeg), then the `video` file last. Booleans are "true" / "false"; `durationS` whole
 * seconds (the browser reads it from the file; the server reads an MP4 / MOV's own length first).
 */
export const VIDEO_UPLOAD_FIELDS = ['title', 'description', 'topic', 'audience', 'required', 'durationS', 'poster', 'video'] as const;

/** P5: a stretch of the video someone has seen, [from, to] in seconds of the video (not of the clock). */
export type WatchedRange = [number, number];

export interface VideoProgress {
  videoId: number;
  /** Seconds of the video seen (each part counted once, however often it was replayed). */
  watchedS: number;
  /** Where to resume. */
  positionS: number;
  completedAt: string | null;
  lastAt: string | null;
  /** P5: counted as watched by "Mark as watched" (a link whose player cannot report), not by seeing 90 % of it. */
  marked?: boolean;
}

export interface LearningVideo {
  id: number;
  title: string;
  description: string;
  topic: VideoTopic;
  kind: VideoKind;
  /** Link videos: the URL as entered. */
  url: string | null;
  /** Link videos: the YouTube / Vimeo / Drive embed URL (shared logic videoEmbedUrl). */
  embedUrl: string | null;
  /** Uploads: /api/videos/:id/stream. */
  streamUrl: string | null;
  mime: string | null;
  size: number | null;
  durationS: number | null;
  required: boolean;
  audience: VideoAudience;
  createdBy: number | null;
  createdByName?: string | null;
  createdAt: string;
  /** Demo rows are marked so the page can say "Example". */
  example?: boolean;
  /** The caller's own progress. */
  my?: VideoProgress | null;
  /** P5: link videos: YouTube, Vimeo or Google Drive. */
  provider?: VideoProvider | null;
  /** P5: a still to show on the card: the upload's poster (/api/videos/:id/poster) or YouTube's thumbnail. */
  thumbnailUrl?: string | null;
  /** P5: the caller may edit and delete it (admins; the leader who added it while leaders may add videos). */
  canEdit?: boolean;
}

export interface VideoLinkInput {
  title: string;
  description?: string;
  topic: VideoTopic;
  url: string;
  required?: boolean;
  audience?: VideoAudience;
  durationS?: number | null;
}

export type VideoUpdateInput = Partial<Omit<VideoLinkInput, 'url'>>;

export interface VideoProgressInput {
  /**
   * Seconds seen by this player. Used only when `ranges` is not sent, and only for a link (the server then keeps the
   * larger of this and what it had); with `ranges` the server counts the merged ranges instead. Either way what a
   * report adds is limited by the watch credit (shared watchCreditAt: at most double speed since the last report).
   */
  watchedS: number;
  positionS?: number;
  ended?: boolean;
  /** P5: the parts seen since the page opened; the server merges them with the parts seen before. */
  ranges?: WatchedRange[];
  /**
   * P5: the length the player reports, used while the video has no length of its own: from someone who may edit the
   * video it becomes the video's length; from anyone else it limits their own ranges and, for a link only, decides
   * their own "watched" (an upload without a length of its own counts as watched once it has one).
   */
  durationS?: number;
  /** P5: link videos only — "Mark as watched" where the player cannot report progress (Google Drive). */
  markWatched?: boolean;
}

export interface VideoViewRow {
  userId: number;
  userName: string;
  watchedS: number;
  completedAt: string | null;
  lastAt: string | null;
  /** P5 additions for the admin's "Who watched" list. */
  positionS?: number;
  avatarColor?: string;
  teamName?: string | null;
  /** Counted as watched by "Mark as watched" rather than by the player reaching 90 % (stored when it happened). */
  marked?: boolean;
}

/** P5: one required video, a column of the team view. */
export interface TeamVideoColumn {
  id: number;
  title: string;
  durationS: number | null;
  audience: VideoAudience;
  topic: VideoTopic;
}

/** P5: one person's progress on one required video. */
export interface TeamVideoCell {
  videoId: number;
  watchedS: number;
  completedAt: string | null;
}

export interface TeamVideoProgressRow {
  userId: number;
  userName: string;
  /** Required videos (for this person's role) they have watched. */
  watchedRequired: number;
  /** Every video they have watched. */
  watched: number;
  /** P5: required videos for this person's role (the "8" of "6 of 8 watched"). */
  requiredTotal?: number;
  avatarColor?: string;
  teamName?: string | null;
  /** P5: one cell per required video that applies to them, in `videos` order. */
  cells?: TeamVideoCell[];
}

/** The leader's team view: "6 of 8 watched". */
export interface TeamVideoProgress {
  /** Required videos in this view (any audience). */
  required: number;
  rows: TeamVideoProgressRow[];
  /** P5: the required videos, newest first. */
  videos?: TeamVideoColumn[];
}

/** P5: what the server holds on disk (Settings → Learning videos). */
export interface VideoStorage {
  uploads: number;
  bytes: number;
  /** The folder the files live in, to copy for a backup. */
  folder: string;
}

export interface VideoSettings {
  leadersCanAdd: boolean;
  /** P5: GET only. */
  storage?: VideoStorage;
}

/** P5: GET /videos/access — may the caller add videos (Learning → Videos → Add video)? */
export interface VideoAccess {
  canAdd: boolean;
  /**
   * P5: for someone who may add videos, the bytes an upload may take on the server's disk now (free space less the
   * reserve; lib/videos/files.ts uploadRoomBytes), so Add video can say so before sending the file; null when the
   * server cannot tell. Not sent to anyone else.
   */
  uploadRoomBytes?: number | null;
}
