/**
 * `npm run doctor`: check this machine can run Linear Hub and say exactly what to do when it cannot.
 *
 * Checks, in order: Node version and environment, the built client, the data folder, the database file, the
 * two-step encryption key, the port, and finally a real boot of the server on a temporary database and a random
 * port (does it answer /api/health and stay up?). Exit code 1 when any check fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DB_PATH } from './db/seed.ts';
import { findPortHolder, portBusyMessage } from './lib/boot.ts';

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  status: Status;
  title: string;
  detail?: string;
}
const checks: Check[] = [];
const ICON: Record<Status, string> = { ok: '✔', warn: '▲', fail: '✖' };
function report(status: Status, title: string, detail?: string): void {
  checks.push({ status, title, detail });
  console.log(`${ICON[status]} ${title}`);
  if (detail) console.log(detail.replace(/^/gm, '    '));
}

const serverDir = path.resolve(import.meta.dirname, '..');
const repoDir = path.resolve(serverDir, '..');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
const port = Number(process.env.PORT ?? 4000);

console.log(`Linear Hub doctor — ${new Date().toISOString()}\n`);

// 1. Runtime
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 18);
  report(
    supported ? 'ok' : 'fail',
    `Node ${process.versions.node} on ${process.platform}/${process.arch} (${process.execPath})`,
    supported ? undefined : 'Linear Hub needs Node 22.18 or newer (type stripping + node:sqlite). Install the current LTS from https://nodejs.org.',
  );
  const injected = ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'VSCODE_INSPECTOR_OPTIONS']
    .filter((k) => process.env[k])
    .map((k) => `${k}=${process.env[k]}`);
  if (injected.length) {
    report(
      'warn',
      'Extra Node options are set in this terminal',
      `${injected.join('\n')}\nThese come from the shell or an editor (for example VS Code "Auto Attach") and change how every node process runs. ` +
        'If the server stops unexpectedly, try again in a plain Terminal window, or run: unset NODE_OPTIONS',
    );
  } else {
    report('ok', 'No NODE_OPTIONS injected into node processes');
  }
  try {
    const sqlite = await import('node:sqlite');
    report(typeof sqlite.DatabaseSync === 'function' ? 'ok' : 'fail', 'node:sqlite is available');
  } catch (err) {
    report('fail', 'node:sqlite is not available in this Node', String(err));
  }
}

// 2. Built client
{
  const indexHtml = path.join(repoDir, 'client', 'dist', 'index.html');
  if (existsSync(indexHtml)) {
    const built = statSync(indexHtml).mtime;
    report('ok', `Built client found (client/dist, built ${built.toISOString()})`);
  } else {
    report('fail', 'Built client missing (client/dist/index.html)', 'Run:  npm run build   then  npm start');
  }
}

// 3. Data folder
{
  const dir = path.dirname(dbPath);
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    report('ok', `Data folder is writable (${dir})`);
  } catch (err) {
    report('fail', `Data folder is not writable (${dir})`, `${String(err)}\nFix the folder permissions or point DB_PATH at a writable location.`);
  }
}

// 4. Database file
{
  if (!existsSync(dbPath)) {
    report('ok', `No database yet (${dbPath}): it is created and seeded with demo data on first start`);
  } else {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      const users = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number } | undefined;
      db.close();
      const ok = integrity?.quick_check === 'ok';
      report(
        ok ? 'ok' : 'fail',
        `Database ${dbPath} (${Math.round(statSync(dbPath).size / 1024)} kB, ${users?.n ?? '?'} users, integrity: ${integrity?.quick_check ?? 'unknown'})`,
        ok ? undefined : 'The database file is damaged. Move it aside (it is recreated and seeded on the next start).',
      );
    } catch (err) {
      report('fail', `Database ${dbPath} cannot be opened`, `${String(err)}\nMove the file aside; a fresh one is seeded on the next start.`);
    }
  }
}

// 5. Two-step verification key
{
  if (process.env.LM_APP_SECRET) {
    report('ok', 'LM_APP_SECRET is set (two-step secrets are encrypted with it)');
  } else {
    const file = process.env.LM_APP_SECRET_FILE ? path.resolve(process.env.LM_APP_SECRET_FILE) : path.join(path.dirname(dbPath), 'app-secret');
    if (!existsSync(file)) {
      report('ok', `Two-step key file not created yet (${file}): generated on first start`);
    } else {
      const mode = statSync(file).mode & 0o777;
      const tight = process.platform === 'win32' || mode === 0o600;
      report(tight ? 'ok' : 'warn', `Two-step key file ${file} (mode ${mode.toString(8)})`, tight ? undefined : `Run:  chmod 600 "${file}"`);
    }
  }
}

// 6. Port
{
  const holder = await findPortHolder(port);
  if (holder) report('fail', `Port ${port} is already in use`, portBusyMessage(port, holder));
  else report('ok', `Port ${port} is free`);
}

// 7. Boot test on a temporary database and a random port
if (process.env.LM_DOCTOR_SKIP_BOOT === '1') {
  report('warn', 'Boot test skipped (LM_DOCTOR_SKIP_BOOT=1)');
} else {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lm-doctor-'));
  const output: string[] = [];
  const startedAt = performance.now();
  const child = spawn(process.execPath, [path.join(serverDir, 'src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: '0',
      DB_PATH: path.join(tmp, 'doctor.sqlite'),
      LM_APP_SECRET_FILE: path.join(tmp, 'app-secret'),
      NODE_ENV: 'production',
      NODE_NO_WARNINGS: '1',
      TZ: 'Europe/London',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  const listening = new Promise<number | null>((resolve) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      const m = text.match(/listening on http:\/\/localhost:(\d+)/);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => resolve(null));
    setTimeout(() => resolve(null), 20_000).unref();
  });
  const bootPort = await listening;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (!bootPort) {
    report(
      'fail',
      exit ? `Server exited ${describeExit(exit)} before it was listening` : 'Server did not report "listening" within 20 s',
      `Output:\n${output.join('').trim() || '(none)'}`,
    );
  } else {
    let health = 'no response';
    try {
      const res = await fetch(`http://127.0.0.1:${bootPort}/api/health`, { signal: AbortSignal.timeout(5000) });
      health = `HTTP ${res.status}`;
    } catch (err) {
      health = `request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await sleep(3000);
    const alive = exit === null;
    report(
      alive && health === 'HTTP 200' ? 'ok' : 'fail',
      alive
        ? `Server booted on a temporary database in ${Math.round(startedAt ? performance.now() - startedAt : 0)} ms, answered /api/health (${health}) and stayed up for 3 s`
        : `Server answered /api/health (${health}) but then exited ${describeExit(exit!)} on its own`,
      alive && health === 'HTTP 200' ? undefined : `Output:\n${output.join('').trim() || '(none)'}`,
    );
  }
  if (exit === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]);
    if (exit === null) child.kill('SIGKILL');
  }
  rmSync(tmp, { recursive: true, force: true });
}

function describeExit(e: { code: number | null; signal: NodeJS.Signals | null }): string {
  return e.signal ? `on signal ${e.signal}` : `with code ${e.code}`;
}

const failed = checks.filter((c) => c.status === 'fail').length;
const warned = checks.filter((c) => c.status === 'warn').length;
console.log(`\n${failed ? `${failed} problem(s)` : 'No problems'}${warned ? `, ${warned} warning(s)` : ''}.`);
if (failed) console.log('Fix the ✖ items above, then run  npm start  again. Paste this whole report when asking for help.');
else console.log(`Everything looks fine. Run  npm start  and open http://localhost:${port}`);
process.exit(failed ? 1 : 0);
