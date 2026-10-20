/**
 * Release 1.2 — OWNED BY L2 learning-pitch (laid down by r2-foundation; the rules are a stub).
 * Pure: phrase patterns → the COD pack theory a line uses, with a one-line why and the lesson it links to
 * (/learning/pack/:lessonKey#anchor; keys and anchors: shared/src/types/learning.ts LESSON_KEYS / LESSON_ANCHORS).
 */
import type { PitchAnnotation, PitchAnnotationRule } from '../types/pitches.ts';

/** STUB (L2): e.g. /\bI know that'?s a little bit heavy\b/ → pre-emptive strike (pre-emptive-strike). */
export const PITCH_ANNOTATION_RULES: PitchAnnotationRule[] = [];

/** The annotations for one spoken line, in rule order, without duplicates. */
export function annotatePitchLine(text: string, rules: readonly PitchAnnotationRule[] = PITCH_ANNOTATION_RULES): PitchAnnotation[] {
  const out: PitchAnnotation[] = [];
  for (const { pattern, ...annotation } of rules) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !out.some((a) => a.theory === annotation.theory)) out.push(annotation);
  }
  return out;
}
