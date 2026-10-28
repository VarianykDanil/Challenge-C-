/**
 * Sessions are stored by a SHA-256 hash of their token, never the token itself: a copy of the database or a backup
 * holds no cookie anyone could replay. The cookie carries the token; every lookup hashes it first. A token is 32
 * random bytes, so a plain (unsalted) hash is enough: there is nothing to guess.
 */
import { createHash } from 'node:crypto';

export function sessionKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
