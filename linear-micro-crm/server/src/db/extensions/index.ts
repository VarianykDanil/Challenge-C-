/**
 * Release 1.2 (r2-foundation): every database extension in a FIXED order (owned by the foundation; packages edit only
 * their own file). createSchema runs `sql` then `upgrade` for each, in this order, after the core schema; seed calls
 * each `seed` at the end of a fresh demo seed. The contract is in ./types.ts.
 */
import type { Db } from '../connection.ts';
import { extension as audit } from './audit.ts';
import { extension as checkins } from './checkins.ts';
import { extension as learning } from './learning.ts';
import { extension as pin } from './pin.ts';
import { extension as pitches } from './pitches.ts';
import type { DbExtension, SeedContext } from './types.ts';

export type { DbExtension, SeedContext } from './types.ts';

export const EXTENSIONS: readonly DbExtension[] = [learning, pitches, pin, audit, checkins];

/**
 * Creates every extension's tables and runs its upgrades, in order. Returns what the upgrades changed, each name
 * prefixed with its extension (`pin:users.pin_hash`) so it never reads as a core column. Idempotent.
 */
export function upgradeExtensions(db: Db): string[] {
  const changed: string[] = [];
  for (const ext of EXTENSIONS) {
    if (ext.sql.trim()) db.exec(ext.sql);
    for (const name of ext.upgrade(db)) changed.push(`${ext.name}:${name}`);
  }
  return changed;
}

/** Calls every extension's demo seed, in order (the caller holds the seed transaction). */
export function seedExtensions(db: Db, ctx: SeedContext): void {
  for (const ext of EXTENSIONS) ext.seed?.(db, ctx);
}
