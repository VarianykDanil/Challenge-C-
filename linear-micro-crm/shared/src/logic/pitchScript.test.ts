// Release 1.2 — L2 learning-pitch: the pitch script parser, step estimates, flashcards, fact-check notes and
// annotation rules. The BCN pitch below is the owner's script, word for word (it is also the seeded pitch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PitchBlock, PitchTheoryKey } from '../types/pitches.ts';
import { LESSON_ANCHORS, LESSON_KEYS } from '../types/learning.ts';
import { annotatePitchLine, PITCH_ANNOTATION_RULES, PITCH_DIRECTION_RULES, straightenQuotes } from './pitchAnnotations.ts';
import {
  countPitchWords,
  matchPitchQuote,
  parsePitchFacts,
  parsePitchScript,
  pitchCards,
  pitchLineKey,
  pitchLineSeconds,
  pitchSegments,
  pitchSpokenLines,
  pitchSpokenText,
  pitchStepVerdict,
  PITCH_STEP_ORDER,
  PITCH_STEP_TARGETS,
  PITCH_WORDS_PER_MINUTE,
} from './pitchScript.ts';

const BCN = `Over 1000 women are dying from breast cancer every month
(Pause - 1 Second)

That's every 43 minutes someone is losing a mother, a daughter or a wife
(Pause - 1 Second)

(Slow smile and cautious)

I know that's a little bit heavy for a Monday afternoon ok I'm not here to depress you. I'll leave that giant over there ahahah

What we do is provide emotional and practical support to the individuals suffering and the families

Do you know anyone who has suffered from breast cancer

Yes -
If you don't mind me asking how was there support?

So you can see the significance of why we are here.

No - Count yourself lucky it's definitely on the rise in the UK.

Our mission is by 2050 anyone diagnosed will live and be supported to live well.

As of 1980 it was a 50% survival rate to as of 2025 87%

(Name) we we literally this close 🤏🏾 to our goal where we will have a world we're breast cancer isn't destroying lives.

Pretty amazing right!! (Close)

But unfortunately it does cost us millions of pounds a year. Now as smart as you're looking gonna guess you're not a millionaire and if you are, have you got some for me? (Smile and laugh)

But the amazing people like yourself who have stopped it said they'd love to help out and support as long as it was something small something they wouldn't miss a few quid out of the week a tenner a month.

You may not seem like much, but we all come together it definitely makes life changing difference.

I'm sure we can count on your support as well however I would need to check

You live in the UK
You bank in the UK
Cheeky question are you slightly over the age of 35?`;

const BCN_FACTS = `- "Over 1000 women ... every month" and "every 43 minutes": Breast Cancer Now says about 11,500 women die of breast cancer each year in the UK = nearly 1,000 a month, about one every 45 minutes. Suggested accurate wording: "Nearly 1,000 women die from breast cancer in the UK every month. That's one every 45 minutes." Source: https://breastcancernow.org/about-us/media/statements/breast-cancer-now-responds-to-news-that-197-000-deaths-from-breast-cancer-have-been-avoided-in-the-uk-in-the-last-37-years
- "by 2050 anyone diagnosed will live and be supported to live well": matches Breast Cancer Now's stated aim (https://breastcancernow.org/about-us/who-we-are).
- "As of 1980 it was a 50% survival rate ... 2025 87%": not verified. Cancer Research UK reports breast cancer death rates down 46% since the early 1970s. Use the figure in the charity's current campaign brief.
- UK fundraising rules (Fundraising Regulator's Code of Fundraising Practice) require statements to donors to be accurate and not misleading; the office should approve the final figures.`;

type LineBlock = Extract<PitchBlock, { kind: 'line' }>;
const lineAt = (blocks: PitchBlock[], n: number): LineBlock => {
  const found = pitchSpokenLines(blocks).find((b) => b.line === n);
  assert.ok(found, `a spoken line starts on line ${n}`);
  return found;
};
const theories = (b: { annotations?: { theory: PitchTheoryKey }[] }) => (b.annotations ?? []).map((a) => a.theory);

test('BCN pitch: blocks in order — lines, pause beats, a direction, one Yes / No branch, breaks between paragraphs', () => {
  const s = parsePitchScript(BCN);
  const kinds = s.blocks.map((b) => b.kind);
  assert.deepEqual(kinds.slice(0, 8), ['line', 'pause', 'break', 'line', 'pause', 'break', 'direction', 'break']);
  assert.ok(!kinds.includes('break') || s.blocks[0]!.kind !== 'break', 'no leading break');
  assert.notEqual(s.blocks[s.blocks.length - 1]!.kind, 'break', 'no trailing break');
  for (let i = 1; i < s.blocks.length; i++) assert.ok(!(s.blocks[i]!.kind === 'break' && s.blocks[i - 1]!.kind === 'break'), 'breaks never repeat');

  const pause = s.blocks[1]!;
  assert.equal(pause.kind, 'pause');
  if (pause.kind === 'pause') {
    assert.equal(pause.seconds, 1);
    assert.equal(pause.text, '(Pause - 1 Second)');
    assert.equal(pause.line, 2);
    assert.deepEqual(theories(pause), ['strategic-pause']);
  }
  const dir = s.blocks[6]!;
  assert.equal(dir.kind, 'direction');
  if (dir.kind === 'direction') {
    assert.equal(dir.text, 'Slow smile and cautious');
    assert.equal(dir.line, 7);
    assert.deepEqual(theories(dir), ['introduction'], 'the smile is a non-verbal of the introduction');
  }

  const branches = s.blocks.filter((b) => b.kind === 'branch');
  assert.equal(branches.length, 1);
  const g = branches[0]!;
  if (g.kind !== 'branch') throw new Error('not a branch');
  assert.equal(g.line, 15);
  assert.equal(g.question, 'Do you know anyone who has suffered from breast cancer');
  assert.deepEqual(g.branches.map((b) => b.answer), ['yes', 'no']);
  assert.deepEqual(g.branches.map((b) => b.label), ['Yes', 'No']);
  const yes = g.branches[0]!.blocks;
  assert.deepEqual(yes.map((b) => b.kind), ['line', 'break', 'line'], 'Yes: the question, then "So you can see…"');
  assert.equal((yes[0] as LineBlock).text, "If you don't mind me asking how was there support?");
  assert.equal((yes[2] as LineBlock).text, 'So you can see the significance of why we are here.');
  const no = g.branches[1]!.blocks;
  assert.equal(no.length, 1, 'No: its one paragraph, then the main script resumes');
  assert.equal((no[0] as LineBlock).text, "Count yourself lucky it's definitely on the rise in the UK.");
  assert.equal(no[0]!.line, 20);

  // After the branch the main script carries on with "Our mission…".
  const after = s.blocks[s.blocks.indexOf(g) + 2]!;
  assert.equal(after.kind, 'line');
  assert.equal((after as LineBlock).text, 'Our mission is by 2050 anyone diagnosed will live and be supported to live well.');
});

test('BCN pitch: inline name slot, close marker and stage direction become segments', () => {
  const s = parsePitchScript(BCN);
  const name = lineAt(s.blocks, 26);
  assert.deepEqual(name.segments[0], { kind: 'name' });
  assert.equal(name.segments[1]!.kind, 'text');
  assert.equal(pitchSpokenText(name.segments, 'Sam').startsWith('Sam we we literally this close'), true, 'the owner\'s words are kept as written');

  const close = lineAt(s.blocks, 28);
  assert.deepEqual(close.segments, [{ kind: 'text', text: 'Pretty amazing right!!' }, { kind: 'close' }]);
  assert.ok(theories(close).includes('close'));

  const joke = lineAt(s.blocks, 30);
  assert.deepEqual(joke.segments[joke.segments.length - 1], { kind: 'direction', text: 'Smile and laugh' });
  assert.ok(theories(joke).includes('buzzwords'), '"unfortunately"');
  assert.ok(theories(joke).includes('introduction'), 'the inline smile is a non-verbal');
});

test('BCN pitch: steps — introduction, short story from "What we do", presentation from the figures, close from the (Close) marker', () => {
  const s = parsePitchScript(BCN);
  const stepOf = (n: number) => lineAt(s.blocks, n).step;
  assert.equal(stepOf(1), 'introduction');
  assert.equal(stepOf(4), 'introduction');
  assert.equal(stepOf(9), 'introduction', 'the pre-emptive strike is part of the first impression');
  assert.equal(stepOf(11), 'short-story');
  assert.equal(stepOf(13), 'short-story');
  assert.equal(stepOf(16), 'short-story');
  assert.equal(stepOf(20), 'short-story');
  assert.equal(stepOf(22), 'short-story');
  assert.equal(stepOf(24), 'presentation');
  assert.equal(stepOf(26), 'presentation');
  assert.equal(stepOf(28), 'close');
  assert.equal(stepOf(30), 'close', '"unfortunately" never moves the step back to the presentation');
  assert.equal(stepOf(36), 'close');
  assert.equal(stepOf(40), 'close');

  assert.deepEqual(s.steps.map((x) => x.step), PITCH_STEP_ORDER);
  const byStep = new Map(s.steps.map((x) => [x.step, x]));
  assert.equal(byStep.get('introduction')!.firstLine, 1);
  assert.equal(byStep.get('short-story')!.firstLine, 11);
  assert.equal(byStep.get('presentation')!.firstLine, 24);
  assert.equal(byStep.get('close')!.firstLine, 28);
  assert.equal(byStep.get('consolidation')!.firstLine, null);
  assert.equal(byStep.get('consolidation')!.seconds, 0);
  assert.equal(byStep.get('introduction')!.minSeconds, 7);
  assert.equal(byStep.get('introduction')!.maxSeconds, 10);
  assert.equal(byStep.get('short-story')!.minSeconds, 10);
  assert.equal(byStep.get('short-story')!.maxSeconds, 15);
});

test('BCN pitch: counts and read-aloud estimate (words at 150 a minute, pauses, the longer branch only)', () => {
  const s = parsePitchScript(BCN);
  assert.equal(s.wordsPerMinute, PITCH_WORDS_PER_MINUTE);
  const spoken = pitchSpokenLines(s.blocks);
  assert.equal(s.lineCount, spoken.length, 'every spoken line here has words');
  assert.equal(s.lineCount, 19);
  const words = spoken.reduce((n, b) => n + countPitchWords(pitchSpokenText(b.segments)), 0);
  assert.equal(s.wordCount, words);

  // Intro: lines 1, 4, 9 and two one-second pauses.
  const introWords = [1, 4, 9].reduce((n, l) => n + countPitchWords(lineAt(s.blocks, l).text), 0);
  const intro = s.steps.find((x) => x.step === 'introduction')!;
  assert.equal(intro.seconds, Math.round((introWords * 60) / PITCH_WORDS_PER_MINUTE + 2));
  assert.equal(intro.lines, 3);
  assert.equal(pitchStepVerdict(intro.seconds, intro), 'over', 'the intro reads longer than the pack\'s 7–10 s');

  // The total counts the Yes branch (longer) and not the No branch.
  const noWords = countPitchWords("Count yourself lucky it's definitely on the rise in the UK.");
  const allSeconds = (words * 60) / PITCH_WORDS_PER_MINUTE + 2;
  assert.equal(s.estimatedSeconds, Math.round(allSeconds - (noWords * 60) / PITCH_WORDS_PER_MINUTE));
  assert.equal(s.steps.reduce((n, x) => n + x.seconds, 0) - s.estimatedSeconds <= 2, true, 'step estimates add up to the total (rounding aside)');
});

test('BCN pitch: annotation chips on the lines the plan names', () => {
  const s = parsePitchScript(BCN);
  const at = (n: number) => theories(lineAt(s.blocks, n));
  assert.deepEqual(at(1), ['introduction'], 'the opening figure is the hook');
  assert.ok(at(9).includes('pre-emptive-strike'), '"I know that\'s a little bit heavy"');
  assert.ok(at(11).includes('short-story'));
  assert.ok(at(24).includes('presentation'));
  const people = at(32);
  for (const t of ['past-tense', 'group-effect', 'greed'] as const) assert.ok(people.includes(t), `"people like yourself…" uses ${t}`);
  const sure = at(36);
  for (const t of ['power-of-suggestion', 'group-effect', 'buzzwords', 'fear-of-loss'] as const) assert.ok(sure.includes(t), `"I'm sure…" uses ${t}`);
  for (const n of [38, 39, 40]) assert.ok(at(n).includes('qualifying-questions'), `line ${n} is a qualifying question`);
  assert.deepEqual(at(13), [], 'a plain question gets no chip');
});

test('annotation rules link to real lessons and anchors; matching is case- and apostrophe-insensitive; no duplicates', () => {
  for (const r of [...PITCH_ANNOTATION_RULES, ...PITCH_DIRECTION_RULES]) {
    assert.ok((LESSON_KEYS as readonly string[]).includes(r.lessonKey), `${r.label} → ${r.lessonKey}`);
    if (r.anchor) {
      const anchors = (LESSON_ANCHORS as Record<string, readonly string[]>)[r.lessonKey];
      assert.ok(anchors?.includes(r.anchor), `${r.label} → ${r.lessonKey}#${r.anchor}`);
    }
    assert.ok(r.why.length > 10 && r.why.length < 120, `${r.label}: one line`);
    assert.ok(!r.pattern.global, `${r.label}: no global flag (stateful lastIndex)`);
  }
  assert.deepEqual(theories({ annotations: annotatePitchLine('I’M SURE we can count on you') }), ['power-of-suggestion']);
  assert.equal(straightenQuotes('That’s “it”'), 'That\'s "it"');
  // Two rules of the same theory never give two chips.
  const twice = annotatePitchLine('everyone and everybody, people like yourself');
  assert.equal(twice.filter((a) => a.theory === 'group-effect').length, 1);
  assert.deepEqual(annotatePitchLine(''), []);
});

test('segments: pauses with and without a length, name variants, unbalanced brackets stay text', () => {
  assert.deepEqual(pitchSegments('(Pause)'), [{ kind: 'pause', seconds: null }]);
  assert.deepEqual(pitchSegments('( Pause - 2 seconds )'), [{ kind: 'pause', seconds: 2 }]);
  assert.deepEqual(pitchSegments('(Long pause 1.5s)'), [{ kind: 'pause', seconds: 1.5 }]);
  assert.deepEqual(pitchSegments('(Pause for effect)'), [{ kind: 'pause', seconds: null }]);
  assert.deepEqual(pitchSegments("(their name)"), [{ kind: 'name' }]);
  assert.deepEqual(pitchSegments('Hi (Name), (smile) ok'), [
    { kind: 'text', text: 'Hi' },
    { kind: 'name' },
    { kind: 'text', text: ',' },
    { kind: 'direction', text: 'smile' },
    { kind: 'text', text: 'ok' },
  ]);
  assert.deepEqual(pitchSegments('Hello (wave'), [{ kind: 'text', text: 'Hello (wave' }]);
  assert.equal(pitchSpokenText(pitchSegments('Hi (Name), how are you?')), 'Hi (Name), how are you?');
  assert.equal(pitchSpokenText(pitchSegments('Hi (Name), how are you?'), 'Jo'), 'Hi Jo, how are you?');
  assert.equal(countPitchWords("It's 87% — 🤏🏾 ahahah don't"), 4);
  assert.equal(pitchLineSeconds(pitchSegments('one two three (Pause - 2 seconds)')), 3 * 60 / PITCH_WORDS_PER_MINUTE + 2);
});

test('whole-line markers: step markers set the step; (Close) and (Name) alone; several brackets on one line', () => {
  const s = parsePitchScript(['Hello there', '(Presentation)', 'We fund research', '(Smile) (Pause)', '(Close)', 'Shall we?', '(Consolidation)', 'Welcome aboard'].join('\n'));
  const kinds = s.blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ['line', 'direction', 'line', 'direction', 'pause', 'line', 'line', 'direction', 'line']);
  const marker = s.blocks[1]!;
  assert.equal(marker.kind === 'direction' && marker.stepMarker, 'presentation');
  assert.equal((s.blocks[2] as LineBlock).step, 'presentation', 'a marker beats the cue ("we fund" is a short-story cue)');
  const close = s.blocks[5] as LineBlock;
  assert.deepEqual(close.segments, [{ kind: 'close' }]);
  assert.equal(close.step, 'close');
  assert.equal((s.blocks[8] as LineBlock).step, 'consolidation');
  assert.equal(s.lineCount, 4, '(Close) alone has no words');
  assert.equal(s.steps.find((x) => x.step === 'short-story')!.lines, 0);
});

test('the first spoken line is always the introduction, even when it carries a later cue', () => {
  const s = parsePitchScript('Hi, what we do is fund research\nUnfortunately it costs money');
  assert.equal((s.blocks[0] as LineBlock).step, 'introduction');
  assert.equal((s.blocks[1] as LineBlock).step, 'presentation');
});

test('branches: end line, a lone branch, a second group, "No-one" is not a branch, explicit markers', () => {
  const two = parsePitchScript(['Have you heard of us?', 'Yes - great', 'more yes', '', 'still yes', 'No - ok', '(Both)', 'Main again', 'Do you drive?', 'No - fine', '', 'Main after', 'No - again', 'No-one says no'].join('\n'));
  const groups = two.blocks.filter((b) => b.kind === 'branch');
  assert.equal(groups.length, 3);
  const [g1, g2, g3] = groups as Extract<PitchBlock, { kind: 'branch' }>[];
  assert.deepEqual(g1!.branches.map((b) => b.blocks.map((x) => x.kind)), [['line', 'line', 'break', 'line'], ['line']]);
  assert.equal(g1!.question, 'Have you heard of us?');
  assert.equal(g2!.question, 'Do you drive?');
  assert.deepEqual(g2!.branches.map((b) => b.answer), ['no']);
  assert.deepEqual(g2!.branches[0]!.blocks.map((b) => (b as LineBlock).text), ['fine']);
  // The same answer again starts a new group; with no other answer after it, a branch is its first paragraph, and
  // "No-one…" is part of it (not a branch).
  assert.deepEqual(g3!.branches.map((b) => b.answer), ['no']);
  assert.deepEqual(g3!.branches[0]!.blocks.map((b) => (b as LineBlock).text), ['again', 'No-one says no']);
  const texts = two.blocks.filter((b) => b.kind === 'line').map((b) => (b as LineBlock).text);
  assert.deepEqual(texts, ['Have you heard of us?', 'Main again', 'Do you drive?', 'Main after']);
  assert.ok(!two.blocks.some((b) => b.kind === 'direction' && b.text === 'Both'), 'the end line is not shown');

  const bare = parsePitchScript('Question?\nYes -\n\nanswer yes\n\nback in main');
  const g = bare.blocks.find((b) => b.kind === 'branch') as Extract<PitchBlock, { kind: 'branch' }>;
  assert.deepEqual(g.branches[0]!.blocks.map((b) => (b as LineBlock).text), ['answer yes'], 'blank lines after a bare "Yes -" are skipped');
  assert.equal((bare.blocks[bare.blocks.length - 1] as LineBlock).text, 'back in main');
});

test('degenerate input: empty, whitespace, CRLF, only directions', () => {
  for (const body of ['', '   \n\n  ']) {
    const s = parsePitchScript(body);
    assert.deepEqual(s.blocks, []);
    assert.equal(s.lineCount, 0);
    assert.equal(s.estimatedSeconds, 0);
    assert.equal(s.steps.length, 5);
  }
  const crlf = parsePitchScript('One two\r\n\r\nThree');
  assert.deepEqual(crlf.blocks.map((b) => b.line), [1, 2, 3]);
  const dirs = parsePitchScript('(Smile)\n(Pause)');
  assert.equal(dirs.lineCount, 0);
  assert.equal(dirs.estimatedSeconds, 1);
  assert.deepEqual(parsePitchScript(BCN), parsePitchScript(BCN), 'deterministic');
});

test('step verdicts against the pack targets', () => {
  const intro = PITCH_STEP_TARGETS[0]!;
  assert.equal(pitchStepVerdict(0, intro), 'none');
  assert.equal(pitchStepVerdict(5, intro), 'under');
  assert.equal(pitchStepVerdict(7, intro), 'within');
  assert.equal(pitchStepVerdict(10, intro), 'within');
  assert.equal(pitchStepVerdict(11, intro), 'over');
  assert.equal(pitchStepVerdict(40, PITCH_STEP_TARGETS[2]!), 'none', 'the pack sets no presentation target');
});

test('flashcards: one per spoken line, cue is the line before, branch lines carry the answer, keys stable and unique', () => {
  const s = parsePitchScript(BCN);
  const cards = pitchCards(s);
  assert.equal(cards.length, s.lineCount);
  assert.equal(cards[0]!.cue, null);
  assert.equal(cards[1]!.cue, cards[0]!.text);
  const yes = cards.filter((c) => c.branch?.answer === 'yes');
  const no = cards.filter((c) => c.branch?.answer === 'no');
  assert.equal(yes.length, 2);
  assert.equal(no.length, 1);
  assert.equal(no[0]!.cue, 'Do you know anyone who has suffered from breast cancer', 'the No branch is cued by the question, not the Yes branch');
  assert.equal(no[0]!.branch!.question, 'Do you know anyone who has suffered from breast cancer');
  const mission = cards.find((c) => c.line === 22)!;
  assert.equal(mission.cue, no[0]!.text);
  assert.equal(new Set(cards.map((c) => c.key)).size, cards.length);
  assert.equal(pitchLineKey('That’s it'), pitchLineKey("that's   it"));
  const dup = pitchCards(parsePitchScript('Hello\nHello'));
  assert.deepEqual(dup.map((c) => c.key), [pitchLineKey('Hello'), `${pitchLineKey('Hello')}:2`]);
});

test('fact-check notes: quotes, notes, suggestion, sources, tone and the lines they concern', () => {
  const facts = parsePitchFacts(BCN_FACTS, BCN);
  assert.equal(facts.length, 4);
  const [deaths, mission, survival, rules] = facts;
  assert.deepEqual(deaths!.quotes, ['Over 1000 women ... every month', 'every 43 minutes']);
  assert.equal(deaths!.quote, 'Over 1000 women ... every month');
  assert.deepEqual(deaths!.lines, [1, 4]);
  assert.equal(deaths!.suggestion, "Nearly 1,000 women die from breast cancer in the UK every month. That's one every 45 minutes.");
  assert.equal(deaths!.tone, 'check');
  assert.ok(deaths!.note.startsWith('Breast Cancer Now says about 11,500 women'));
  assert.ok(!deaths!.note.includes('http') && !deaths!.note.includes('Source'), deaths!.note);
  assert.equal(deaths!.sources.length, 1);
  assert.ok(deaths!.sources[0]!.startsWith('https://breastcancernow.org/about-us/media/statements/'));

  assert.deepEqual(mission!.lines, [22]);
  assert.equal(mission!.tone, 'verified');
  assert.equal(mission!.note, "Matches Breast Cancer Now's stated aim.");
  assert.deepEqual(mission!.sources, ['https://breastcancernow.org/about-us/who-we-are']);

  assert.deepEqual(survival!.lines, [24]);
  assert.equal(survival!.tone, 'check');
  assert.ok(survival!.note.startsWith('Not verified.'));

  assert.equal(rules!.quote, null);
  assert.deepEqual(rules!.lines, []);
  assert.equal(rules!.tone, 'info');
  assert.ok(rules!.note.includes("(Fundraising Regulator's Code of Fundraising Practice)"), 'ordinary brackets are kept');
});

test('fact-check notes: wrapped bullets, paragraphs without bullets, empty input, quotes across lines', () => {
  assert.deepEqual(parsePitchFacts(null, BCN), []);
  assert.deepEqual(parsePitchFacts('  \n ', BCN), []);
  const wrapped = parsePitchFacts('- "every 43 minutes": one every\n  45 minutes really.\n- second', BCN);
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped[0]!.note, 'One every 45 minutes really.');
  const paras = parsePitchFacts('First note\ncontinues\n\n“Pretty amazing right” — fine', BCN);
  assert.equal(paras.length, 2);
  assert.equal(paras[0]!.note, 'First note continues');
  assert.deepEqual(paras[1]!.lines, [28]);
  assert.deepEqual(matchPitchQuote('You live in the UK ... You bank in the UK', BCN), [38, 39], 'a quote may span two lines');
  assert.deepEqual(matchPitchQuote('nothing like this', BCN), []);
  assert.deepEqual(matchPitchQuote('that’s every 43', BCN), [4], 'curly apostrophes match straight ones');
});
