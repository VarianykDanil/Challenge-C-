// Release 1.3 — P5 learning-videos: the words of the videos screens, and small formatting helpers.
import {
  VIDEO_COMPLETE_SHARE,
  formatVideoLength,
  videoLengthLabel,
  type LearningVideo,
  type VideoProgress,
} from '@lm/shared';
import { format } from 'date-fns';
import { parseDate } from '@/lib/format';

export const VIDEO_COPY = {
  section: {
    title: 'Videos',
    description: 'Recorded interviews and talks. The required ones are in your checklist.',
    empty: 'No videos yet.',
    emptyCanAdd: 'Add the first one: upload a recording, or paste a YouTube, Vimeo or Google Drive link.',
    emptyCannotAdd: 'Recorded interviews and talks from the office appear here.',
    add: 'Add video',
    all: 'All',
  },
  add: {
    title: 'Add video',
    description: 'Upload a recording from this device, or paste a link to YouTube, Vimeo or Google Drive.',
    upload: 'Upload a file',
    link: 'Paste a link',
    choose: 'Choose a video',
    chooseAgain: 'Choose another',
    fileHint: 'MP4, WebM or MOV, up to 2 GB. Keep this page open until it has uploaded.',
    linkLabel: 'Link to the video',
    linkPlaceholder: 'https://www.youtube.com/watch?v=…',
    linkHint: 'YouTube, Vimeo or Google Drive. A Drive file must be shared with “Anyone with the link”.',
    linkBad: 'Paste a YouTube, Vimeo or Google Drive video link',
    lengthLabel: 'Length',
    lengthHint: 'mm:ss or whole minutes, e.g. 9:58. It counts as watched at 90% of this.',
    lengthBad: 'Write the length as mm:ss (e.g. 9:58) or in minutes, up to six hours',
    submitUpload: 'Upload video',
    submitLink: 'Add video',
    cancelUpload: 'Cancel upload',
    uploading: 'Uploading…',
    added: 'Video added',
    cancelled: 'Upload cancelled',
    searchWaits: 'Search opens once the upload has finished',
    noRoom: (room: string, size: string) =>
      `The server has room for ${room} more and this video is ${size}. Free some disk space on the server, or paste a YouTube, Vimeo or Google Drive link instead.`,
    stopTitle: 'Stop the upload?',
    stopBody: (sent: string, total: string) => `${sent} of ${total} has gone up. If you stop now, you will need to start it again.`,
    keepUploading: 'Keep uploading',
    stopUpload: 'Stop the upload',
  },
  fields: {
    title: 'Title',
    description: 'What it covers',
    descriptionPlaceholder: 'e.g. Amelia’s interview with a new starter: the questions to ask and why.',
    topic: 'Topic',
    audience: 'Who it is for',
    required: 'Required',
    requiredHint: 'Adds it to the Learning checklist of everyone it is for.',
  },
  edit: {
    title: 'Edit video',
    save: 'Save changes',
    saved: 'Video saved',
    delete: 'Delete video',
    deleteTitle: (title: string) => `Delete “${title}”?`,
    deleteBody: 'It goes from Learning and from everyone’s checklist, with everyone’s progress. An uploaded file is deleted from the server too.',
    deleted: 'Video deleted',
    uploadLengthHint: 'Linear Hub could not read this file’s length. Type it as mm:ss (e.g. 9:58): it counts as watched at 90% of this.',
  },
  player: {
    resumed: (at: string) => `Picked up where you left off, at ${at}.`,
    startOver: 'Start from the beginning',
    yourProgress: 'Your progress',
    watchedOn: (date: string) => `Watched on ${date}`,
    countsAt: `Counts as watched once you have seen ${Math.round(VIDEO_COMPLETE_SHARE * 100)}%.`,
    noLength: 'Play it to see how far you are: its length shows once it starts.',
    noLengthUpload: 'Play it to see how far you are. It counts as watched once Linear Hub knows how long it is.',
    driveNote: 'Google Drive cannot tell Linear Hub how much you have watched. When you have watched it, tap Mark as watched.',
    notTracking: 'This player is not reporting your progress. When you have watched it, tap Mark as watched.',
    markWatched: 'Mark as watched',
    marked: 'Marked as watched',
    missing: 'Video not found',
    missingBody: 'It may have been deleted, or it is not one of the videos for your role.',
    example: 'Example',
    exampleNote: 'An example video from the demo data: replace it with your own recordings.',
    openOn: (provider: string) => `Open on ${provider}`,
    fileError: 'This browser cannot play this file. Try it in Safari or Chrome, or upload it again as an MP4 (H.264): a MOV from an iPhone may need Safari.',
  },
  views: {
    title: 'Who watched',
    description: 'Everyone who has started it, watched first.',
    none: 'Nobody has started it yet.',
    summary: (watched: number, watching: number) => `${watched} watched · ${watching} still watching`,
  },
  progress: {
    title: 'Required videos',
    me: 'Each counts once you have seen 90% of it.',
    person: (first: string, done: number, total: number) => `${first} has watched ${done} of ${total}.`,
    team: (all: number, people: number) => `${all} of ${people} ${people === 1 ? 'person has' : 'people have'} watched every required video.`,
    noneRequired: 'Nothing required for this role.',
  },
  settings: {
    title: 'Learning videos',
    description: 'Who can add videos to Learning, and where uploaded videos are kept.',
    leaders: 'Leaders can add videos',
    leadersHint: 'Team leaders can upload videos and add links in Learning → Videos, and change the ones they added. Administrators always can.',
    saved: (on: boolean) => (on ? 'Leaders can now add videos' : 'Only administrators can add videos now'),
    storage: (count: number, size: string) => `${count} uploaded ${count === 1 ? 'video' : 'videos'}, ${size}`,
    backup: 'The nightly backup copies the database only, not these files. Copy this folder too when you back up or move Linear Hub.',
  },
} as const;

/**
 * For the box around a Switch: the 44 × 24 px toggle answers a tap 8 px around it too (60 × 40 px), so it is a full
 * phone tap target (its label is clickable as well).
 */
export const SWITCH_HIT_AREA = "[&_[role=switch]]:after:absolute [&_[role=switch]]:after:-inset-2 [&_[role=switch]]:after:content-['']";

/** "Tue 20 Oct". */
export function formatDay(value: string | null | undefined): string {
  const d = parseDate(value);
  return d ? format(d, 'EEE d MMM') : '—';
}

/** "312 MB", "1.4 GB", "820 KB". */
export function formatBytes(bytes: number | null | undefined): string {
  const b = Math.max(0, bytes ?? 0);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

export type VideoStatus = 'watched' | 'started' | 'new';

export function videoStatus(my: VideoProgress | null | undefined): VideoStatus {
  if (my?.completedAt) return 'watched';
  if (my && (my.watchedS > 0 || my.positionS > 0)) return 'started';
  return 'new';
}

/** "4 of 10 min" / "Watched Tue 20 Oct" / "10 min". */
export function progressText(v: Pick<LearningVideo, 'durationS'>, my: VideoProgress | null | undefined): string {
  if (my?.completedAt) return `Watched ${formatDay(my.completedAt)}`;
  if (my && my.watchedS > 0) {
    const w = my.watchedS;
    const d = v.durationS;
    if (!d) return `${formatVideoLength(w)} seen`;
    if (d >= 3600) return `${formatVideoLength(w)} of ${formatVideoLength(d)}`;
    if (d < 60) return `${Math.floor(w)} of ${Math.round(d)} s`;
    // floored, so "9 of 10 min" never reads as finished before it counts as watched
    return w >= 60 ? `${Math.floor(w / 60)} of ${Math.round(d / 60)} min` : `${Math.floor(w)} s of ${Math.round(d / 60)} min`;
  }
  return v.durationS ? videoLengthLabel(v.durationS) : 'Length not known yet';
}

/** Whether "watched" came from seeing 90% of it, rather than "Mark as watched" (the server stores which). */
export function watchedByPlaying(my: VideoProgress | null | undefined): boolean {
  return !!my?.completedAt && !my.marked;
}
