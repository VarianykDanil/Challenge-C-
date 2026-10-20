/**
 * Release 1.2 — OWNED BY L2 learning-pitch.
 * Pure: phrase patterns → the COD pack theory a line uses, with a one-line why and the lesson it links to
 * (/learning/pack/:lessonKey#anchor; keys and anchors: shared/src/types/learning.ts LESSON_KEYS / LESSON_ANCHORS).
 *
 * The rules read the line as written, brackets included, so "(Pause - 1 Second)" and an inline "(Close)" are matched
 * too. Curly quotes and apostrophes are straightened before matching ("I’m sure" = "I'm sure"). Rules are tried in the
 * order below, which is also the order the chips are shown in; a theory is shown once per line.
 */
import type { PitchAnnotation, PitchAnnotationRule } from '../types/pitches.ts';

/** Straightens curly quotes and apostrophes so one pattern matches what phones type. */
export function straightenQuotes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** Every rule, in display order. Wording of the "why" follows the COD pack. */
export const PITCH_ANNOTATION_RULES: PitchAnnotationRule[] = [
  {
    theory: 'introduction',
    label: 'Hook',
    why: 'A first line that stops them: the first impression is made in 7 to 10 seconds',
    lessonKey: 'five-steps',
    anchor: 'introduction',
    pattern: /^(?:over|nearly|almost|around|about|more than) [\d,]+\s|\bevery \d+ (?:minutes|seconds|hours)\b/i,
  },
  {
    theory: 'strategic-pause',
    label: 'Strategic pause',
    why: 'Pausing adds effect and shows confidence',
    lessonKey: 'strategic-pause',
    pattern: /\(\s*pause\b/i,
  },
  {
    theory: 'pre-emptive-strike',
    label: 'Pre-emptive strike',
    why: 'Attacks the negative before it arises',
    lessonKey: 'pre-emptive-strike',
    pattern: /\bI know (?:that's|that is|it's|it is|you're|you are|you support|you have|you've)\b|\bI can see you're\b/i,
  },
  {
    theory: 'indifference',
    label: 'Indifference',
    why: 'A relaxed, take-it-or-leave-it approach: lean on your back foot',
    lessonKey: 'impulse-factors',
    anchor: 'indifference',
    pattern: /\bno pressure\b|\btake it or leave it\b|\bno worries if not\b/i,
  },
  {
    theory: 'short-story',
    label: 'Short story',
    why: 'Who? What? Why? answered fast: it removes uncertainty and keeps you in control',
    lessonKey: 'five-steps',
    anchor: 'short-story',
    pattern: /\bwhat we do\b|\bwho we are\b|\bour mission\b|\bwhy we(?:'re| are) here\b/i,
  },
  {
    theory: 'presentation',
    label: 'Problem and solution',
    why: 'Create the problem and be the solution',
    lessonKey: 'five-steps',
    anchor: 'presentation',
    pattern: /\bsurvival rate\b|\bour goal\b|\bthis close\b|\bthe problem\b|\bthe solution\b/i,
  },
  {
    theory: 'close',
    label: 'Close',
    why: 'An assumptive statement that gets a yes or no, at the height of impulse',
    lessonKey: 'five-steps',
    anchor: 'close',
    pattern: /\(\s*close\s*\)/i,
  },
  {
    theory: 'buzzwords',
    label: 'Buzzwords',
    why: '"Unfortunately", "Obviously", "However" carry the conversation where you want it',
    lessonKey: 'five-steps',
    anchor: 'presentation',
    pattern: /\b(?:unfortunately|obviously|however)\b/i,
  },
  {
    theory: 'past-tense',
    label: 'Past tense',
    why: "Speak in past tense: everyone nice enough to stop said they'd love to help",
    lessonKey: 'five-steps',
    anchor: 'presentation',
    pattern: /\bsaid (?:they'd|they would|they will)\b|\b(?:has|have) (?:stopped|signed up)\b/i,
  },
  {
    theory: 'group-effect',
    label: 'Group effect',
    why: 'People put more value in the buying decisions of others; nobody wants to be first or last',
    lessonKey: 'impulse-factors',
    anchor: 'group-effect',
    pattern: /\bpeople like yourself\b|\beveryone\b|\beverybody\b|\bwe all\b|\ball come together\b|\bas well\b/i,
  },
  {
    theory: 'greed',
    label: 'Greed',
    why: 'Increase the value, decrease the cost: something small they would not miss',
    lessonKey: 'impulse-factors',
    anchor: 'greed',
    pattern: /\bsomething small\b|\bwouldn't miss\b|\ba few quid\b|\ba tenner\b|£\s?\d+(?:\.\d\d)? a (?:month|week)\b/i,
  },
  {
    theory: 'power-of-suggestion',
    label: 'Power of suggestion',
    why: 'Start a sentence with "I\'m sure" (and end it with "yeah"): suggestive language gets the yes',
    lessonKey: 'impulse-factors',
    anchor: 'power-of-suggestion',
    pattern: /\bI'm sure\b|\bI am sure\b/i,
  },
  {
    theory: 'fear-of-loss',
    label: 'Fear of loss',
    why: 'Fear of loss is greater than the need to gain: now they want to qualify',
    lessonKey: 'impulse-factors',
    anchor: 'fear-of-loss',
    pattern: /\bI(?: would|'d| will)? (?:just )?need to check\b|\bif you qualify\b/i,
  },
  {
    theory: 'qualifying-questions',
    label: 'Qualifying question',
    why: 'Asked at the end of the pitch, a qualifying question uses fear of loss',
    lessonKey: 'impulse-factors',
    anchor: 'fear-of-loss',
    pattern: /^you (?:live|bank|work) in the uk\b|\bover the age of\b|\bcheeky question\b|\bare you (?:a uk|over \d+|a homeowner|registered)\b/i,
  },
  {
    theory: 'consolidation',
    label: 'Consolidation',
    why: 'Remind them why they signed up and pre-empt the welcome call',
    lessonKey: 'five-steps',
    anchor: 'consolidation',
    pattern: /\bwelcome call\b|\bat least (?:2|two) years\b|\bthank you (?:so much )?for (?:signing|joining)\b/i,
  },
];

/**
 * The non-verbal on a stage direction such as "(Slow smile and cautious)". Matched on stage directions only: a whole
 * direction line, or a direction inside a spoken line such as "… have you got some for me? (Smile and laugh)"; never
 * on the spoken words themselves.
 */
export const PITCH_DIRECTION_RULES: PitchAnnotationRule[] = [
  {
    theory: 'introduction',
    label: 'Smile',
    why: 'Non-verbals: a smile gets the mirror effect, eye contact builds trust',
    lessonKey: 'five-steps',
    anchor: 'introduction',
    pattern: /\bsmil(?:e|es|ing)\b/i,
  },
];

/** The annotations for one spoken line, in rule order, without duplicates. */
export function annotatePitchLine(text: string, rules: readonly PitchAnnotationRule[] = PITCH_ANNOTATION_RULES): PitchAnnotation[] {
  const out: PitchAnnotation[] = [];
  const subject = straightenQuotes(text).trim();
  for (const { pattern, ...annotation } of rules) {
    pattern.lastIndex = 0;
    if (pattern.test(subject) && !out.some((a) => a.theory === annotation.theory)) out.push(annotation);
  }
  return out;
}
