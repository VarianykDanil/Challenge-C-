// Is the checkout ready to serve: dependencies installed for the lockfile, client build newer than its sources.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { clientBuildStatus, depsStatus, recordInstalledLockfile, staleBuildMessage } from '../lib/buildStatus.ts';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A minimal checkout; every file starts at `t0` (seconds since the epoch). */
function checkout(t0: number): { root: string; touch: (rel: string, t: number) => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lm-build-status-'));
  roots.push(root);
  const touch = (rel: string, t: number) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, rel, { flag: 'a' });
    utimesSync(file, t, t);
  };
  for (const f of ['client/src/main.tsx', 'client/src/pages/Quick.tsx', 'client/index.html', 'shared/src/types.ts', 'package-lock.json']) touch(f, t0);
  return { root, touch };
}

describe('clientBuildStatus', () => {
  it('reports a missing build as stale, with a message naming npm run build', () => {
    const { root } = checkout(1_000_000);
    const s = clientBuildStatus(root);
    assert.equal(s.built, false);
    assert.equal(s.stale, true);
    assert.match(staleBuildMessage(s) ?? '', /npm run build/);
  });

  it('is current when the build is newer than every source', () => {
    const { root, touch } = checkout(1_000_000);
    touch('client/dist/index.html', 1_000_100);
    const s = clientBuildStatus(root);
    assert.equal(s.stale, false);
    assert.equal(staleBuildMessage(s), null);
  });

  it('is stale when a client file changed after the build (a git pull), and names it', () => {
    const { root, touch } = checkout(1_000_000);
    touch('client/dist/index.html', 1_000_100);
    touch('client/src/pages/Quick.tsx', 1_000_500);
    const s = clientBuildStatus(root);
    assert.equal(s.stale, true);
    assert.equal(s.newest?.file, path.join('client', 'src', 'pages', 'Quick.tsx'));
    assert.match(staleBuildMessage(s) ?? '', /out of date/);
  });

  it('counts shared code and a fresh install as client sources, but not a lockfile timestamp or files in client/dist', () => {
    const shared = checkout(1_000_000);
    shared.touch('client/dist/index.html', 1_000_100);
    shared.touch('shared/src/types.ts', 1_000_200);
    assert.equal(clientBuildStatus(shared.root).stale, true);

    const installed = checkout(1_000_000);
    installed.touch('client/dist/index.html', 1_000_100);
    installed.touch('node_modules/.package-lock.json', 1_000_200);
    assert.equal(clientBuildStatus(installed.root).stale, true, 'packages installed after the build');

    const restored = checkout(1_000_000);
    restored.touch('client/dist/index.html', 1_000_100);
    restored.touch('package-lock.json', 1_000_200); // git restore: new timestamp, nothing installed
    assert.equal(clientBuildStatus(restored.root).stale, false);

    const dist = checkout(1_000_000);
    dist.touch('client/dist/index.html', 1_000_100);
    dist.touch('client/dist/assets/index-abc.js', 1_000_900);
    assert.equal(clientBuildStatus(dist.root).stale, false);
  });

  it('ignores an edit within a second of the build (coarse file-system clocks)', () => {
    const { root, touch } = checkout(1_000_000);
    touch('client/dist/index.html', 1_000_100);
    touch('client/src/main.tsx', 1_000_100.5);
    assert.equal(clientBuildStatus(root).stale, false);
  });
});

describe('depsStatus', () => {
  it('is stale when node_modules was never installed', () => {
    const { root } = checkout(1_000_000);
    assert.deepEqual(depsStatus(root), { installed: false, stale: true });
  });

  it('without a fingerprint, compares timestamps: current after an install, stale once package-lock.json is newer', () => {
    const { root, touch } = checkout(1_000_000);
    touch('node_modules/.package-lock.json', 1_000_100);
    assert.deepEqual(depsStatus(root), { installed: true, stale: false });
    touch('package-lock.json', 1_000_300);
    assert.deepEqual(depsStatus(root), { installed: true, stale: true });
  });

  it('with a fingerprint, compares content: a re-checked-out identical lockfile is current, a changed one is stale', () => {
    const { root, touch } = checkout(1_000_000);
    touch('node_modules/.package-lock.json', 1_000_100);
    recordInstalledLockfile(root);
    utimesSync(path.join(root, 'package-lock.json'), 1_000_900, 1_000_900); // newer timestamp, same bytes
    assert.deepEqual(depsStatus(root), { installed: true, stale: false });
    touch('package-lock.json', 1_000_950); // appends: different content
    assert.deepEqual(depsStatus(root), { installed: true, stale: true });
  });
});
