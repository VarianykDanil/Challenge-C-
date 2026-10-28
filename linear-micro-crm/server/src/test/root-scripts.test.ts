// The commands in the docs are typed in the top folder (`npm run backup -- --new-passphrase <file>`). A top-level
// script that hands over to the server's script must end with `--`, or npm keeps options such as --new-passphrase
// for itself and the server command never sees them.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..'); // linear-micro-crm/
const rootScripts: Record<string, string> = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const serverScripts: Record<string, string> = JSON.parse(readFileSync(path.join(root, 'server/package.json'), 'utf8')).scripts;

/** True when the file reads options or arguments (process.argv beyond the script's own path). */
const readsArguments = (file: string) => /process\.argv\.(slice\(2\)|includes\(|indexOf\()/.test(readFileSync(file, 'utf8'));

it('top-level scripts pass their arguments on to server commands that take arguments', () => {
  const problems: string[] = [];
  for (const [name, command] of Object.entries(rootScripts)) {
    const m = command.match(/^npm run (\S+) -w server( --)?$/);
    if (!m) continue;
    // The server script it runs: `node … src/<file>.ts` with nothing fixed after the file (a fixed flag such as
    // `--list` means the command takes no options of its own).
    const target = serverScripts[m[1]!]?.match(/node (?:--\S+ )*(src\/\S+\.ts)$/);
    if (!target) continue;
    const file = path.join(root, 'server', target[1]!);
    if (existsSync(file) && readsArguments(file) && !m[2]) problems.push(`"${name}": "${command}" needs a trailing --`);
  }
  assert.deepEqual(problems, []);
});
