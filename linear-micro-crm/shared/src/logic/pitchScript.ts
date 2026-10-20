/**
 * Release 1.2 — OWNED BY L2 learning-pitch (laid down by r2-foundation; the parser bodies are stubs).
 * Pure: turns a pitch's plain-text body into blocks (spoken lines with inline name / close / pause / direction
 * segments, stage directions, pause beats, Yes / No branches), tags each spoken line with its step of the five steps
 * and its annotations (./pitchAnnotations.ts), and parses the fact-check notes. Format: shared/src/types/pitches.ts.
 */
import type { PitchFact, PitchScript, PitchStepTarget } from '../types/pitches.ts';

/** Target times from the COD pack's "5 steps to a conversation" (null: the pack sets none). */
export const PITCH_STEP_TARGETS: PitchStepTarget[] = [
  { step: 'introduction', label: 'Introduction', minSeconds: 7, maxSeconds: 10 },
  { step: 'short-story', label: 'Short story', minSeconds: 10, maxSeconds: 15 },
  { step: 'presentation', label: 'Presentation', minSeconds: null, maxSeconds: null },
  { step: 'close', label: 'Close', minSeconds: null, maxSeconds: null },
  { step: 'consolidation', label: 'Consolidation', minSeconds: null, maxSeconds: null },
];

/** STUB (L2): parse a pitch body into blocks. Deterministic: the same text always gives the same blocks. */
export function parsePitchScript(body: string): PitchScript {
  void body;
  return { blocks: [], lineCount: 0, wordCount: 0, estimatedSeconds: 0 };
}

/** STUB (L2): split the fact-check notes into notes matched to the script lines they quote. */
export function parsePitchFacts(facts: string | null, body: string): PitchFact[] {
  void facts;
  void body;
  return [];
}
