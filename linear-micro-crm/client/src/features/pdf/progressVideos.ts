// Release 1.3 — OWNED BY P4 pdf-everywhere. Which required videos a person's progress PDF lists, from the same
// answers the Learning page reads (P5's GET /videos and GET /videos/team). Pure and free of app aliases, so the
// server's PDF test can run it (server/src/test/pdf-export.test.ts).
import type { LearningVideo, Role, TeamVideoProgress, VideoAudience } from '@lm/shared';

/**
 * Is a required video required of this role? The same rule as P5's shared videoRequiredFor (release 1.3): "everyone"
 * is every staff role, "leaders" team leaders only, "reps" reps only. Kept here so P4 builds on its own; once P5 has
 * landed, `videoRequiredFor` from @lm/shared can replace it.
 */
export function videoRequiredOf(video: { required: boolean; audience: VideoAudience }, role: Role): boolean {
  if (!video.required) return false;
  if (video.audience === 'everyone') return role === 'admin' || role === 'leader' || role === 'recruiter' || role === 'rep';
  return video.audience === 'leaders' ? role === 'leader' : video.audience === 'reps' ? role === 'rep' : false;
}

/**
 * GET /videos/team as P5 serves it: each person's own required total (`requiredTotal`, the "8" of "6 of 8 watched")
 * and a cell per required video that applies to them, in `videos` order. `required` on the body counts every required
 * video of any audience, so it is only the fallback for a server without `requiredTotal`.
 */
export type TeamVideoRow = TeamVideoProgress['rows'][number] & { requiredTotal?: number; cells?: { videoId: number; completedAt: string | null }[] };
export type TeamVideoView = Omit<TeamVideoProgress, 'rows'> & { rows: TeamVideoRow[]; videos?: { id: number; title: string }[] };

export interface RequiredVideoLine {
  title: string;
  completedAt: string | null;
}

export interface RequiredVideoSummary {
  watched: number;
  total: number;
  /** One line per required video, when the answer names them (empty for an older server: the counts only). */
  lines: RequiredVideoLine[];
}

/** The person's own view: the required videos that apply to their role, as their Learning page lists them. */
export function ownRequiredVideos(videos: readonly LearningVideo[], role: Role): RequiredVideoSummary | null {
  const lines = videos.filter((v) => videoRequiredOf(v, role)).map((v) => ({ title: v.title, completedAt: v.my?.completedAt ?? null }));
  return lines.length ? { watched: lines.filter((l) => l.completedAt).length, total: lines.length, lines } : null;
}

/** Someone else's view (a leader or the admin): that person's own total, never the count of every audience's videos. */
export function teamRequiredVideos(view: TeamVideoView, userId: number): RequiredVideoSummary | null {
  const row = view.rows.find((r) => r.userId === userId);
  const total = row ? (row.requiredTotal ?? view.required) : 0;
  if (!row || total <= 0) return null;
  const titles = new Map((view.videos ?? []).map((v) => [v.id, v.title]));
  const lines = (row.cells ?? []).filter((c) => titles.has(c.videoId)).map((c) => ({ title: titles.get(c.videoId)!, completedAt: c.completedAt }));
  return { watched: row.watchedRequired, total, lines };
}
