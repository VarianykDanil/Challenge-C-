// Release 1.2 — L1 learning-pack: the shape of a COD pack lesson as typed data. OWNED BY L1.
// Lessons are rebuilt from the pack as real HTML (headings, lists, tables), never screenshots of text; the only images
// are the pack's illustrations, cropped into client/public/cod-pack/*.webp.
import type { CareerLevel, LessonKey } from '@lm/shared';

/** Inline text. `**bold**` marks the pack's own emphasis (FEEL / FELT / FOUND, the letters of an acronym). */
export type Rich = string;

export interface LessonImage {
  src: string;
  alt: string;
  /** Intrinsic size of the file (the box is reserved before it loads). */
  width: number;
  height: number;
  caption?: string;
}

export type CalloutTone = 'tip' | 'note' | 'key';

export type LessonBlock =
  | { kind: 'p'; text: Rich; tone?: 'lead' | 'muted' }
  | { kind: 'list'; items: Rich[]; ordered?: boolean }
  /** "Definition: …" — the pack prints these in red italics. */
  | { kind: 'definition'; text: Rich }
  /** Lines you say out loud, set as quotes. */
  | { kind: 'quotes'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][]; caption?: string }
  | { kind: 'callout'; tone: CalloutTone; title?: string; text: Rich }
  | { kind: 'figure'; image: LessonImage; size?: 'sm' | 'md' | 'lg' }
  /** An image beside its text on wide screens, stacked on phones. */
  | { kind: 'media'; image: LessonImage; blocks: LessonBlock[] }
  /** FORM, KISS, AIR, GIFGUP: one letter per row, its word next to it. */
  | { kind: 'acronym'; letters: { letter: string; word: string; struck?: boolean }[]; note?: string }
  /** A left-to-right flow (attitude: losing → notice → regain). */
  | { kind: 'flow'; steps: { title: string; items: Rich[] }[] }
  /** Side-by-side cards (three core principles, the teach-back's three ideas, the traffic light's groups). */
  | { kind: 'cards'; items: LessonCard[]; columns?: 2 | 3 | 4 }
  /** Say-this lines for a stage of the conversation (no time: stop → "short version"). */
  | { kind: 'lines'; rows: { cue: string; say: string }[] }
  /** Custom renderers. */
  | { kind: 'bullet-chamber' }
  | { kind: 'career-ladder' };

export interface LessonCard {
  title: string;
  /** A coloured dot for the traffic light groups. */
  tone?: 'success' | 'warning' | 'danger' | 'primary';
  image?: LessonImage;
  text?: Rich;
  items?: Rich[];
  ordered?: boolean;
  /** A sub-list under its own small heading (e.g. "Benefits"). */
  subtitle?: string;
  subitems?: Rich[];
}

export interface LessonSection {
  /** Element id (`/learning/pack/:key#id`); shared LESSON_ANCHORS must all exist. */
  id?: string;
  title?: string;
  /** e.g. "7 to 10 seconds". */
  meta?: string;
  blocks: LessonBlock[];
}

export interface QuizQuestion {
  q: string;
  options: string[];
  /** Index of the right option. */
  answer: number;
  /** Shown after checking: why that is the answer, in the pack's words. */
  why: string;
}

export interface Lesson {
  key: LessonKey;
  title: string;
  /** Short name for cards and the checklist ("Bullet theory"). */
  short: string;
  /** The rows of the pack's leadership checklist this lesson covers. */
  checklist: string[];
  /** COD pack page(s), e.g. "15" or "18–19"; null for the office's own tasks. */
  page: string | null;
  summary: string;
  keyPoints: string[];
  /** Cover image for the hub card and the top of the lesson. */
  image?: LessonImage;
  sections: LessonSection[];
  /** Three multiple-choice questions from the content ([] for a practical task: it is ticked as done). */
  quiz: QuizQuestion[];
  /** "Teach it back": what to write in your own words for your leader. */
  teachPrompt: string;
  /** Extra words for the hub's search. */
  keywords?: string[];
  /** A practical task from the checklist (no theory in the pack): the office fills in the details. */
  task?: boolean;
}

/** One rung of the pack's career ladder (pages 18–19). */
export interface LadderLevel {
  level: CareerLevel;
  phase: 'pre' | 'post';
  focus: string;
  learn: string[];
  /** "Criteria to progress" to the next level, in the pack's words ([] at the top). */
  criteria: string[];
}
