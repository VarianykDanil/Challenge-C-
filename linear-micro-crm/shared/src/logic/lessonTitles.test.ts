// Release 1.2 (UC): the server's lesson titles are the lessons' own titles (client/src/content/learning), so an audit
// summary names a lesson exactly as its page does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_KEYS, type LessonKey } from '../types/learning.ts';
import { LESSON_TITLES, lessonTitle } from './lessonTitles.ts';

test('a title for every lesson key, and nothing else', () => {
  assert.deepEqual(Object.keys(LESSON_TITLES).sort(), [...LESSON_KEYS].sort());
  for (const key of LESSON_KEYS) assert.ok(LESSON_TITLES[key].trim().length > 0, key);
});

test('lessonTitle: the title for a lesson key, null for anything else', () => {
  assert.equal(lessonTitle('pre-emptive-strike'), 'Pre-emptive strike');
  assert.equal(lessonTitle('can-cant-controls'), 'Can and can’t controls');
  assert.equal(lessonTitle('five-steps'), '5 steps to a conversation');
  assert.equal(lessonTitle('feel-felt-found'), null);
  assert.equal(lessonTitle('toString'), null);
  assert.equal(lessonTitle(''), null);
  assert.equal(lessonTitle(undefined), null);
  assert.equal(lessonTitle(42), null);
});

test('the titles match the lessons’ own titles (client/src/content/learning), so the two never drift', async () => {
  // Loaded at run time (Node strips the types); a computed URL keeps the client files out of this package's typecheck.
  const url = new URL('../../../client/src/content/learning/index.ts', import.meta.url).href;
  const content = (await import(url)) as { LESSONS: Record<LessonKey, { key: LessonKey; title: string }> };
  assert.deepEqual(Object.keys(content.LESSONS).sort(), [...LESSON_KEYS].sort());
  for (const key of LESSON_KEYS) {
    const lesson = content.LESSONS[key];
    assert.equal(lesson.key, key);
    assert.equal(LESSON_TITLES[key], lesson.title, `${key}: the title in shared/src/logic/lessonTitles.ts`);
  }
});
