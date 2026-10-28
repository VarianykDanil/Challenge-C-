/**
 * REL-10 / SEC-8: the data layer is Node's built-in node:sqlite, which Node still labels experimental. Linear Hub
 * supports only the long-term-support lines it is tested on; package.json "engines" says so, the server warns at
 * start-up on any other Node, and npm run doctor shows the Node version and what this Node says about node:sqlite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NODE_ENGINES, nodeSupport, sqliteStatus, warnIfUnsupportedNode } from '../lib/nodeSupport.ts';

const appDir = path.resolve(import.meta.dirname, '../../..');

test('supported: Node 22.18+, 24 and 26; older fails; odd or newer versions warn', () => {
  assert.equal(nodeSupport('22.17.1').status, 'fail');
  assert.equal(nodeSupport('20.11.0').status, 'fail');
  assert.equal(nodeSupport('22.18.0').status, 'ok');
  assert.equal(nodeSupport('v22.22.0').status, 'ok');
  assert.equal(nodeSupport('24.11.1').status, 'ok');
  assert.equal(nodeSupport('26.8.1').status, 'ok');
  assert.equal(nodeSupport('23.11.0').status, 'warn');
  assert.match(nodeSupport('23.11.0').message!, /not a long-term-support version/);
  assert.equal(nodeSupport('27.0.0').status, 'warn');
  assert.match(nodeSupport('27.0.0').message!, /newer than the versions Linear Hub is tested on/);
  const lines: string[] = [];
  warnIfUnsupportedNode('27.0.0', (l) => lines.push(l));
  warnIfUnsupportedNode('24.1.0', (l) => lines.push(l));
  assert.equal(lines.length, 1);
});

test('package.json "engines" says the same range in the root and every server-side package', () => {
  for (const file of ['package.json', 'server/package.json', 'shared/package.json']) {
    const pkg = JSON.parse(readFileSync(path.join(appDir, file), 'utf8')) as { engines?: { node?: string } };
    assert.equal(pkg.engines?.node, NODE_ENGINES, file);
  }
});

test('this Node: node:sqlite works, and whether Node marks it experimental is reported', () => {
  const s = sqliteStatus();
  assert.equal(s.available, true, s.error ?? '');
  assert.match(s.sqliteVersion ?? '', /^3\.\d+/);
  assert.equal(typeof s.experimental, 'boolean');
});

test('npm run doctor shows the Node version and the node:sqlite status', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'linear-doctor-node-'));
  try {
    const r = spawnSync(process.execPath, [path.join(appDir, 'server', 'src', 'doctor.ts')], {
      cwd: path.join(appDir, 'server'),
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', DB_PATH: path.join(tmp, 'linear.sqlite'), LM_APP_SECRET_FILE: path.join(tmp, 'app-secret'), LM_DOCTOR_SKIP_BOOT: '1', PORT: '0', HOME: tmp },
    });
    assert.match(r.stdout, new RegExp(`✔ Node ${process.versions.node.replace(/\./g, '\\.')} .*a supported version`));
    assert.match(r.stdout, /node:sqlite works \(SQLite 3\.\d+/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
