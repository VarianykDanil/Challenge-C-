/**
 * The public first page (/welcome, and / when signed out) is seen by anyone. It must say nothing about pay
 * (pay, paydays, commission, incentives, money amounts) and nothing from the internal playbook (the six gauges,
 * the benchmarks, the law of averages, conversion ratios), and it must not explain how staff sign in.
 * This reads the page's source text, leaving out comments, so a later copy edit cannot bring them back unnoticed, and
 * what every visitor is served besides it: index.html's title and meta description, and the web app manifest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const clientSrc = new URL('../../../client/src/', import.meta.url);
const FILES = ['content/landing.ts', 'pages/Landing.tsx'];

/** The file without its comments: block comments and lines that are only a // comment. */
function codeOnly(relative: string): string {
  const text = readFileSync(fileURLToPath(new URL(relative, clientSrc)), 'utf8');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const NOT_PUBLIC: Array<[string, RegExp]> = [
  ['pay', /\bpa(y|id|ys|yday|ydays|yslip|yslips|yroll|yout|youts)\b/i],
  ['salary or wages', /\b(salary|salaries|wages?)\b/i],
  ['commission', /\bcommission/i],
  ['incentives or bonuses', /\b(incentives?|bonus(es)?)\b/i],
  ['money amounts', /£\s?\d/],
  ['G.I.R', /G\.?I\.?R\b/],
  ['wire targets', /\bwire\b/i],
  ['the gauges', /\bgauges?\b|GAUGE_/i],
  ['the benchmarks', /\bbenchmarks?\b|BENCHMARK/i],
  ['the law of averages', /law of averages|\bLOA\b/i],
  ['conversion ratios', /\bconversion\b|\bratios?\b|\bfunnel\b/i],
  ['how staff sign in', /employee ID/i],
];

for (const file of FILES) {
  test(`the public page (${file}) says nothing about pay or the internal playbook`, () => {
    const code = codeOnly(file);
    for (const [what, pattern] of NOT_PUBLIC) {
      const hit = code.match(pattern);
      assert.equal(hit, null, `${file} mentions ${what}: "${hit?.[0]}"`);
    }
  });
}

// Release check of 1.5.0: the rendered page was clean, but the served HTML's meta description (which search engines and
// link previews show) and the web app manifest (served to anyone) said "field gauges, recruitment and pay".
const clientDir = new URL('../../../client/', import.meta.url);
const SERVED: Array<[string, (text: string) => string]> = [
  // everything but the theme script and HTML comments: the title, the meta tags (description, app names)
  ['index.html', (text) => text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '')],
  // every word in it: name, description, shortcut names
  ['public/manifest.webmanifest', (text) => JSON.stringify(JSON.parse(text))],
];
for (const [file, served] of SERVED) {
  test(`what every visitor is served (${file}) says nothing about pay or the internal playbook`, () => {
    const text = served(readFileSync(fileURLToPath(new URL(file, clientDir)), 'utf8'));
    assert.ok(text.includes('Linear Hub'), `${file} was read`);
    for (const [what, pattern] of NOT_PUBLIC) {
      const hit = text.match(pattern);
      assert.equal(hit, null, `${file} mentions ${what}: "${hit?.[0]}"`);
    }
  });
}

test('the public career ladder has all eight levels of the training pack, in order', async () => {
  const { LANDING } = await import('../../../client/src/content/landing.ts');
  const titles = LANDING.careers.ladderPhases.flatMap((p) => p.levels.map((l) => l.title));
  assert.deepEqual(titles, [
    'Entry level', 'Leadership', 'Campaign Manager', 'Assistant Director',
    'Senior Director', 'Promoting Owner', 'Regional Consultant', 'National Consultant',
  ]);
  for (const phase of LANDING.careers.ladderPhases) {
    for (const level of phase.levels) {
      assert.ok(level.focus.length > 0, `${level.title} has a focus`);
      assert.ok(level.learn.length > 0, `${level.title} says what you learn`);
    }
  }
});
