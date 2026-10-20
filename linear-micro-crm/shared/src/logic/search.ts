/**
 * Release 1.2 — OWNED BY U5 office-tools (laid down by r2-foundation). Pure helpers for the command palette search:
 * query normalising, tokens and LIKE patterns for GET /search, the per-kind caps, which kinds each role may find, the
 * local matcher and rank the palette uses for pages and actions, and the event subtitle.
 */
import type { CampaignSector, Role } from '../types.ts';
import type { SearchResultKind } from '../types/search.ts';
import { daysBetween, isValidISODate } from './dates.ts';

/** Queries shorter than this are not sent to GET /search (the palette still filters pages and actions locally). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;
/** Words beyond this many are ignored (every word must match, so more only narrows a list that is already short). */
export const SEARCH_MAX_TOKENS = 5;

/** At most this many results of each kind; together GET /search answers at most SEARCH_MAX_RESULTS (20). */
export const SEARCH_KIND_LIMITS: Readonly<Record<SearchResultKind, number>> = { person: 6, event: 6, candidate: 5, campaign: 3 };
export const SEARCH_MAX_RESULTS = 20;

/** Display order of the groups, and their headings. */
export const SEARCH_KINDS: readonly SearchResultKind[] = ['person', 'event', 'candidate', 'campaign'];
export const SEARCH_KIND_LABELS: Readonly<Record<SearchResultKind, string>> = { person: 'People', event: 'Events', candidate: 'Candidates', campaign: 'Campaigns' };

/** Trimmed, inner whitespace collapsed, at most SEARCH_MAX_LENGTH characters. */
export function normaliseSearchQuery(q: unknown): string {
  return typeof q === 'string' ? q.trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX_LENGTH) : '';
}

/** Lower-case words of the normalised query, duplicates dropped, at most SEARCH_MAX_TOKENS. */
export function searchTokens(q: unknown): string[] {
  const norm = normaliseSearchQuery(q).toLowerCase();
  if (!norm) return [];
  return [...new Set(norm.split(' '))].slice(0, SEARCH_MAX_TOKENS);
}

/** Escapes `\`, `%` and `_` for a SQL `LIKE … ESCAPE '\'` pattern, so a typed `%` or `_` matches itself. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%word%` with LIKE wildcards escaped (pair it with `ESCAPE '\'`). */
export function likeContains(token: string): string {
  return `%${escapeLike(token)}%`;
}

/** `word%` with LIKE wildcards escaped (pair it with `ESCAPE '\'`). */
export function likePrefix(token: string): string {
  return `${escapeLike(token)}%`;
}

/**
 * Which kinds a role can find, the same rules as the pages they open: everyone finds people (the directory) and events
 * (a rep only their own team's), leaders and admins find campaigns on the Campaigns page while reps and recruiters
 * find each campaign's pitch, and only recruitment roles (recruiter, leader, admin) find candidates.
 */
export function searchKindsFor(role: Role): SearchResultKind[] {
  return role === 'rep' ? ['person', 'event', 'campaign'] : ['person', 'event', 'candidate', 'campaign'];
}

/** True when every word of `q` appears in one of `fields` (case-insensitive). An empty query matches everything. */
export function matchesSearch(q: string, ...fields: ReadonlyArray<string | null | undefined>): boolean {
  const tokens = searchTokens(q);
  if (!tokens.length) return true;
  const hay = fields.filter(Boolean).join(' \u0000 ').toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * How well `title` answers `q`: 0 starts with the whole query, 1 a word of the title starts with it, 2 anything else.
 * GET /search orders each kind by the same rule (in SQL), the palette its pages and actions.
 */
export function searchRank(q: string, title: string): 0 | 1 | 2 {
  const norm = normaliseSearchQuery(q).toLowerCase();
  const t = title.toLowerCase();
  if (!norm) return 2;
  if (t.startsWith(norm)) return 0;
  return t.includes(` ${norm}`) || t.includes(`-${norm}`) ? 1 : 2;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 20 Oct"; the year is added when it differs from `today`'s ("Mon 6 Jan 2025"). "Today" / "Tomorrow" / "Yesterday" near today. */
export function searchDateLabel(date: string, today: string): string {
  if (!isValidISODate(date)) return date;
  if (isValidISODate(today)) {
    const diff = daysBetween(today, date);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
  }
  const d = new Date(`${date}T00:00:00Z`);
  const base = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return isValidISODate(today) && today.slice(0, 4) !== date.slice(0, 4) ? `${base} ${date.slice(0, 4)}` : base;
}

/**
 * An event result's second line: "Tomorrow · Arndale Centre, Manchester · Ancoats", "· Cancelled" when it is. The venue
 * is left out when the event's name already says it ("Breast Cancer Now — Arndale Centre" → "Tomorrow · Manchester").
 */
export function eventSearchSubtitle(e: { name?: string; date: string; venue: string; city: string; teamName: string | null; status: string }, today: string): string {
  const venueInName = !!e.name && !!e.venue.trim() && e.name.toLowerCase().includes(e.venue.trim().toLowerCase());
  const place = [venueInName ? '' : e.venue, e.city].filter((s) => s && s.trim()).join(', ');
  return [searchDateLabel(e.date, today), place, e.teamName, e.status === 'cancelled' ? 'Cancelled' : null].filter(Boolean).join(' · ');
}

export const SEARCH_SECTOR_LABELS: Readonly<Record<CampaignSector, string>> = {
  charity: 'Charity',
  energy: 'Energy',
  telecoms: 'Telecoms',
  broadband: 'Broadband',
  other: 'Other',
};
