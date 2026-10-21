/**
 * Release 1.3 — P7 recruitment-plus contracts (laid down by r3-foundation; OWNED BY P7, which may add fields and types).
 *
 * Owner's decision 8 (quote): "Recruitment needs much more: date of birth; who handled each stage; interviewer changes
 * (which leader); interview schedule; the exact interview questions asked, with the interviewer writing the
 * candidate's answers."
 *
 * Endpoints (server/src/routes/recruitmentPlus.ts, mounted at /recruitment BEFORE the 1.0 recruitment router, owned
 * by P7; P7 also owns routes/recruitment.ts for date of birth on candidates and logging reassignments / reschedules
 * on PATCH /recruitment/interviews/:id; recruitment roles only — admin, leader, recruiter; stubs: reads empty,
 * writes 501):
 *  - GET  /recruitment/schedule?from=&to=&interviewerId=&type= → InterviewScheduleItem[]
 *  - GET  /recruitment/candidates/:id/timeline                  → CandidateTimelineItem[]
 *  - GET  /recruitment/questions?type=                         → InterviewQuestion[] (admin, recruiter)
 *  - POST /recruitment/questions  InterviewQuestionInput       → 201 InterviewQuestion (admin, recruiter)
 *  - PATCH /recruitment/questions/:id  Partial<InterviewQuestionInput> → InterviewQuestion
 *  - GET  /recruitment/interviews/:id/sheet                    → InterviewSheet (questions as asked + answers)
 *  - PUT  /recruitment/interviews/:id/answers  InterviewAnswerInput[] → InterviewSheet (autosave)
 * The question text is copied into interview_answers when the sheet is first opened, so later edits to the bank never
 * change a past interview. Plain, lawful questions only (no age, health, family or religion questions).
 * Tables (server/src/db/extensions/recruitment.ts): candidates.date_of_birth, interview_questions, interview_answers,
 * interview_changes. "Who handled each stage" comes from stage_changes.changed_by_id (already recorded).
 */
import type { CandidateStage, Interview, Position } from '../types.ts';

export type InterviewType = Interview['type'];

/** Under this age the profile shows the "Under 18" warning. */
export const CANDIDATE_ADULT_AGE = 18;

export interface InterviewQuestion {
  id: number;
  interviewType: InterviewType;
  /** null: every position. */
  position: Position | null;
  text: string;
  sort: number;
  active: boolean;
}

export interface InterviewQuestionInput {
  interviewType: InterviewType;
  position?: Position | null;
  text: string;
  sort?: number;
  active?: boolean;
}

export interface InterviewAnswer {
  interviewId: number;
  /** null for a question asked that is not in the bank. */
  questionId: number | null;
  /** As asked (copied when the sheet was first opened). */
  questionText: string;
  answer: string;
  /** Optional 1–5. */
  score: number | null;
  updatedAt: string | null;
}

export interface InterviewAnswerInput {
  questionId: number | null;
  questionText?: string;
  answer: string;
  score?: number | null;
}

export interface InterviewSheet {
  interview: Interview & { candidateName: string };
  answers: InterviewAnswer[];
}

/** interview_changes: a reassignment or a reschedule. */
export type InterviewChangeField = 'interviewer' | 'scheduled_at' | 'type' | 'outcome';

export interface InterviewChange {
  id: number;
  interviewId: number;
  field: InterviewChangeField;
  fromValue: string | null;
  toValue: string | null;
  /** Readable: "Amelia Hart", "Thu 22 Oct, 10:00". */
  fromLabel?: string | null;
  toLabel?: string | null;
  changedBy: number | null;
  changedByName?: string | null;
  changedAt: string;
}

export type CandidateTimelineKind = 'applied' | 'stage' | 'interview' | 'interviewer' | 'reschedule' | 'outcome';

/** "Interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah". */
export interface CandidateTimelineItem {
  at: string;
  kind: CandidateTimelineKind;
  text: string;
  byId: number | null;
  byName: string | null;
  interviewId?: number | null;
}

export interface InterviewScheduleItem extends Interview {
  candidateName: string;
  candidateStage: CandidateStage;
  positionApplied: Position;
}
