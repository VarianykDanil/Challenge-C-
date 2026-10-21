/**
 * Release 1.3 — P5 learning-videos contracts (laid down by r3-foundation; OWNED BY P5, which may add fields and types).
 *
 * Owner's decision 5 (quote): "Learning: Matt wants VIDEOS (recorded interviews, talks) people watch as part of
 * learning." Lead decision: upload to the server (mp4/webm/mov, up to 2 GB, streamed with byte ranges) OR a link
 * (YouTube, Vimeo, Google Drive). Optional "required" flag adds the video to everyone's Learning checklist.
 *
 * Endpoints (server/src/routes/videos.ts, mounted at /videos, owned by P5; stubs: reads empty, writes 501):
 *  - GET    /videos                      → LearningVideo[] (the caller's audience; with `my` progress)
 *  - GET    /videos/:id                  → LearningVideo
 *  - GET    /videos/:id/stream           → the file with HTTP Range (206); auth required; Cache-Control: private, no-store
 *  - POST   /videos  VideoLinkInput      → 201 LearningVideo (admin; leaders when allowed in settings)
 *  - POST   /videos/upload               → 201 LearningVideo (multipart, busboy streaming; same roles)
 *  - PATCH  /videos/:id  VideoUpdateInput → LearningVideo
 *  - DELETE /videos/:id                  → 204
 *  - POST   /videos/:id/progress  VideoProgressInput → VideoProgress (every 15 s and on pause / end)
 *  - GET    /videos/:id/views            → VideoViewRow[] (admin: who watched)
 *  - GET    /videos/team?userId=         → TeamVideoProgress (leader: own team; admin: everyone) — cached
 *  - GET    /videos/settings, PUT /videos/settings VideoSettings (admin)
 * Files: server/data/media/videos/<uuid>.<ext> (git-ignored; the nightly DB backup does not copy media).
 * Tables (server/src/db/extensions/videos.ts): learning_videos, video_views; meta `ext:videos:leaders_can_add`.
 */

export type VideoKind = 'upload' | 'link';
export type VideoTopic = 'interviews' | 'pitching' | 'objections' | 'leadership' | 'other';
export const VIDEO_TOPICS: readonly VideoTopic[] = ['interviews', 'pitching', 'objections', 'leadership', 'other'];
export type VideoAudience = 'everyone' | 'leaders' | 'reps';

/** 2 GB. */
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
/** A video counts as watched at 90 % of its length. */
export const VIDEO_COMPLETE_SHARE = 0.9;
/** The player reports progress every 15 seconds (and on pause and at the end). */
export const VIDEO_PROGRESS_INTERVAL_S = 15;

export interface VideoProgress {
  videoId: number;
  watchedS: number;
  /** Where to resume. */
  positionS: number;
  completedAt: string | null;
  lastAt: string | null;
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
  watchedS: number;
  positionS?: number;
  ended?: boolean;
}

export interface VideoViewRow {
  userId: number;
  userName: string;
  watchedS: number;
  completedAt: string | null;
  lastAt: string | null;
}

/** The leader's team view: "6 of 8 watched". */
export interface TeamVideoProgress {
  required: number;
  rows: { userId: number; userName: string; watchedRequired: number; watched: number }[];
}

export interface VideoSettings {
  leadersCanAdd: boolean;
}
