/**
 * Release 1.2 — L2 learning-pitch contracts (laid down by r2-foundation; OWNED BY L2, which may add fields and types).
 * Every signed-in role may read pitches; admins and leaders edit them (PUT). Edits are audited by U3's middleware.
 */
import type { LessonKey } from './learning.ts';

/** GET /pitches/:campaignCode — the stored pitch with its campaign (404 when the campaign has none yet). */
export interface CampaignPitch {
  id: number;
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  campaignColor: string;
  title: string;
  /** The script as plain text; the format is parsed by `parsePitchScript` (shared/src/logic/pitchScript.ts). */
  body: string;
  /** Fact-check notes, plain text ("- "quoted line": note. Source: url" per bullet); null when there are none. */
  facts: string | null;
  updatedBy: number | null;
  updatedByName: string | null;
  updatedAt: string;
}

/** GET /pitches — one row per campaign (active campaigns first), with or without a pitch. */
export interface PitchListItem {
  campaignId: number;
  campaignCode: string;
  campaignName: string;
  campaignColor: string;
  campaignActive: boolean;
  hasPitch: boolean;
  title: string | null;
  updatedAt: string | null;
}

/** PUT /pitches/:campaignCode (admin, leader) — creates or replaces the campaign's pitch. */
export interface PitchUpsertInput {
  title: string;
  body: string;
  facts?: string | null;
}

// ── Script format (parsePitchScript) ──
// Plain text, one spoken line per line. A whole line in brackets is a stage direction; "(Pause - 1 Second)" is a pause
// beat; "(Name)" is the person's name slot; "(Close)" marks the close; a line starting "Yes -" or "No -" starts a branch
// for the answer to the previous question. Blank lines separate paragraphs.

/** The five steps to a conversation (COD pack), used for the step timer and to tag blocks. */
export type PitchStepKey = 'introduction' | 'short-story' | 'presentation' | 'close' | 'consolidation';

/** Target duration of a step from the pack (intro 7–10 s, short story 10–15 s); null bounds have no target. */
export interface PitchStepTarget {
  step: PitchStepKey;
  label: string;
  minSeconds: number | null;
  maxSeconds: number | null;
}

/** Inline pieces of a spoken line. */
export type PitchSegment =
  | { kind: 'text'; text: string }
  | { kind: 'name' }
  | { kind: 'close' }
  | { kind: 'pause'; seconds: number | null }
  | { kind: 'direction'; text: string };

/** The COD pack theories a line can use (annotation chips). */
export type PitchTheoryKey =
  | 'strategic-pause'
  | 'short-story'
  | 'pre-emptive-strike'
  | 'group-effect'
  | 'past-tense'
  | 'power-of-suggestion'
  | 'greed'
  | 'indifference'
  | 'fear-of-loss'
  | 'urgency'
  | 'buzzwords'
  | 'qualifying-questions'
  | 'introduction'
  | 'presentation'
  | 'close'
  | 'consolidation';

/** One chip on a line: which theory it uses, why, and the lesson it links to (/learning/pack/:lessonKey#anchor). */
export interface PitchAnnotation {
  theory: PitchTheoryKey;
  label: string;
  /** One line, e.g. "Attacks the negative before it arises". */
  why: string;
  lessonKey: LessonKey;
  anchor?: string;
}

/** A rule in shared logic: when a line matches `pattern` (case-insensitive), it gets the annotation. */
export interface PitchAnnotationRule extends PitchAnnotation {
  pattern: RegExp;
}

/**
 * A parsed piece of the script. `line` is the 1-based source line it starts on. `step` is the step of the five steps
 * the piece belongs to (set by parsePitchScript on every line, direction and pause; see shared/src/logic/pitchScript.ts).
 */
export type PitchBlock =
  | { kind: 'line'; line: number; text: string; segments: PitchSegment[]; step?: PitchStepKey; annotations: PitchAnnotation[] }
  | {
      kind: 'direction';
      line: number;
      text: string;
      step?: PitchStepKey;
      annotations?: PitchAnnotation[];
      /** Set when the direction names a step, e.g. "(Short story)": the step starts here (the page shows a step heading instead). */
      stepMarker?: PitchStepKey;
    }
  | { kind: 'pause'; line: number; seconds: number | null; text: string; step?: PitchStepKey; annotations?: PitchAnnotation[] }
  | { kind: 'break'; line: number }
  | { kind: 'branch'; line: number; question: string | null; branches: PitchBranch[]; step?: PitchStepKey };

export interface PitchBranch {
  /** 'yes' / 'no' from "Yes -" / "No -". */
  answer: 'yes' | 'no';
  label: string;
  blocks: PitchBlock[];
}

/** One step of the five in a parsed script: how long it reads aloud (estimate) against the pack's target. */
export interface PitchStepEstimate extends PitchStepTarget {
  /** Read-aloud estimate in whole seconds (the longest branch of each Yes / No), including pauses. */
  seconds: number;
  /** Spoken lines tagged with this step (every branch counted). */
  lines: number;
  /** The 1-based source line where the step starts, or null when the script has no line in it. */
  firstLine: number | null;
}

/** parsePitchScript(body) */
export interface PitchScript {
  blocks: PitchBlock[];
  /** Spoken lines (directions and pauses excluded). */
  lineCount: number;
  wordCount: number;
  /** Read-aloud estimate including pauses. */
  estimatedSeconds: number;
  /** The five steps in order, each with its estimate and the pack's target (PITCH_STEP_TARGETS). */
  steps: PitchStepEstimate[];
  /** The speaking rate behind the estimates (PITCH_WORDS_PER_MINUTE). */
  wordsPerMinute: number;
}

/** How a fact-check note reads: the figure checks out, the office should check it, or a general note. */
export type PitchFactTone = 'verified' | 'check' | 'info';

/** One fact-check note, matched to the script lines it concerns (parsePitchFacts). */
export interface PitchFact {
  /** The quoted words the note is about, or null for a general note. */
  quote: string | null;
  /** Every leading quote of the note (a note may cover two phrases); `quote` is the first. */
  quotes: string[];
  note: string;
  /** "Suggested wording: "…"" from the note, shown on its own; null when the note has none. */
  suggestion: string | null;
  tone: PitchFactTone;
  sources: string[];
  /** 1-based script lines the quote matches. */
  lines: number[];
}

/**
 * A line flagged in the practice modes (teleprompter, flashcards): a fact-check note the office has not approved yet
 * (tone 'check') quotes it (pitchFactFlags).
 */
export interface PitchFactFlag {
  fact: PitchFact;
  /** True on the first line the note quotes, where its suggested wording shows; later lines it covers get the marker. */
  first: boolean;
}

/** Memorise mode: one flashcard per spoken line (pitchCards). */
export interface PitchCard {
  /** Stable per line text (pitchLineKey), ":2" etc. when the same words come back; progress is saved under it. */
  key: string;
  /** 1-based source line. */
  line: number;
  /** The words as said aloud, the name slot as "(Name)". */
  text: string;
  segments: PitchSegment[];
  step: PitchStepKey;
  /** Set for a line inside a Yes / No branch. */
  branch: { answer: 'yes' | 'no'; label: string; question: string | null } | null;
  /** The line said just before, shown as the cue (null for the first line). */
  cue: string | null;
}
