/**
 * Release 1.3 — OWNED BY P5 learning-videos (laid down by r3-foundation). Pure rules for learning videos: topic labels,
 * the embed URL for YouTube / Vimeo / Google Drive links, and when a video counts as watched. P5 fills the stub.
 */
import { VIDEO_COMPLETE_SHARE, type VideoTopic } from '../types/videos.ts';

export const VIDEO_TOPIC_LABELS: Record<VideoTopic, string> = {
  interviews: 'Interviews',
  pitching: 'Pitching',
  objections: 'Objections',
  leadership: 'Leadership',
  other: 'Other',
};

/** STUB (P5): the iframe URL for a YouTube, Vimeo or Google Drive link; null for anything else. */
export function videoEmbedUrl(url: string): string | null {
  void url;
  return null;
}

/** Watched once 90 % of the length has been seen (unknown length: never by time alone). */
export function isVideoComplete(watchedS: number, durationS: number | null | undefined): boolean {
  return !!durationS && durationS > 0 && watchedS >= durationS * VIDEO_COMPLETE_SHARE;
}
