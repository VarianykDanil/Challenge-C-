/**
 * Release 1.2 — OWNED BY U5 office-tools (laid down by r2-foundation). Pure helpers for the command palette search.
 */

/** Queries shorter than this are not sent to GET /search (the palette still filters pages and actions locally). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;

/** Trimmed, inner whitespace collapsed, at most SEARCH_MAX_LENGTH characters. */
export function normaliseSearchQuery(q: unknown): string {
  return typeof q === 'string' ? q.trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX_LENGTH) : '';
}
