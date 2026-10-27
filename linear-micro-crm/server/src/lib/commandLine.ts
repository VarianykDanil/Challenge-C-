/**
 * Small helpers the server commands share (golive, seed, setup-code): flags, the typed confirmation, and the "is Linear
 * Hub running on this database?" refusal.
 */
import { createInterface } from 'node:readline/promises';
import { databaseInUse } from './backup.ts';
import { findPortHolder } from './boot.ts';
import { installedServiceFile } from '../service.ts';

/** The value of `--name value` or `--name=value` (null when absent or empty). */
export function flagValue(args: readonly string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) return args[i + 1]?.trim() || null;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3).trim() || null;
  }
  return null;
}

/** Asks a question in a terminal; null when stdin is not a terminal (a script, a service). */
export async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * The typed confirmation: `--confirm "<words>"`, or the words typed when asked. Returns null when confirmed, else the
 * sentence to print (nothing has been changed by then).
 */
export async function typedConfirmation(args: readonly string[], words: string, question: string): Promise<string | null> {
  const given = flagValue(args, 'confirm');
  if (given !== null) return given === words ? null : `Nothing was changed: the confirmation must be ${words} exactly.`;
  const typed = await ask(`${question} Type ${words} to go ahead: `);
  if (typed === null) return `Nothing was changed: type ${words} when asked, or add --confirm "${words}" when not running in a terminal.`;
  return typed === words ? null : `Nothing was changed: you typed "${typed}", not ${words}.`;
}

/** How to stop Linear Hub so a command can have the database to itself. */
export function stopHint(): string {
  const service = installedServiceFile();
  return service
    ? `Linear Hub is installed as a background service (${service}), which starts it again after npm run stop: run npm run service:uninstall first, then this command, then npm run service:install.`
    : 'Stop it first with npm run stop (with the PORT it runs on, for example PORT=4001 npm run stop), then run this command again.';
}

/** Null when nothing has the database open and nothing answers on `port`; else the refusal to print. */
export async function runningRefusal(dbPath: string, port: number): Promise<string | null> {
  if (databaseInUse(dbPath)) {
    return `The database is open in another process (usually Linear Hub still running), so nothing was changed: ${dbPath}\n${stopHint()}`;
  }
  const holder = await findPortHolder(port);
  if (holder) {
    const who = holder.linearHub ? `Linear Hub is running on port ${port}` : `Something is listening on port ${port}`;
    return `${who}, so nothing was changed.\n${stopHint()}`;
  }
  return null;
}
