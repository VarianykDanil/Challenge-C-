// Release 1.3 — OWNED BY P7 recruitment-plus. The candidate profile and the interview sheet as PDFs, built on P4's
// page primitives (lib/pdf pdfDocument: header, key values, line table, headings, paragraphs, footer with page x of y).
// The pages show the buttons only while PDF_EXPORTS_READY (P4 sets it); each download is reported to the audit trail.
import type { CandidateSheet, CandidateTimelineItem, InterviewAnswer, InterviewSheet } from '@lm/shared';
import { INTERVIEW_TYPE_NAMES, POSITION_LABELS, SOURCE_LABELS, STAGE_LABELS, ageOn } from '@lm/shared';
import type { CandidateDetail } from '@/api/hooks';
import { reportAuditEvent } from '@/api/auditEvents';
import { pdfDocument, type PdfDoc } from '@/lib/pdf';
import { todayISO } from '@/lib/dates';
import { formatDate, formatDateTime, fullName } from '@/lib/format';
import { INTERVIEW_OUTCOME_LABELS } from '@/lib/labels';
import { dobLabel } from './DateOfBirth';

export { PDF_EXPORTS_READY } from '@/lib/pdf';

const FOOTER = 'Linear MCR Limited · Recruitment · Confidential: for the recruitment team only';
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidate';

function dobText(dob: string | null | undefined): string {
  if (!dob) return 'Not recorded';
  const age = ageOn(dob, todayISO());
  return `${dobLabel(dob)}${age !== null ? ` (${age}${age < 18 ? ', under 18' : ''})` : ''}`;
}

function answersInto(doc: PdfDoc, answers: readonly InterviewAnswer[]): void {
  answers.forEach((a, i) => {
    doc.paragraph(`${i + 1}. ${a.questionText}`);
    doc.paragraph(`${a.answer || 'No answer written'}${a.score !== null ? `  (score ${a.score} / 5)` : ''}`, { muted: !a.answer });
  });
}

/** The candidate profile: details, the timeline and every saved interview sheet. */
export async function downloadCandidatePdf(c: CandidateDetail, timeline: readonly CandidateTimelineItem[], sheets: readonly CandidateSheet[]): Promise<void> {
  const name = fullName(c);
  const doc = await pdfDocument({ title: `Candidate profile: ${name}` });
  doc
    .header({ title: name, subtitle: 'Candidate profile', meta: [['Stage', STAGE_LABELS[c.stage]], ['Applied', formatDate(c.appliedAt)], ['Printed', formatDateTime(new Date().toISOString())]] })
    .keyValues([
      ['Email', c.email],
      ['Phone', c.phone ?? '—'],
      ['City', c.city ?? '—'],
      ['Date of birth', dobText(c.dateOfBirth)],
      ['Position', POSITION_LABELS[c.positionApplied]],
      ['Source', `${SOURCE_LABELS[c.source]}${c.referredByName ? ` (by ${c.referredByName})` : ''}`],
      ['Owner', c.ownerName ?? 'Unassigned'],
      ['Rating', c.rating ? `${c.rating} / 5` : '—'],
    ]);
  if (c.notes) doc.heading('Notes').paragraph(c.notes);
  doc.heading('Timeline').lineTable(
    [{ key: 'when', header: 'When', width: 1 }, { key: 'what', header: 'What', width: 3 }],
    timeline.map((t) => ({ when: formatDateTime(t.at), what: `${t.text}${t.kind === 'interview' && t.outcome ? ` (${INTERVIEW_OUTCOME_LABELS[t.outcome].toLowerCase()})` : ''}${t.detail ? `. ${t.detail}` : ''}` })),
  );
  for (const s of [...sheets].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    doc.heading(`${INTERVIEW_TYPE_NAMES[s.type]} · ${formatDateTime(s.scheduledAt)}${s.interviewerName ? ` · ${s.interviewerName}` : ''} · ${INTERVIEW_OUTCOME_LABELS[s.outcome]}`);
    answersInto(doc, s.answers);
  }
  const filename = `candidate-${slug(name)}.pdf`;
  doc.footer(FOOTER).save(filename);
  reportAuditEvent({ kind: 'export', format: 'pdf', what: 'candidate profile', entity: 'candidate', entityId: c.id, filename });
}

/** One interview sheet: the questions as asked, the answers and scores, the outcome. */
export async function downloadSheetPdf(sheet: InterviewSheet): Promise<void> {
  const iv = sheet.interview;
  const doc = await pdfDocument({ title: `${INTERVIEW_TYPE_NAMES[iv.type]}: ${sheet.candidate.name}` });
  doc
    .header({
      title: `${INTERVIEW_TYPE_NAMES[iv.type]}: ${sheet.candidate.name}`,
      subtitle: formatDateTime(iv.scheduledAt),
      meta: [['Interviewer', iv.interviewerName ?? 'No interviewer'], ['Outcome', INTERVIEW_OUTCOME_LABELS[iv.outcome]], ['Average score', sheet.summary.averageScore !== null ? `${sheet.summary.averageScore} / 5` : '—']],
    })
    .keyValues([
      ['Position', POSITION_LABELS[sheet.candidate.positionApplied]],
      ['Date of birth', dobText(sheet.candidate.dateOfBirth)],
      ['Answered', `${sheet.summary.answered} of ${sheet.summary.questions}`],
    ]);
  if (iv.notes) doc.heading('Notes').paragraph(iv.notes);
  doc.heading('Questions and answers');
  answersInto(doc, sheet.answers);
  const filename = `interview-${slug(sheet.candidate.name)}-${iv.scheduledAt.slice(0, 10)}.pdf`;
  doc.footer(FOOTER).save(filename);
  reportAuditEvent({ kind: 'export', format: 'pdf', what: 'interview sheet', entity: 'candidate', entityId: sheet.candidate.id, filename });
}
