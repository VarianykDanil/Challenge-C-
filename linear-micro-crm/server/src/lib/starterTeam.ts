/**
 * The starter team the demo seed adds at its very end (the blank team with one-tap sign-ins for the owner's demo).
 * The repository is public, so real people never live in code: the team comes from a local file next to the database
 * (`starter-team.json`, never committed) when there is one, else from `server/starter-team.example.json`, which holds
 * invented people. People from the example are part of the demo company (`npm run golive` removes them); people from
 * the local file are the office's own and stay when it goes live.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { POSITIONS, STAFF_ROLES, type Position, type Role } from '@lm/shared';
import type { DemoTeamAccountSeed, DemoTeamSeed } from '../db/seed-data.ts';

export const STARTER_TEAM_EXAMPLE = path.resolve(import.meta.dirname, '../../starter-team.example.json');
export const STARTER_TEAM_FILE_NAME = 'starter-team.json';

export interface StarterTeam {
  teams: DemoTeamSeed[];
  accounts: DemoTeamAccountSeed[];
  /** 'local': the office's own people (kept at go-live); 'example': invented people (removed at go-live). */
  source: 'local' | 'example';
  file: string;
}

/** The local file for a database at `dbPath`: `starter-team.json` in the same folder. */
export function starterTeamFileFor(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), STARTER_TEAM_FILE_NAME);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPLOYEE_ID = /^LM-\d{4}$/i;

/** Reads and checks a starter-team file; throws a sentence naming the file and the first problem. */
export function parseStarterTeam(raw: string, file: string, source: StarterTeam['source']): StarterTeam {
  const fail = (why: string): never => {
    throw new Error(`The starter team file ${file} cannot be used: ${why}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`it is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.teams) || !Array.isArray(parsed.accounts)) return fail('it needs a "teams" list and an "accounts" list.');
  const teams: DemoTeamSeed[] = parsed.teams.map((t, i) => {
    if (!isRecord(t) || !text(t.name)) return fail(`team ${i + 1} has no name.`);
    const color = text(t.color) || '#7C3AED';
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return fail(`team "${text(t.name)}" has a colour that is not like #7C3AED.`);
    return { name: text(t.name), color };
  });
  const seen = new Set<string>();
  let next = 101;
  const accounts: DemoTeamAccountSeed[] = parsed.accounts.map((a, i) => {
    if (!isRecord(a)) return fail(`account ${i + 1} is not an object.`);
    const firstName = text(a.firstName);
    const email = text(a.email).toLowerCase();
    const role = text(a.role) as Role;
    const position = text(a.position) as Position;
    const team = text(a.team);
    if (!firstName) return fail(`account ${i + 1} has no firstName.`);
    if (!EMAIL.test(email)) return fail(`${firstName} has no valid email.`);
    if (seen.has(email)) return fail(`${email} is listed twice.`);
    seen.add(email);
    if (!(STAFF_ROLES as readonly string[]).includes(role)) return fail(`${firstName}'s role must be one of ${STAFF_ROLES.join(', ')}.`);
    if (!(POSITIONS as readonly string[]).includes(position)) return fail(`${firstName}'s position must be one of ${POSITIONS.join(', ')}.`);
    if (!teams.some((t) => t.name === team)) return fail(`${firstName}'s team "${team}" is not in the teams list.`);
    const given = text(a.employeeId).toUpperCase();
    if (given && !EMPLOYEE_ID.test(given)) return fail(`${firstName}'s employeeId must look like LM-0101.`);
    const employeeId = given || `LM-${String(next).padStart(4, '0')}`;
    next = Math.max(next, Number(employeeId.slice(3))) + 1;
    return {
      employeeId, firstName, email, role, position, team,
      ...(text(a.lastName) ? { lastName: text(a.lastName) } : {}),
      ...(a.leadsTeam === true ? { leadsTeam: true } : {}),
    };
  });
  return { teams, accounts, source, file };
}

/**
 * The starter team to seed: the local file when it exists (a broken one throws, so a typo is never silently replaced
 * by invented people), else the example. `localFile` null or absent: the example only (tests, and any caller that does
 * not know where the database lives).
 */
export function loadStarterTeam(localFile?: string | null): StarterTeam {
  if (localFile && existsSync(localFile)) return parseStarterTeam(readFileSync(localFile, 'utf8'), localFile, 'local');
  return parseStarterTeam(readFileSync(STARTER_TEAM_EXAMPLE, 'utf8'), STARTER_TEAM_EXAMPLE, 'example');
}
