/**
 * Macs (and Windows) treat file names that differ only in capital letters as the same file. Linux does not, so two
 * such files can live happily in the repo and pass every check on Linux, then break the build on the owner's Mac:
 * `import ... from './TodayShift'` found `todayShift.ts` instead of `TodayShift.tsx`. Imports leave the extension
 * off, so this compares names without it too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['shared/src', 'server/src', 'client/src', 'client/sw', 'client/public', 'docs', 'deploy'];
const SKIP = new Set(['node_modules', 'dist', '.git']);

function clashes(dir: string, found: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const seenFull = new Map<string, string>();
  const seenModule = new Map<string, string>();
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const lower = name.toLowerCase();
    const before = seenFull.get(lower);
    if (before && before !== name) found.push(`${path.relative(appRoot, dir)}: ${before} / ${name}`);
    seenFull.set(lower, name);
    if (statSync(full).isDirectory()) {
      clashes(full, found);
      continue;
    }
    // what an import without an extension resolves: "Foo.tsx" and "foo.ts" are both "./foo" on a Mac
    const moduleName = lower.replace(/\.(test\.)?(tsx?|jsx?|mjs|cjs)$/, '$1');
    const other = seenModule.get(moduleName);
    if (other && other.toLowerCase() !== lower && other !== name && /\.(tsx?|jsx?|mjs|cjs)$/.test(name) && /\.(tsx?|jsx?|mjs|cjs)$/.test(other)) {
      found.push(`${path.relative(appRoot, dir)}: ${other} / ${name}`);
    }
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) seenModule.set(moduleName, name);
  }
}

test('no two files differ only in capital letters (they would be one file on a Mac)', () => {
  const found: string[] = [];
  for (const root of ROOTS) clashes(path.join(appRoot, root), found);
  assert.deepEqual(found, []);
});
