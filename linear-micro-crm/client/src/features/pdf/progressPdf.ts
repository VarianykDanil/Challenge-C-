// Release 1.3 — OWNED BY P4 pdf-everywhere. A person's learning progress as a PDF: the COD pack checklist (learned,
// self-check, teach-back, signed off by whom), what their next level needs (from their own numbers) and the required
// videos (P5). Loaded on demand by ProgressPdfButton. The data comes through the same queries the page uses (React
// Query cache first), so it shows exactly what the page shows and the server's role scoping applies unchanged.
import type { QueryClient } from '@tanstack/react-query';
import {
  CAREER_LEVEL_LABELS,
  LESSON_TITLES,
  POSITION_LABELS,
  type LearningProgress,
  type LearningVideo,
  type Progression,
  type Role,
} from '@lm/shared';
import { api, qs } from '@/api/client';
import { learningKeys } from '@/api/learning';
import { videoKeys } from '@/api/videos';
import { csvFilename } from '@/lib/csv';
import { formatDate } from '@/lib/format';
import { pdfDocument, type PdfLineRow } from '@/lib/pdf';
import { ownRequiredVideos, teamRequiredVideos, type RequiredVideoSummary, type TeamVideoView } from './progressVideos';

const STALE = 30_000;

/** "Mon 12 Oct 2026" in local time, or the fallback. */
const day = (iso: string | null | undefined, fallback = '—') => (iso ? formatDate(iso) : fallback);

export interface ProgressPdfInput {
  /** Omitted: the signed-in person (GET /learning/progress without userId, as the page asks). */
  userId?: number;
  /** The signed-in person: whose progression and videos to read when userId is omitted. */
  meId: number;
  /** The signed-in person's role: which required videos apply to them (their own view). */
  meRole: Role;
  generatedBy: string | null;
}

/** Builds and downloads the PDF; returns the file name and the number of lessons, for the toast and the audit trail. */
export async function downloadProgressPdf(qc: QueryClient, input: ProgressPdfInput): Promise<{ filename: string; rows: number; name: string }> {
  const who = input.userId ?? input.meId;
  const [progress, progression, videos] = await Promise.all([
    qc.fetchQuery({
      queryKey: learningKeys.progress(input.userId),
      queryFn: () => api<LearningProgress>(`/learning/progress${qs({ userId: input.userId })}`),
      staleTime: STALE,
    }),
    qc
      .fetchQuery({ queryKey: learningKeys.progression(who), queryFn: () => api<Progression>(`/learning/progression/${who}`), staleTime: STALE })
      .catch(() => null),
    (input.userId
      ? qc.fetchQuery({
          queryKey: videoKeys.team(input.userId),
          queryFn: () => api<TeamVideoView>(`/videos/team${qs({ userId: input.userId })}`),
          staleTime: STALE,
        })
      : qc.fetchQuery({ queryKey: videoKeys.list, queryFn: () => api<LearningVideo[]>('/videos'), staleTime: STALE })
    ).catch(() => null),
  ]);

  const name = progress.userName;
  const position = progression?.position ? POSITION_LABELS[progression.position] : null;
  const doc = await pdfDocument({ title: `Learning progress · ${name}`, generatedBy: input.generatedBy });

  const meta: [string, string][] = [
    ['Learned', `${progress.learned} of ${progress.total}`],
    ['Taught', `${progress.taught} of ${progress.total}`],
  ];
  if (progression?.level) meta.push(['Level', CAREER_LEVEL_LABELS[progression.level]]);
  doc.header({ title: 'Learning progress', subtitle: position ? `${name} · ${position}` : name, meta });

  doc
    .heading('Leadership checklist')
    .paragraph('The COD pack, lesson by lesson: learn it (pass the self-check), then teach it back and have it signed off.', { muted: true, size: 8.5 })
    .lineTable(
      [
        { key: 'lesson', header: 'Lesson', width: 3 },
        { key: 'learned', header: 'Learned', width: 1.7 },
        { key: 'check', header: 'Self-check', width: 1.1 },
        { key: 'teach', header: 'Teach-back sent', width: 1.7 },
        { key: 'taught', header: 'Signed off', width: 2.4 },
      ],
      progress.lessons.map((l): PdfLineRow => ({
        lesson: LESSON_TITLES[l.lessonKey] ?? l.lessonKey,
        learned: day(l.learnedAt, 'Not yet'),
        check: l.quizScore != null && l.quizTotal ? `${l.quizScore} of ${l.quizTotal}` : '—',
        teach: day(l.teachbackAt),
        taught: l.taughtSignedOffAt ? `${day(l.taughtSignedOffAt)}${l.taughtSignedOffByName ? ` by ${l.taughtSignedOffByName}` : ''}` : '—',
        muted: l.state === 'new',
      })),
    );

  if (progression && progression.enabled !== false && progression.nextLevel && progression.requirements.length) {
    // the heading, the sentence and the table together (about 9 mm a row)
    doc.needs(26 + (progression.requirements.length + 1) * 9);
    doc.heading(`Next level: ${CAREER_LEVEL_LABELS[progression.nextLevel]}`);
    if (progression.headline) doc.paragraph(progression.headline);
    doc.lineTable(
      [
        { key: 'need', header: 'What it needs', width: 2.4 },
        { key: 'status', header: 'Status', width: 0.9 },
        { key: 'detail', header: 'Where things are', width: 3.2 },
      ],
      progression.requirements.map((r) => ({
        need: r.label,
        status: r.met ? 'Met' : 'Not yet',
        detail: r.options.map((o) => o.detail).filter(Boolean).join(' or ') || '—',
      })),
    );
  }

  const required: RequiredVideoSummary | null = !videos
    ? null
    : Array.isArray(videos)
      ? ownRequiredVideos(videos, input.meRole)
      : input.userId
        ? teamRequiredVideos(videos, input.userId)
        : null;
  if (required) {
    doc.needs(20 + Math.min(required.lines.length + 1, 6) * 8);
    doc.heading('Required videos');
    // the own view lists every video; another person's view says the count, then the videos when the answer names them
    if (!Array.isArray(videos)) doc.paragraph(`${required.watched} of ${required.total} required ${required.total === 1 ? 'video' : 'videos'} watched.`);
    if (required.lines.length) {
      doc.lineTable(
        [
          { key: 'title', header: 'Video', width: 3.5 },
          { key: 'watched', header: 'Watched', width: 2 },
        ],
        required.lines.map((v) => ({ title: v.title, watched: v.completedAt ? day(v.completedAt) : 'Not yet', muted: !v.completedAt })),
      );
    }
  }

  doc.footer(`Linear Hub · Learning progress · ${name}`);
  const filename = csvFilename(`learning-progress-${name || who}`).replace(/\.csv$/, '.pdf');
  doc.save(filename);
  return { filename, rows: progress.lessons.length, name };
}
