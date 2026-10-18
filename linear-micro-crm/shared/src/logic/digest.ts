/**
 * "Your week in review" digest — OWNED BY p9-week-in-review-digest.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p9 replaces the bodies
 * (p9 may reshape DigestFacts, which only its own server builder fills).
 * Pure, en-GB, deterministic. Check-in names and anyone's pay never appear in shareable text.
 */
import type { DigestBullet, Role, WeekDigest } from '../types.ts';

/** plural(1, 'sale') → '1 sale'; plural(2, 'sale') → '2 sales'. */
export function plural(n: number, noun: string, pluralNoun?: string): string {
  return `${n} ${n === 1 ? noun : pluralNoun ?? `${noun}s`}`;
}

/** £1,234.50 style (Intl en-GB GBP). */
export function gbp(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

/** 'up 3 on the week before' | 'down 2 on the week before' | 'the same as the week before' | 'no comparison yet'. */
export function deltaPhrase(cur: number, prev: number | null): string {
  void cur;
  void prev;
  return 'no comparison yet';
}

/** The figures one digest is built from (all from existing functions, so they never contradict the tiles). */
export interface DigestFacts {
  weekStart: string;
  weekEnd: string;
  [fact: string]: unknown;
}

/** 5–8 bullets for the role. */
export function buildDigest(role: Role, facts: DigestFacts): DigestBullet[] {
  void role;
  void facts;
  return [];
}

/** title + newline + '• ' lines for the shareable bullets only. No markdown or HTML. */
export function digestText(d: Pick<WeekDigest, 'title' | 'bullets'>): string {
  void d;
  return '';
}
