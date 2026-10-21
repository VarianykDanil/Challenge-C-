/**
 * L1 learning-pack, release 1.2 content fixes (G4): the lessons say what the COD pack says and nothing it does not.
 * Loads the lessons themselves (client/src/content/learning, plain data that Node runs with its types stripped) and,
 * for the two copy lines that live in components, reads the component source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LESSON_KEYS } from '@lm/shared';

const CLIENT = new URL('../../../client/src/', import.meta.url);
type Block = { kind: string; text?: string; tone?: string; title?: string; items?: string[]; image?: { src: string; alt: string }; blocks?: Block[] };
interface Lesson {
  key: string;
  title: string;
  summary: string;
  keyPoints: string[];
  sections: { id?: string; title?: string; blocks: Block[] }[];
  quiz: { q: string; options: string[]; why: string }[];
  teachPrompt: string;
  keywords?: string[];
}
const content = (await import(new URL('content/learning/index.ts', CLIENT).href)) as {
  LESSONS: Record<string, Lesson>;
  IMAGES: Record<string, { src: string; alt: string }>;
};
const L = content.LESSONS;
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, CLIENT)), 'utf8');

/** Every block of a lesson, nested media blocks included. */
function blocksOf(lesson: Lesson): Block[] {
  const out: Block[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      out.push(b);
      if (b.blocks) walk(b.blocks);
    }
  };
  for (const s of lesson.sections) walk(s.blocks);
  return out;
}
/** All the words a reader sees in a lesson (summary, key points, blocks, quiz, prompt). */
function textOf(lesson: Lesson): string {
  const parts: string[] = [lesson.title, lesson.summary, ...lesson.keyPoints, lesson.teachPrompt];
  for (const s of lesson.sections) parts.push(s.title ?? '');
  for (const b of blocksOf(lesson)) parts.push(b.title ?? '', b.text ?? '', ...(b.items ?? []), b.image?.alt ?? '');
  for (const q of lesson.quiz) parts.push(q.q, ...q.options, q.why);
  return parts.join('\n');
}

test('M2 law of averages: no invented reading of the pack’s numbers; the gauges line and a note to ask the leader', () => {
  const l = L['law-of-averages']!;
  const text = textOf(l);
  assert.ok(!/Read across the funnel/.test(text), 'the funnel paragraph is gone');
  assert.ok(text.includes('00/50/40/30/10'), 'the pack’s numbers stay as printed');
  assert.ok(l.keyPoints.includes('Your six gauges in Linear Hub (stops, to table, presentations, closes, taps and sales) count your shots on target.'));
  assert.ok(!l.keyPoints.some((k) => /are your law of averages/.test(k)));
  assert.ok(blocksOf(l).some((b) => b.kind === 'callout' && b.tone === 'note' && b.text === 'Ask your leader to walk you through the pack’s numbers for your campaign.'));
});

test('M3 run an impact and go on a roadtrip: no invented procedure, no promise of office details', () => {
  const impact = L['run-an-impact']!;
  assert.equal(impact.summary, 'A practical task on the leadership checklist. The COD pack lists it but does not describe it: ask your leader what it involves, then tick it as done and say how it went so they can sign it off.');
  assert.deepEqual(impact.keyPoints, ['A task on the leadership checklist: the pack has no theory for it.', 'Ask your leader what it involves.', 'Tick it as done, write how it went; your leader signs it off.']);
  const ib = blocksOf(impact);
  assert.deepEqual(ib.find((b) => b.kind === 'list')?.items, ['Ask your leader what an impact involves and when you can run one.', 'Do it.', 'Tick it as done and write a few lines on how it went.']);
  assert.ok(ib.some((b) => b.kind === 'callout' && b.text === 'The COD pack lists this task but does not describe it. Ask your leader to walk you through one.'));
  assert.deepEqual(impact.keywords, ['impact', 'task']);

  const trip = L['go-on-a-roadtrip']!;
  assert.equal(trip.summary, 'A practical task on the leadership checklist: road trips are one of the 7 key areas of leadership. Ask your leader when the next one is, then tick it as done and say what you learned.');
  assert.deepEqual(trip.keyPoints, ['Road trips are one of the 7 key areas of leadership.', 'Ask your leader when the next one is.', 'Write what you learned below; your leader signs it off.']);
  const tb = blocksOf(trip);
  assert.deepEqual(tb.find((b) => b.kind === 'list')?.items, ['Ask your leader about the next road trip.', 'Go on it.', 'Tick it as done and write what you learned.']);
  assert.ok(tb.some((b) => b.kind === 'callout' && b.text === 'The COD pack lists this task but does not describe it. Ask your leader when the next road trip is.'));
  assert.equal(trip.teachPrompt, 'Where did you go, and what did you learn?');

  for (const l of [impact, trip]) {
    const text = textOf(l);
    assert.ok(!/Your office adds|Details from your office|Watch your leader run|work the new territory|other leaders/.test(text), `${l.key}: ${text}`);
  }
});

test('M3 demo seed: the two task write-ups describe nothing the pack does not', () => {
  const seed = readFileSync(fileURLToPath(new URL('../db/extensions/learning.ts', import.meta.url)), 'utf8');
  assert.ok(seed.includes(`'run-an-impact': 'Done with my leader there. It went well, and next time I will be more confident.'`));
  assert.ok(seed.includes(`'go-on-a-roadtrip': 'Went on the road trip with the team. Working somewhere new kept the urgency up.'`));
  assert.ok(!/morning meeting: everyone stood up/.test(seed));
});

test('M4 assuming the role: one dress code for everyone, no heels or makeup rule', () => {
  const text = textOf(L['assuming-the-role']!);
  assert.ok(text.includes('**Image.** A professional image in the office: smart and well presented, for example a clean ironed shirt and tie, or equivalent smart office wear.'));
  assert.ok(!/heels|makeup|Ladies|Men –/i.test(text), text);
});

test('minor 1–3: five steps and impulse factors say what the pack says', () => {
  const five = L['five-steps']!;
  assert.ok(five.summary.endsWith('The introduction (7 to 10 seconds) is the most important step: the 1st impression.'), five.summary);
  assert.ok(!/decide whether you get the rest/.test(five.summary));
  assert.ok(five.keyPoints.includes('Consolidation: remind them why they signed up and use feel good factors to reduce buyer’s remorse.'));
  const five5 = textOf(five);
  assert.ok(!/buyers remorse/.test(five5), 'buyer’s remorse');
  assert.ok(five5.includes('**buyer’s remorse**'));
  const impulse = textOf(L['impulse-factors']!);
  assert.ok(impulse.includes('SW3 = N is usually read as “some will, some won’t, so what… next”: check with your leader.'));
  assert.ok(!impulse.includes('SW3 = N: some will'));
});

test('minor 4: the strategic pause adds nothing to the pack', () => {
  const l = L['strategic-pause']!;
  const callout = blocksOf(l).find((b) => b.kind === 'callout');
  assert.equal(callout?.text, 'Pitch scripts mark a pause as “(Pause - 1 Second)”.');
  assert.ok(!/eye contact|line land/.test(textOf(l)), textOf(l));
});

test('minor 5–6: the bamboo picture is described as drawn; the bullet sits beside C.O.W.S', () => {
  const alt = content.IMAGES.bamboo!.alt;
  assert.ok(alt.includes('Day 1: a smiling person sows seeds from a packet beside a farmer with a pitchfork. Days 2 to 5: sun, time and water but nothing shows above ground'), alt);
  assert.ok(!/handed a packet|nothing grows/.test(alt));
  const cows = L['bullet-theory']!.sections.find((s) => s.id === 'cows')!;
  assert.ok(cows.blocks.some((b) => b.kind === 'media' && b.image?.src === '/cod-pack/bullet.webp'), 'bullet.webp is shown next to C.O.W.S');
});

test('minor 18: footfall, not footflow; teach-back with a hyphen in our own words', () => {
  const can = L['can-cant-controls']!;
  const text = textOf(can);
  assert.ok(!/footflow/i.test(text), text);
  assert.ok(/footfall/.test(text));
  assert.ok(can.keywords?.includes('footflow'), 'a search for the pack’s own word still finds it');
  for (const key of LESSON_KEYS) {
    const l = L[key]!;
    // The pack's own names keep "teachback" (the lesson title "Theory of teachback", the card "3 rules of the teachback").
    const ours = [l.summary, ...l.keyPoints, l.teachPrompt, ...l.quiz.flatMap((q) => [q.q, ...q.options, q.why])].join('\n');
    assert.ok(!/teachback/i.test(ours), `${key}: ${ours}`);
  }
});

test('minor 15 and 17: the ladder phase line and the hub’s self-check sentence', () => {
  assert.ok(source('features/learning/pack/CareerLadder.tsx').includes(`description: 'From entry level to assistant director.'`));
  const hub = source('pages/Learning.tsx');
  assert.ok(hub.includes('Each lesson ends with a three-question self-check (the two checklist tasks are ticked as done instead).'), 'hub sentence');
});
