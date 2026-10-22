/**
 * Release 1.3 — P7 recruitment-plus contracts (laid down by r3-foundation; OWNED BY P7, which may add fields and types).
 *
 * Owner's decision 8 (quote): "Recruitment needs much more: date of birth; who handled each stage; interviewer changes
 * (which leader); interview schedule; the exact interview questions asked, with the interviewer writing the
 * candidate's answers."
 *
 * Endpoints (server/src/routes/recruitmentPlus.ts, mounted at /recruitment BEFORE the 1.0 recruitment router, owned
 * by P7; P7 also owns routes/recruitment.ts for date of birth on candidates and logging bookings, reassignments,
 * reschedules and outcomes on POST / PATCH /recruitment/interviews; recruitment roles only — admin, leader, recruiter):
 *  - GET  /recruitment/schedule?from=&to=&interviewerId=&type= → InterviewScheduleItem[] (interviewerId=none: unassigned)
 *  - GET  /recruitment/candidates/:id/timeline                  → CandidateTimelineItem[] (newest first)
 *  - GET  /recruitment/candidates/:id/sheets                    → CandidateSheet[] (the questions and answers as asked)
 *  - GET  /recruitment/questions?type=                         → InterviewQuestion[] (admin, recruiter)
 *  - POST /recruitment/questions  InterviewQuestionInput       → 201 InterviewQuestion (admin, recruiter)
 *  - PATCH /recruitment/questions/:id  Partial<InterviewQuestionInput> → InterviewQuestion (admin, recruiter)
 *  - PUT  /recruitment/questions/order  InterviewQuestionOrderInput → InterviewQuestion[] of that type (admin, recruiter)
 *  - GET  /recruitment/interviews/:id/sheet                    → InterviewSheet (questions as asked + answers)
 *  - PUT  /recruitment/interviews/:id/answers  InterviewAnswerInput[] → InterviewSheet (autosave: the questions this device
 *    changed, each with the answer and score it started from; 409 InterviewSheetConflictDetails when another device
 *    changed the same question first)
 * The question text is copied into interview_answers the first time anything is saved on a sheet (until then the
 * sheet shows the bank's active questions), so later edits to the bank never change a past interview. Plain, lawful
 * questions only (no age, health, family or religion questions).
 * Tables (server/src/db/extensions/recruitment.ts): candidates.date_of_birth, interview_questions, interview_answers,
 * interview_changes. "Who handled each stage" comes from stage_changes.changed_by_id (already recorded).
 */
import type { CandidateStage, Interview, Position } from '../types.ts';

export type InterviewType = Interview['type'];
export type InterviewOutcome = Interview['outcome'];

/** Under this age the profile shows the "Under 18" warning. */
export const CANDIDATE_ADULT_AGE = 18;
/** A date of birth that makes the candidate younger than this (or older than the max) is refused as a likely typo. */
export const CANDIDATE_MIN_AGE = 14;
export const CANDIDATE_MAX_AGE = 100;

/** Limits shared by the forms and the server. */
export const INTERVIEW_QUESTION_MAX = 300;
export const INTERVIEW_ANSWER_MAX = 4000;
/** The most questions one interview sheet holds. */
export const INTERVIEW_SHEET_MAX_QUESTIONS = 30;

export interface InterviewQuestion {
  id: number;
  interviewType: InterviewType;
  /** null: every position. */
  position: Position | null;
  text: string;
  sort: number;
  active: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface InterviewQuestionInput {
  interviewType: InterviewType;
  position?: Position | null;
  text: string;
  sort?: number;
  active?: boolean;
}

/** PUT /recruitment/questions/order: every question of one type, in the new order. */
export interface InterviewQuestionOrderInput {
  interviewType: InterviewType;
  ids: number[];
}

export interface InterviewAnswer {
  interviewId: number;
  /** null for a question asked that is not in the bank. */
  questionId: number | null;
  /** As asked (copied when the sheet was first saved). */
  questionText: string;
  answer: string;
  /** Optional 1–5. */
  score: number | null;
  updatedAt: string | null;
  /** The stored row (absent while the sheet is still the bank's draft). */
  id?: number;
  /** 0-based order on the sheet. */
  sort?: number;
  updatedById?: number | null;
  updatedByName?: string | null;
}

/** An answer and its score: what a device saw stored, or what it is saving. */
export interface InterviewAnswerValue {
  answer: string;
  score: number | null;
}

export interface InterviewAnswerInput {
  questionId: number | null;
  /** Required for a question that is not in the bank; for a bank question, the words on screen (first save only). */
  questionText?: string;
  answer: string;
  score?: number | null;
  /**
   * The stored answer and score this device started from (blank for a question it has not seen saved). With it the
   * save is per question: a question whose answer and score equal its base is left as it is (another device's newer
   * words stand), and one changed here is written only while the stored row still equals the base — else 409. Without
   * it the row is written as sent.
   */
  base?: InterviewAnswerValue;
  /** Take this question off the sheet ("Not asked"). Questions left out of a save are never taken off. */
  removed?: boolean;
}

/** 409 from PUT /recruitment/interviews/:id/answers (`details`): the questions another device changed first. */
export interface InterviewSheetConflictDetails {
  conflicts: { questionId: number | null; questionText: string }[];
  /** The sheet as stored now, to choose from. */
  sheet: InterviewSheet;
}

/** Counts over one sheet (shared `sheetSummary`). */
export interface InterviewSheetSummary {
  questions: number;
  /** Questions with a written answer. */
  answered: number;
  /** Questions with a 1–5 score. */
  scored: number;
  /** Mean of the scores, one decimal place; null when nothing is scored. */
  averageScore: number | null;
}

export interface InterviewSheetCandidate {
  id: number;
  name: string;
  stage: CandidateStage;
  positionApplied: Position;
  /** YYYY-MM-DD when recorded. */
  dateOfBirth: string | null;
}

export interface InterviewSheet {
  interview: Interview & { candidateName: string };
  answers: InterviewAnswer[];
  /** True once the questions are fixed for this interview (something has been saved); false: the bank's draft. */
  saved: boolean;
  candidate: InterviewSheetCandidate;
  summary: InterviewSheetSummary;
  /** This interview's bookings, reassignments, reschedules and outcomes, oldest first. */
  changes: InterviewChange[];
}

/** GET /recruitment/candidates/:id/sheets: one saved sheet of the candidate's interviews. */
export interface CandidateSheet {
  interviewId: number;
  type: InterviewType;
  scheduledAt: string;
  interviewerId: number | null;
  interviewerName: string | null;
  outcome: InterviewOutcome;
  answers: InterviewAnswer[];
  summary: InterviewSheetSummary;
}

/** interview_changes: a booking, a reassignment, a reschedule, a change of type or an outcome. */
export type InterviewChangeField = 'interviewer' | 'scheduled_at' | 'type' | 'outcome' | 'booked';

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

export type CandidateTimelineKind = 'applied' | 'stage' | 'interview' | 'interviewer' | 'reschedule' | 'outcome' | 'booked';

/** "Interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah". */
export interface CandidateTimelineItem {
  at: string;
  kind: CandidateTimelineKind;
  text: string;
  byId: number | null;
  byName: string | null;
  interviewId?: number | null;
  /** A stage move's note, an interview's notes. */
  detail?: string | null;
  /** Stage items: the stage moved to. */
  stage?: CandidateStage | null;
  /** Interview items: the outcome now. */
  outcome?: InterviewOutcome | null;
}

export interface InterviewScheduleItem extends Interview {
  candidateName: string;
  candidateStage: CandidateStage;
  positionApplied: Position;
  /** Questions on the sheet (saved, else the bank's draft count for the type) and how many have an answer. */
  sheetQuestions: number;
  sheetAnswered: number;
  /** The interview's date in Europe/London (YYYY-MM-DD), for grouping by day. */
  day: string;
}
