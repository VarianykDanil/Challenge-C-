/**
 * UA learning screens (release 1.2 review #12): a lesson page shows its summary at the top, then the lesson itself.
 * The lesson must not open by repeating the summary word for word: the pack's definition and lead lines stay in the
 * body, and the summary says the lesson in other words. Loads the lessons themselves (client/src/content/learning).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_KEYS } from '@lm/shared';

type Block = { kind: string; text?: string; tone?: string; blocks?: Block[] };
interface Lesson {
  key: string;
  summary: string;
  sections: { blocks: Block[] }[];
}
const { LESSONS } = (await import(new URL('../../../client/src/content/learning/index.ts', import.meta.url).href)) as {
  LESSONS: Record<string, Lesson>;
};

/** Lower case, no bold markers, punctuation as spaces: "Pausing to add effect." and "pausing to add effect" match. */
const norm = (s: string) =>
  s
    .replace(/\*\*/g, '')
    .replace(/[“”"‘’'.,:;!?…()–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The paragraphs and definitions a lesson opens with, before its first other block (a picture's text included). */
function openingText(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.kind === 'media') return [...out, ...openingText(b.blocks ?? [])];
    if (b.kind !== 'p' && b.kind !== 'definition') break;
    out.push(b);
  }
  return out;
}

test('#12 no lesson opens by repeating its summary', () => {
  for (const key of LESSON_KEYS) {
    const l = LESSONS[key]!;
    const summary = norm(l.summary);
    const sentences = l.summary.split(/(?<=[.!?])\s+/).map(norm).filter((s) => s.split(' ').length >= 3);
    for (const b of openingText(l.sections[0]?.blocks ?? [])) {
      const text = norm(b.text ?? '');
      assert.ok(!summary.includes(text), `${key}: the ${b.kind} “${b.text}” repeats the summary “${l.summary}”`);
      for (const s of sentences) assert.ok(!text.includes(s), `${key}: the ${b.kind} “${b.text}” repeats “${s}” from the summary`);
    }
  }
});

test('#12 the four lessons the review named keep the pack’s definition in the body', () => {
  const firstDefinition = (key: string) => openingText(LESSONS[key]!.sections[0]!.blocks).find((b) => b.kind === 'definition')?.text;
  assert.equal(firstDefinition('strategic-pause'), 'Pausing to add effect.');
  assert.equal(firstDefinition('law-of-averages'), 'The more you repeat an action the more a positive / negative outcome will occur.');
  assert.equal(firstDefinition('pre-emptive-strike'), 'Attacking the negative before it arises.');
  assert.equal(firstDefinition('impulse-factors'), 'Impulse is someone’s natural level of excitement.');
});
