/**
 * Trial mode: the database still holds the demo company. The demo seed switches it on; `npm run golive` switches it
 * off for good (removing the demo company). While it is on, the one-tap demo sign-ins may work (lib/demoTeams.ts) and
 * every administrator sees a banner and a Needs-attention item; once it is off, nobody signs in without their own
 * setup code and two-step verification.
 *
 * Stored in `meta` (the access extension's own `ext:access:*` keys):
 *  - `ext:access:trial-mode`   '1' on, '0' off. Absent: off (a database the demo seed did not build; an older database gets
 *                        its value once from db/extensions/access.ts).
 *  - `ext:access:demo-people` JSON array of the user ids of the demo company's people (the seed's staff and its demo client
 *                        accounts, and the example starter team when no local starter file was used). Golive removes
 *                        exactly these people; nobody else is ever treated as "demo".
 *  - `ext:access:seed-marks`  JSON { table: highest id } as the demo seed (or the upgrade of an older demo database) left
 *                        each company table: rows above it were made afterwards, by people using the app.
 * Reads are cached per data version (every write request moves it).
 */
import { all, get, run, type Db } from '../db/connection.ts';
import { currentDataVersion } from './cache.ts';

export const TRIAL_MODE_KEY = 'ext:access:trial-mode';
export const DEMO_PEOPLE_KEY = 'ext:access:demo-people';
export const SEED_MARKS_KEY = 'ext:access:seed-marks';

/** The company tables golive cleans by id (rows at or below the seed's mark that nobody made through the app). */
export const SEED_MARK_TABLES = ['teams', 'campaigns', 'events', 'expenses', 'candidates', 'announcements', 'statements', 'learning_videos'] as const;
export type SeedMarkTable = (typeof SEED_MARK_TABLES)[number];
export type SeedMarks = Partial<Record<SeedMarkTable, number>>;

interface TrialState {
  on: boolean;
  demoPeople: Set<number>;
}

const cache = new WeakMap<Db, { version: number; state: TrialState }>();

function trialState(db: Db): TrialState {
  const version = currentDataVersion();
  const hit = cache.get(db);
  if (hit && hit.version === version) return hit.state;
  const rows = all<{ key: string; value: string }>(db, `SELECT key, value FROM meta WHERE key IN (?, ?)`, [TRIAL_MODE_KEY, DEMO_PEOPLE_KEY]);
  const on = rows.find((r) => r.key === TRIAL_MODE_KEY)?.value === '1';
  const state: TrialState = { on, demoPeople: on ? parseIds(rows.find((r) => r.key === DEMO_PEOPLE_KEY)?.value) : new Set() };
  cache.set(db, { version, state });
  return state;
}

function parseIds(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n) && n > 0) : []);
  } catch {
    return new Set();
  }
}

/** Forget the cached state (after writing the trial keys outside a request). */
export function forgetTrialState(db: Db): void {
  cache.delete(db);
}

export function isTrialMode(db: Db): boolean {
  return trialState(db).on;
}

/** One of the demo company's people (only while in trial mode: afterwards they no longer exist). */
export function isDemoPerson(db: Db, userId: number): boolean {
  return trialState(db).demoPeople.has(userId);
}

export function demoPeopleIds(db: Db): number[] {
  const raw = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [DEMO_PEOPLE_KEY])?.value;
  return [...parseIds(raw)];
}

const put = (db: Db, key: string, value: string) =>
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);

export function setTrialMode(db: Db, on: boolean): void {
  put(db, TRIAL_MODE_KEY, on ? '1' : '0');
  forgetTrialState(db);
}

/** Adds people to the demo company (the seed, the example starter team, the upgrade of an older demo database). */
export function addDemoPeople(db: Db, ids: readonly number[]): void {
  const all = new Set([...demoPeopleIds(db), ...ids]);
  put(db, DEMO_PEOPLE_KEY, JSON.stringify([...all].sort((a, b) => a - b)));
  forgetTrialState(db);
}

/** The highest id in each company table right now: what the demo seed made. */
export function currentSeedMarks(db: Db): SeedMarks {
  const marks: SeedMarks = {};
  for (const t of SEED_MARK_TABLES) {
    const exists = get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [t]);
    marks[t] = exists ? Number(get<{ n: number | null }>(db, `SELECT MAX(id) AS n FROM ${t}`)?.n ?? 0) : 0;
  }
  return marks;
}

export function writeSeedMarks(db: Db, marks: SeedMarks): void {
  put(db, SEED_MARKS_KEY, JSON.stringify(marks));
}

export function readSeedMarks(db: Db): SeedMarks {
  const raw = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [SEED_MARKS_KEY])?.value;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const marks: SeedMarks = {};
    for (const t of SEED_MARK_TABLES) if (Number.isInteger(parsed[t])) marks[t] = parsed[t] as number;
    return marks;
  } catch {
    return {};
  }
}
