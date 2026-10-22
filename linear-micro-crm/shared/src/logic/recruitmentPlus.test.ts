// P7 recruitment-plus: hand-computed fixtures for the age rules, the change and stage wording, the timeline order, the
// sheet counts (the only maths: a mean of 1–5 scores to one decimal place), the schedule's ranges and day groups, and
// the question bank's protected-topic check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageOn,
  answerChangedLabel,
  buildCandidateTimeline,
  businessWhenLabel,
  dateOfBirthProblem,
  dayLabel,
  draftSheetQuestions,
  groupScheduleByDay,
  interviewChangeLabels,
  interviewChangeText,
  interviewDay,
  isUnderAge,
  mergeSheetRows,
  newSheetRow,
  normaliseQuestionText,
  questionTopicWarning,
  sameAnswer,
  scheduleRange,
  sheetConflictMessage,
  sheetEditRows,
  sheetLeftConflictMessage,
  sheetQuestionKey,
  sheetSavePayload,
  sheetSummary,
  stageChangeText,
  validScore,
} from './recruitmentPlus.ts';
import type { InterviewAnswer } from '../types/recruitmentPlus.ts';

test('ageOn: whole years, the birthday itself counts, leap-day birthdays turn over on 1 March', () => {
  assert.equal(ageOn('2008-10-23', '2026-10-22'), 17, 'birthday tomorrow');
  assert.equal(ageOn('2008-10-22', '2026-10-22'), 18, 'birthday today');
  assert.equal(ageOn('2008-02-29', '2026-02-28'), 17);
  assert.equal(ageOn('2008-02-29', '2026-03-01'), 18);
  assert.equal(ageOn('2001-12-31', '2026-01-01'), 24);
  assert.equal(ageOn('2026-10-23', '2026-10-22'), null, 'not born yet');
  assert.equal(ageOn('2026-02-30', '2026-10-22'), null, 'not a real date');
  assert.equal(isUnderAge('2008-10-23', '2026-10-22'), true);
  assert.equal(isUnderAge('2008-10-22', '2026-10-22'), false);
  assert.equal(isUnderAge('nonsense', '2026-10-22'), false);
});

test('dateOfBirthProblem: real dates, not in the future, 14 to 100 years old', () => {
  const today = '2026-10-22';
  assert.equal(dateOfBirthProblem('2001-03-12', today), null);
  assert.equal(dateOfBirthProblem('2009-01-01', today), null, 'under 18 is allowed (the profile warns)');
  assert.equal(dateOfBirthProblem('2012-10-22', today), null, 'exactly 14');
  assert.match(dateOfBirthProblem('2012-10-23', today)!, /makes them 13/);
  assert.match(dateOfBirthProblem('2015-06-01', today)!, /makes them 11\. Check the year/);
  assert.equal(dateOfBirthProblem('1926-10-22', today), null, 'exactly 100');
  assert.match(dateOfBirthProblem('1900-01-01', today)!, /makes them 126/);
  assert.equal(dateOfBirthProblem('2026-10-23', today), 'A date of birth cannot be in the future');
  assert.equal(dateOfBirthProblem('2001-02-29', today), 'Enter the date of birth as a real date');
  assert.equal(dateOfBirthProblem('12/03/2001', today), 'Enter the date of birth as a real date');
});

test('dayLabel and businessWhenLabel: London wall-clock words, the year only for another year', () => {
  assert.equal(dayLabel('2026-10-23'), 'Fri 23 Oct');
  assert.equal(dayLabel('2026-09-07', '2026-10-22'), 'Mon 7 Sep');
  assert.equal(dayLabel('2025-12-31', '2026-10-22'), 'Wed 31 Dec 2025');
  // 22 Oct 2026 is British Summer Time (UTC+1); 1 Dec is GMT.
  assert.equal(businessWhenLabel('2026-10-22T09:00:00.000Z'), 'Thu 22 Oct, 10:00');
  assert.equal(businessWhenLabel('2026-12-01T09:00:00.000Z'), 'Tue 1 Dec, 09:00');
  assert.equal(businessWhenLabel('2026-12-01T09:00:00.000Z', '2027-01-05'), 'Tue 1 Dec 2026, 09:00');
  // The clocks go back at 02:00 BST on Sun 25 Oct 2026: 00:30Z is 01:30 BST, 01:30Z is 01:30 GMT.
  assert.equal(businessWhenLabel('2026-10-25T00:30:00.000Z'), 'Sun 25 Oct, 01:30');
  assert.equal(businessWhenLabel('2026-10-25T01:30:00.000Z'), 'Sun 25 Oct, 01:30');
  assert.equal(businessWhenLabel('2026-10-21T23:30:00.000Z'), 'Thu 22 Oct, 00:30', 'just after midnight in London is the next day');
  assert.equal(businessWhenLabel('not a time'), 'not a time');
});

const NAMES = new Map([[5, 'Amelia Hart'], [7, 'Rhys Morgan']]);
const nameOf = (id: number) => NAMES.get(id) ?? null;

test('interview changes in words: who changed what, from and to', () => {
  const text = (field: Parameters<typeof interviewChangeLabels>[0]['field'], fromValue: string | null, toValue: string | null, type: 'phone' | 'first' = 'first', by: string | null = 'Priya Shah') =>
    interviewChangeText({ field, ...interviewChangeLabels({ field, fromValue, toValue }, { nameOf }), changedByName: by }, type);
  assert.equal(text('interviewer', '5', '7'), 'First interview: interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah');
  assert.equal(text('interviewer', null, '7'), 'First interview: Rhys Morgan set as the interviewer by Priya Shah');
  assert.equal(text('interviewer', '5', null), 'First interview: Amelia Hart taken off as the interviewer by Priya Shah');
  assert.equal(text('interviewer', '99', '7'), 'First interview: interviewer changed from a former colleague to Rhys Morgan by Priya Shah');
  assert.equal(
    text('scheduled_at', '2026-10-22T09:00:00.000Z', '2026-10-23T13:00:00.000Z', 'phone'),
    'Phone screen moved from Thu 22 Oct, 10:00 to Fri 23 Oct, 14:00 by Priya Shah',
  );
  assert.equal(text('booked', null, '2026-10-22T09:00:00.000Z'), 'First interview booked for Thu 22 Oct, 10:00 by Priya Shah');
  assert.equal(text('booked', null, '2026-10-22T09:00:00.000Z', 'first', null), 'First interview booked for Thu 22 Oct, 10:00');
  assert.equal(text('type', 'phone', 'first'), 'Phone screen changed to first interview by Priya Shah');
  assert.equal(text('outcome', 'pending', 'passed', 'first', 'Amelia Hart'), 'First interview outcome recorded as passed by Amelia Hart');
  assert.equal(text('outcome', 'passed', 'no_show', 'first', 'Amelia Hart'), 'First interview outcome changed from passed to no show by Amelia Hart');
});

test('stage moves in words: added, forward, back, closed, reopened, hired', () => {
  const t = (fromStage: Parameters<typeof stageChangeText>[0]['fromStage'], toStage: Parameters<typeof stageChangeText>[0]['toStage'], by: string | null = 'Priya Shah') =>
    stageChangeText({ fromStage, toStage, changedByName: by }, 'trainee');
  assert.equal(t(null, 'applied'), 'Applied for the Trainee position (added by Priya Shah)');
  assert.equal(t(null, 'applied', null), 'Applied for the Trainee position');
  assert.equal(t('applied', 'screening'), 'Moved from Applied to Phone screen by Priya Shah');
  assert.equal(t('observation', 'interview'), 'Moved back from Observation day to Interview by Priya Shah');
  assert.equal(t('interview', 'rejected'), 'Rejected at Interview by Priya Shah');
  assert.equal(t('offer', 'withdrawn'), 'Withdrew at Offer (recorded by Priya Shah)');
  assert.equal(t('offer', 'hired', 'Danil Varianyk'), 'Hired by Danil Varianyk');
  assert.equal(t('rejected', 'offer', 'Danil Varianyk'), 'Reopened at Offer by Danil Varianyk');
});

test('buildCandidateTimeline: every stage, interview and change, newest first, ties in the story order', () => {
  const items = buildCandidateTimeline({
    positionApplied: 'trainee',
    today: '2026-10-22',
    nameOf,
    stageChanges: [
      { id: 1, fromStage: null, toStage: 'applied', changedAt: '2026-10-01T08:00:00.000Z', changedById: null, changedByName: null, note: null },
      { id: 2, fromStage: 'applied', toStage: 'screening', changedAt: '2026-10-02T09:00:00.000Z', changedById: 3, changedByName: 'Priya Shah', note: 'Strong CV' },
      { id: 3, fromStage: 'screening', toStage: 'interview', changedAt: '2026-10-06T14:00:00.000Z', changedById: 3, changedByName: 'Priya Shah', note: null },
    ],
    interviews: [
      { id: 10, type: 'phone', scheduledAt: '2026-10-06T13:00:00.000Z', interviewerId: 7, interviewerName: 'Rhys Morgan', outcome: 'passed', notes: 'Clear and keen' },
      { id: 11, type: 'first', scheduledAt: '2026-10-27T10:00:00.000Z', interviewerId: 5, interviewerName: 'Amelia Hart', outcome: 'pending', notes: null },
    ],
    changes: [
      { id: 100, interviewId: 10, field: 'booked', fromValue: null, toValue: '2026-10-05T10:00:00.000Z', changedBy: 3, changedByName: 'Priya Shah', changedAt: '2026-10-02T09:05:00.000Z' },
      { id: 101, interviewId: 10, field: 'scheduled_at', fromValue: '2026-10-05T10:00:00.000Z', toValue: '2026-10-06T13:00:00.000Z', changedBy: 3, changedByName: 'Priya Shah', changedAt: '2026-10-04T16:00:00.000Z' },
      { id: 102, interviewId: 10, field: 'interviewer', fromValue: '5', toValue: '7', changedBy: 3, changedByName: 'Priya Shah', changedAt: '2026-10-04T16:00:00.000Z' },
      { id: 103, interviewId: 10, field: 'outcome', fromValue: 'pending', toValue: 'passed', changedBy: 7, changedByName: 'Rhys Morgan', changedAt: '2026-10-06T14:00:00.000Z' },
      { id: 104, interviewId: 99, field: 'booked', fromValue: null, toValue: '2026-10-07T10:00:00.000Z', changedBy: 3, changedByName: 'Priya Shah', changedAt: '2026-10-06T15:00:00.000Z' },
    ],
  });
  assert.deepEqual(
    items.map((i) => [i.at, i.kind, i.text]),
    [
      ['2026-10-27T10:00:00.000Z', 'interview', 'First interview with Amelia Hart'],
      // 14:00 on 6 Oct: the outcome, then the stage move made at the same instant (outcome ranks above stage)
      ['2026-10-06T14:00:00.000Z', 'outcome', 'Phone screen outcome recorded as passed by Rhys Morgan'],
      ['2026-10-06T14:00:00.000Z', 'stage', 'Moved from Phone screen to Interview by Priya Shah'],
      ['2026-10-06T13:00:00.000Z', 'interview', 'Phone screen with Rhys Morgan'],
      // the same instant: interviewer (id 102) above the reschedule (id 101), both rank 3
      ['2026-10-04T16:00:00.000Z', 'interviewer', 'Phone screen: interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah'],
      ['2026-10-04T16:00:00.000Z', 'reschedule', 'Phone screen moved from Mon 5 Oct, 11:00 to Tue 6 Oct, 14:00 by Priya Shah'],
      ['2026-10-02T09:05:00.000Z', 'booked', 'Phone screen booked for Mon 5 Oct, 11:00 by Priya Shah'],
      ['2026-10-02T09:00:00.000Z', 'stage', 'Moved from Applied to Phone screen by Priya Shah'],
      ['2026-10-01T08:00:00.000Z', 'applied', 'Applied for the Trainee position'],
    ],
    'a change of an interview that is not this candidate\'s (99) is left out',
  );
  const phone = items.find((i) => i.kind === 'interview' && i.interviewId === 10)!;
  assert.equal(phone.outcome, 'passed');
  assert.equal(phone.detail, 'Clear and keen');
  assert.equal(phone.byName, 'Rhys Morgan');
  assert.equal(items.find((i) => i.at === '2026-10-02T09:00:00.000Z')!.detail, 'Strong CV');
});

test('sheetSummary: answered, scored and the mean score to one decimal place (half up)', () => {
  const row = (answer: string, score: number | null) => ({ answer, score });
  assert.deepEqual(sheetSummary([row('Yes', 4), row('', 5), row('   ', null), row('ok', 3), row('x', 7)]), { questions: 5, answered: 3, scored: 3, averageScore: 4 }, '(4 + 5 + 3) / 3 = 4; a 7 is not a score');
  assert.equal(sheetSummary([row('a', 4), row('b', 5)]).averageScore, 4.5);
  assert.equal(sheetSummary([row('a', 4), row('b', 4), row('c', 5)]).averageScore, 4.3, '13 / 3 = 4.333…');
  assert.equal(sheetSummary([row('a', 3), row('b', 4), row('c', 4), row('d', 4)]).averageScore, 3.8, '15 / 4 = 3.75 rounds up');
  assert.equal(sheetSummary([row('a', 4), row('b', 4), row('c', 4), row('d', 5)]).averageScore, 4.3, '17 / 4 = 4.25 rounds up');
  assert.equal(sheetSummary([row('a', 1), row('b', 2)]).averageScore, 1.5);
  assert.deepEqual(sheetSummary([row('a', null)]), { questions: 1, answered: 1, scored: 0, averageScore: null });
  assert.deepEqual(sheetSummary([]), { questions: 0, answered: 0, scored: 0, averageScore: null });
  assert.equal(validScore(2.5), null);
  assert.equal(validScore(0), null);
  assert.equal(validScore(5), 5);
});

test('draftSheetQuestions: active questions of the type, for every position or this one, in order', () => {
  const q = (id: number, interviewType: 'phone' | 'first', position: 'trainee' | 'field_rep' | null, sort: number, active = true) => ({ id, interviewType, position, sort, active });
  const bank = [q(1, 'first', null, 2), q(2, 'first', 'field_rep', 1), q(3, 'first', 'trainee', 3), q(4, 'phone', null, 0), q(5, 'first', null, 0, false), q(6, 'first', null, 2)];
  assert.deepEqual(draftSheetQuestions(bank, 'first', 'trainee').map((x) => x.id), [1, 6, 3], 'sort 2 (ids 1, 6), then sort 3; inactive and other positions left out');
  assert.deepEqual(draftSheetQuestions(bank, 'first', 'field_rep').map((x) => x.id), [2, 1, 6]);
  assert.deepEqual(draftSheetQuestions(bank, 'phone', null).map((x) => x.id), [4]);
});

test('questionTopicWarning: protected topics are flagged, ordinary job questions are not', () => {
  assert.equal(questionTopicWarning('How old are you?'), 'age');
  assert.equal(questionTopicWarning('When were you born?'), 'age');
  assert.equal(questionTopicWarning('Do you have any children?'), 'family');
  assert.equal(questionTopicWarning('Are you married?'), 'family');
  assert.equal(questionTopicWarning('Any health conditions we should know about?'), 'health');
  assert.equal(questionTopicWarning('Do you go to church on Sundays?'), 'religion');
  assert.equal(questionTopicWarning('Where are you from originally?'), 'nationality or race');
  assert.equal(questionTopicWarning('How would you keep to health and safety rules on site?'), null);
  assert.equal(questionTopicWarning('Which days and hours could you work each week?'), null);
  assert.equal(questionTopicWarning('Tell me about a time you persuaded someone to change their mind.'), null);
  assert.equal(questionTopicWarning('What made you apply to work with Linear?'), null);
});

test('questionTopicWarning: no false alarms on the agency\'s own clients and ordinary words; first language is flagged (review fixes)', () => {
  assert.equal(questionTopicWarning("What do you know about Children's Hospice North?"), null, 'CHN is one of the clients');
  assert.equal(questionTopicWarning('What do you know about Children’s Hospice North?'), null, 'with a curly apostrophe');
  assert.equal(questionTopicWarning("Could you pitch for our children's charity?"), null);
  assert.equal(questionTopicWarning("Which children's charities have you heard of?"), null);
  assert.equal(questionTopicWarning('Are you faithful to a script, or do you make it your own?'), null, 'faithful is not faith');
  assert.equal(questionTopicWarning('How old is your car?'), null, 'only "how old are you" asks an age');
  assert.equal(questionTopicWarning('What is your first language?'), 'nationality or race');
  assert.equal(questionTopicWarning("What's your mother tongue?"), 'nationality or race');
  // Still flagged.
  assert.equal(questionTopicWarning('How old are you now?'), 'age');
  assert.equal(questionTopicWarning('How old will you be next year?'), 'age');
  assert.equal(questionTopicWarning('Do your children go to school nearby?'), 'family');
  assert.equal(questionTopicWarning('What faith are you?'), 'religion');
  assert.equal(questionTopicWarning('Does your faith stop you working Fridays?'), 'religion');
  assert.equal(questionTopicWarning('Do you pray during the day?'), 'religion');
});

test('questionTopicWarning: pregnancy, a partner, school-leaving year and a second language are flagged (re-review)', () => {
  assert.equal(questionTopicWarning('Are you planning to have a baby?'), 'family');
  assert.equal(questionTopicWarning('Any babies on the way?'), 'family');
  assert.equal(questionTopicWarning('Do you have a partner?'), 'family');
  assert.equal(questionTopicWarning('Does your partner mind weekend work?'), 'family');
  assert.equal(questionTopicWarning('Do you live with a partner?'), 'family');
  assert.equal(questionTopicWarning('What does your spouse do?'), 'family');
  assert.equal(questionTopicWarning('What year did you leave school?'), 'age');
  assert.equal(questionTopicWarning('When did you finish college?'), 'age');
  assert.equal(questionTopicWarning('What is your graduation year?'), 'age');
  assert.equal(questionTopicWarning('Is English your second language?'), 'nationality or race');
  assert.equal(questionTopicWarning("English isn't your first language, is it?"), 'nationality or race');
  // Not about anyone's family, age or origin.
  assert.equal(questionTopicWarning('What do you know about our partner charities?'), null);
  assert.equal(questionTopicWarning('How would you work in partnership with a venue manager?'), null);
  assert.equal(questionTopicWarning('Tell me about a partner you worked with on a project.'), null);
  assert.equal(questionTopicWarning('When did you leave your last job, and why?'), null);
  assert.equal(questionTopicWarning('Do you speak any other languages that would help on the street?'), null);
});

test('scheduleRange: today, this week and next week (Monday to Sunday)', () => {
  assert.deepEqual(scheduleRange('today', '2026-10-22'), { from: '2026-10-22', to: '2026-10-22' });
  assert.deepEqual(scheduleRange('this_week', '2026-10-22'), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(scheduleRange('next_week', '2026-10-22'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(scheduleRange('this_week', '2026-10-25'), { from: '2026-10-19', to: '2026-10-25' }, 'a Sunday is the end of its week');
});

test('groupScheduleByDay: London days in order, each by time', () => {
  const items = [
    { id: 1, scheduledAt: '2026-10-22T13:00:00.000Z' },
    { id: 2, scheduledAt: '2026-10-21T23:30:00.000Z' }, // 00:30 on 22 Oct in London
    { id: 3, scheduledAt: '2026-10-21T09:00:00.000Z' },
    { id: 4, scheduledAt: '2026-10-22T08:00:00.000Z', day: '2026-10-22' },
  ];
  assert.equal(interviewDay('2026-10-21T23:30:00.000Z'), '2026-10-22');
  assert.deepEqual(groupScheduleByDay(items).map((g) => [g.day, g.items.map((i) => i.id)]), [['2026-10-21', [3]], ['2026-10-22', [2, 4, 1]]]);
});

test('normaliseQuestionText: trimmed, one space between words', () => {
  assert.equal(normaliseQuestionText('  What made\n you   apply? '), 'What made you apply?');
});

// ───────────────────────────── one sheet on two devices (review fixes) ─────────────────────────────

const stored = (questionId: number | null, questionText: string, answer: string, score: number | null = null, by = 'Lee Leader'): InterviewAnswer => ({
  interviewId: 1, id: (questionId ?? 90) + 1000, questionId, questionText, answer, score, updatedAt: answer || score ? '2026-10-22T09:42:00.000Z' : null, updatedByName: answer || score ? by : null,
});
const draft = (questionId: number, questionText: string): InterviewAnswer => ({ interviewId: 1, questionId, questionText, answer: '', score: null, updatedAt: null });

test('sheetQuestionKey and sameAnswer: bank questions by id, own questions by their words; spaces at the ends do not count', () => {
  assert.equal(sheetQuestionKey(7, 'Anything'), 'q7');
  assert.equal(sheetQuestionKey(null, '  Can you do   Saturdays? '), 'own:can you do saturdays?');
  assert.equal(sameAnswer({ answer: 'Yes ', score: 3 }, { answer: 'Yes', score: 3 }), true);
  assert.equal(sameAnswer({ answer: 'Yes', score: 3 }, { answer: 'Yes', score: null }), false);
});

test('sheetSavePayload: the whole draft on the first save; then only what changed here, removals, and never a question in conflict', () => {
  const rows = sheetEditRows({ answers: [draft(1, 'Q one'), draft(2, 'Q two'), draft(3, 'Q three')] });
  assert.ok(rows.every((r) => !r.stored));
  rows[0]!.answer = 'Typed';
  const first = sheetSavePayload(rows, [], false);
  assert.deepEqual(first.map((r) => [r.questionId, r.answer, r.base]), [[1, 'Typed', { answer: '', score: null }], [2, '', { answer: '', score: null }], [3, '', { answer: '', score: null }]]);

  const saved = sheetEditRows({ answers: [stored(1, 'Q one', 'Typed'), stored(2, 'Q two', ''), stored(3, 'Q three', '')] });
  assert.deepEqual(sheetSavePayload(saved, [], true), [], 'nothing changed: nothing to send');
  saved[1]!.score = 4;
  const own = newSheetRow('  Can you do Saturdays?  ');
  const removed = saved.splice(2, 1);
  const later = sheetSavePayload([...saved, own], removed, true);
  assert.deepEqual(later, [
    { questionId: 2, questionText: 'Q two', answer: '', score: 4, base: { answer: '', score: null } },
    { questionId: null, questionText: 'Can you do Saturdays?', answer: '', score: null, base: { answer: '', score: null } },
    { questionId: 3, questionText: 'Q three', answer: '', score: null, base: { answer: '', score: null }, removed: true },
  ]);
  saved[1]!.conflict = { answer: 'Theirs', score: null, byName: 'Rhys Morgan', at: null };
  assert.deepEqual(sheetSavePayload(saved, [], true), [], 'a conflict waits for the choice');
});

test('mergeSheetRows: takes in other devices\' words where nothing was typed here, keeps typing, flags real conflicts', () => {
  // This device: Q1 typed and saved as "Mine" (sent), Q2 untouched, Q3 typed after the save went ("Mine, more"), Q4 typed (not sent).
  const local = sheetEditRows({ answers: [stored(1, 'Q one', ''), stored(2, 'Q two', ''), stored(3, 'Q three', ''), stored(4, 'Q four', 'Old')] });
  local[0]!.answer = 'Mine';
  local[2]!.answer = 'Mine, more';
  local[3]!.answer = 'Mine too';
  const sent = new Map([['q1', { answer: 'Mine', score: null }], ['q3', { answer: 'Mine', score: null }]]);
  const server = {
    saved: true,
    answers: [stored(1, 'Q one', 'Mine', null, 'Priya Shah'), stored(2, 'Q two', 'Theirs', 5, 'Rhys Morgan'), stored(3, 'Q three', 'Mine', null, 'Priya Shah'), stored(4, 'Q four', 'Theirs four', null, 'Rhys Morgan'), stored(null, 'Their own question', 'Yes')],
  };
  const merged = mergeSheetRows(local, server, { sent });
  const view = merged.map((r) => [r.key, r.answer, r.score, r.base.answer, r.conflict?.answer ?? null]);
  assert.deepEqual(view, [
    ['q1', 'Mine', null, 'Mine', null], // in step
    ['q2', 'Theirs', 5, 'Theirs', null], // another device's words taken in
    ['q3', 'Mine, more', null, 'Mine', null], // this device's save landed; typing kept
    ['q4', 'Mine too', null, 'Old', 'Theirs four'], // both changed it: a conflict, nothing lost
    ['own:their own question', 'Yes', null, 'Yes', null], // added on another device
  ]);
  assert.equal(merged[1]!.updatedByName, 'Rhys Morgan');
  assert.equal(merged[3]!.conflict!.byName, 'Rhys Morgan');
  // Merging the same answer again changes nothing (a refetch after the save).
  assert.deepEqual(mergeSheetRows(merged, server).map((r) => [r.key, r.answer, r.base.answer, r.conflict?.answer ?? null]), view.map((v) => [v[0], v[1], v[3], v[4]]));
});

test('sheetSavePayload: the device id and save number on every item; a question changed since the save on its way goes, even back to its base', () => {
  const rows = sheetEditRows({ answers: [stored(1, 'Q one', ''), stored(2, 'Q two', ''), stored(3, 'Q three', '')] });
  rows[0]!.answer = 'First part and the rest';
  // Question 2 was typed ("Typed"), went in the save on its way, then rubbed out: back to its base, but it must go.
  const inFlight = new Map([['q1', { answer: 'First part', score: null }], ['q2', { answer: 'Typed', score: null }]]);
  const out = sheetSavePayload(rows, [rows[2]!], true, { inFlight, from: { device: 'tab-abc12345', version: 2 } });
  assert.deepEqual(out, [
    { questionId: 1, questionText: 'Q one', answer: 'First part and the rest', score: null, base: { answer: '', score: null }, device: 'tab-abc12345', version: 2 },
    { questionId: 2, questionText: 'Q two', answer: '', score: null, base: { answer: '', score: null }, device: 'tab-abc12345', version: 2 },
    { questionId: 3, questionText: 'Q three', answer: '', score: null, base: { answer: '', score: null }, removed: true, device: 'tab-abc12345', version: 2 },
  ]);
  rows[1]!.answer = 'Typed';
  rows[0]!.answer = 'First part';
  rows[0]!.base = { answer: 'First part', score: null };
  rows[1]!.base = { answer: 'Typed', score: null };
  assert.deepEqual(sheetSavePayload(rows, [], true, { inFlight }), [], 'in step with what is on its way: nothing more to send');
});

test('mergeSheetRows: a row this tab wrote (its device id) is never another device\'s change: typing since is kept, base moves on', () => {
  const mine = (questionId: number, text: string, answer: string, device: string | null) => ({ ...stored(questionId, text, answer, null, 'Priya Shah'), device });
  // The sheet was opened again in this tab while the last save was still on its way: question 2 shows what was typed
  // before, plus more; then that save lands (stamped with this tab's id).
  const local = sheetEditRows({ answers: [stored(1, 'Q one', ''), stored(2, 'Q two', ''), stored(3, 'Q three', '')] });
  local[1]!.answer = 'Started on Q2, and finished the thought';
  local[2]!.answer = 'Mine on Q3';
  const server = { saved: true, answers: [mine(1, 'Q one', '', 'tab-mine-0001'), mine(2, 'Q two', 'Started on Q2', 'tab-mine-0001'), mine(3, 'Q three', 'Theirs on Q3', 'tab-other-0002')] };
  const merged = mergeSheetRows(local, server, { own: new Set(['tab-mine-0001']) });
  assert.deepEqual(merged.map((r) => [r.key, r.answer, r.base.answer, r.conflict?.answer ?? null]), [
    ['q1', '', '', null],
    ['q2', 'Started on Q2, and finished the thought', 'Started on Q2', null], // own save: no conflict, the next save goes on top
    ['q3', 'Mine on Q3', '', 'Theirs on Q3'], // another tab: a real conflict
  ]);
  // Without knowing its own id, question 2 would be taken for another device's change.
  assert.equal(mergeSheetRows(local, server).find((r) => r.key === 'q2')!.conflict?.answer, 'Started on Q2');
  // Typed, sent, then rubbed out back to the old words: the stored own save does not come back into the box.
  const rubbed = sheetEditRows({ answers: [stored(1, 'Q one', '')] });
  const merged2 = mergeSheetRows(rubbed, { saved: true, answers: [mine(1, 'Q one', 'Typed', 'tab-mine-0001')] }, { own: new Set(['tab-mine-0001']) });
  assert.deepEqual([merged2[0]!.answer, merged2[0]!.base.answer], ['', 'Typed']);
});

test('mergeSheetRows: a question in conflict keeps its own "last changed" line; the conflict says who wrote the other version (re-review)', () => {
  const local = sheetEditRows({ answers: [stored(1, 'Q one', 'Old', null, 'Priya Shah')] });
  local[0]!.answer = 'Priya, typed since';
  const theirs = { ...stored(1, 'Q one', 'Amelia, from the phone', null, 'Amelia Hart'), updatedAt: '2026-10-22T10:05:00.000Z' };
  const [row] = mergeSheetRows(local, { saved: true, answers: [theirs] });
  assert.equal(row!.conflict?.byName, 'Amelia Hart');
  assert.equal(row!.conflict?.at, '2026-10-22T10:05:00.000Z');
  assert.equal(row!.updatedByName, 'Priya Shah', 'not "Last changed by Amelia Hart" under Priya\'s own words');
});

test('sheetLeftConflictMessage: one sentence naming the question (and who), for a page left with a conflict open', () => {
  assert.equal(sheetLeftConflictMessage([{ number: 3, byName: 'Amelia Hart' }]), 'Your answer to question 3 was not saved: Amelia Hart changed it on another device. Open the sheet to choose which to keep.');
  assert.equal(sheetLeftConflictMessage([{ number: 2, byName: null }]), 'Your answer to question 2 was not saved: someone changed it on another device. Open the sheet to choose which to keep.');
  assert.equal(sheetLeftConflictMessage([{ number: 5, byName: 'A' }, { number: 2, byName: 'B' }]), 'Your answers to questions 2 and 5 were not saved: they were changed on another device. Open the sheet to choose which to keep.');
});

test('mergeSheetRows: questions another device took off go (unless typed into here); added and removed ones here are kept as they are', () => {
  const local = sheetEditRows({ answers: [stored(1, 'Q one', ''), stored(2, 'Q two', ''), stored(3, 'Q three', '')] });
  local[2]!.answer = 'Typed here';
  const own = newSheetRow('Can you drive?');
  const server = { saved: true, answers: [stored(1, 'Q one', '')] }; // Q2 and Q3 taken off on another device
  const merged = mergeSheetRows([...local, own], server, { removed: new Set(['q1']) });
  assert.deepEqual(merged.map((r) => [r.key, r.stored, r.added]), [['q3', false, true], ['own:can you drive?', false, true]], 'q1 is being taken off here; q2 went; q3 and the new question stay');
});

test('mergeSheetRows on a draft: the bank\'s latest draft while nothing was touched here, else this device\'s rows', () => {
  const local = sheetEditRows({ answers: [draft(1, 'Q one'), draft(2, 'Q two')] });
  const server = { saved: false, answers: [draft(1, 'Q one'), draft(5, 'Q five')] };
  assert.deepEqual(mergeSheetRows(local, server).map((r) => r.key), ['q1', 'q5']);
  local[0]!.answer = 'Started';
  assert.deepEqual(mergeSheetRows(local, server).map((r) => r.key), ['q1', 'q2']);
});

test('sheetConflictMessage: one question names who changed it; several are listed', () => {
  assert.equal(sheetConflictMessage([{ number: 3, byName: 'Rhys Morgan' }]), 'Question 3 was changed by Rhys Morgan on another device. Choose which answer to keep.');
  assert.equal(sheetConflictMessage([{ number: 3, byName: null }]), 'Question 3 was changed on another device. Choose which answer to keep.');
  assert.equal(sheetConflictMessage([{ number: 5, byName: 'A' }, { number: 2, byName: 'B' }]), 'Questions 2 and 5 were changed on another device. Choose which answers to keep.');
  assert.equal(sheetConflictMessage([{ number: 1, byName: 'A' }, { number: 2, byName: 'B' }, { number: 4, byName: 'B' }]), 'Questions 1, 2 and 4 were changed on another device. Choose which answers to keep.');
});

test('answerChangedLabel: who last changed an answer and when, in London time', () => {
  assert.equal(answerChangedLabel({ updatedAt: '2026-10-22T09:42:00.000Z', updatedByName: 'Rhys Morgan' }, '2026-10-22'), 'Last changed by Rhys Morgan, Thu 22 Oct, 10:42');
  assert.equal(answerChangedLabel({ updatedAt: '2025-12-01T15:05:00.000Z', updatedByName: null }, '2026-10-22'), 'Last changed, Mon 1 Dec 2025, 15:05');
  assert.equal(answerChangedLabel({ updatedAt: null, updatedByName: 'Rhys Morgan' }, '2026-10-22'), null);
});
