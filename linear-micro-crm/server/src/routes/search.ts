/**
 * Release 1.2 — GET /search?q= (command palette) — OWNED BY U5 office-tools.
 *
 *  GET /search?q=  → SearchResponse: people, events, candidates and campaigns the caller may open (role-scoped), at
 *                    most 20 (SEARCH_KIND_LIMITS per kind); q shorter than SEARCH_MIN_LENGTH → no results and no SQL.
 *                    Cached per user (CACHED_PATHS, 20 s, cleared by any write).
 *
 * Every word of the query must appear somewhere in a row's searchable text (LIKE, wildcards escaped). Within a kind the
 * rows whose title starts with the whole query come first (`rank` 0; a campaign also when its code does), then those
 * where a word of the title starts with it (1), then the rest (2) in the kind's natural order; the palette puts the
 * group with the best rank first. One SQL statement per kind (at most four per request).
 *
 * Scoping (the same rules as the pages a result opens):
 *  - people: everyone (the directory). Admins also find people who have left and match on employee ID; nobody else
 *    does (the ID is half of the sign-in credential). E-mail matches on the part before the @ only.
 *  - events: reps only their own team's events (as GET /events); everyone else every team's.
 *  - candidates: recruiters, leaders and admins (the recruitment roles); reps get none.
 *  - campaigns: leaders and admins every campaign (→ /campaigns); reps and recruiters the active ones, linking to the
 *    campaign's pitch (/learning/pitch/:code), the campaign page they can open.
 * Types: shared/src/types/search.ts; query rules: shared/src/logic/search.ts.
 */
import { Router } from 'express';
import {
  POSITION_LABELS,
  SEARCH_KIND_LIMITS,
  SEARCH_MIN_LENGTH,
  SEARCH_SECTOR_LABELS,
  STAGE_LABELS,
  TERMINAL_STAGES,
  eventSearchSubtitle,
  likeContains,
  likePrefix,
  normaliseSearchQuery,
  searchKindsFor,
  searchTokens,
  type CampaignSector,
  type CandidateStage,
  type Position,
  type SearchResponse,
  type SearchResult,
  type UserWithTeam,
} from '@lm/shared';
import { all, placeholders, type Db, type Param } from '../db/connection.ts';
import { todayISO } from '../lib/dates.ts';
import { currentUser } from '../middleware/auth.ts';

/** `hay LIKE ? ESCAPE '\'` once per word. */
function wordClauses(tokens: string[]): { sql: string; params: Param[] } {
  return { sql: tokens.map(() => `hay LIKE ? ESCAPE '\\'`).join(' AND '), params: tokens.map(likeContains) };
}

/** 0 when `col` starts with the query, 1 when a word of it does, 2 otherwise. */
function rankSql(col: string): string {
  return `CASE WHEN ${col} LIKE ? ESCAPE '\\' THEN 0 WHEN ${col} LIKE ? ESCAPE '\\' OR ${col} LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END`;
}
function rankParams(q: string): Param[] {
  const p = likePrefix(q);
  return [p, `% ${p}`, `%-${p}`];
}

interface Ranked { rank: 0 | 1 | 2 }
interface PersonRow extends Ranked { id: number; firstName: string; lastName: string; position: Position; teamName: string | null; status: string; avatarColor: string }
interface EventRow extends Ranked { id: number; name: string; venue: string; city: string; date: string; status: string; teamName: string | null; color: string | null }
interface CandidateRow extends Ranked { id: number; firstName: string; lastName: string; stage: CandidateStage; positionApplied: Position; city: string | null }
interface CampaignRow extends Ranked { id: number; name: string; code: string; sector: CampaignSector; active: number; color: string | null }

export function searchPeople(db: Db, me: UserWithTeam, tokens: string[], q: string): SearchResult[] {
  const admin = me.role === 'admin';
  const words = wordClauses(tokens);
  // Employee IDs are searchable for admins only (otherwise `q` would be a guessing oracle for a credential).
  const hay = `lower(u.first_name || ' ' || u.last_name || ' ' || substr(u.email, 1, instr(u.email, '@') - 1) || ' ' || COALESCE(t.name, '') || ' ' || COALESCE(u.city, '')${admin ? ` || ' ' || u.employee_id` : ''})`;
  const rows = all<PersonRow>(
    db,
    `SELECT *, ${rankSql('title')} AS rank FROM (
       SELECT u.id, u.first_name AS firstName, u.last_name AS lastName, u.position, t.name AS teamName, u.status,
              u.avatar_color AS avatarColor, ${hay} AS hay, lower(u.first_name || ' ' || u.last_name) AS title
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
       ${admin ? '' : `WHERE u.status <> 'left'`}
     ) WHERE ${words.sql}
     ORDER BY rank, CASE status WHEN 'active' THEN 0 WHEN 'on_leave' THEN 1 ELSE 2 END, lastName, firstName, id
     LIMIT ?`,
    [...rankParams(q), ...words.params, SEARCH_KIND_LIMITS.person],
  );
  return rows.map((r) => ({
    kind: 'person',
    id: r.id,
    title: `${r.firstName} ${r.lastName}`,
    subtitle: [POSITION_LABELS[r.position] ?? r.position, r.teamName, r.status === 'on_leave' ? 'On leave' : r.status === 'left' ? 'Left' : null].filter(Boolean).join(' · '),
    href: `/team/${r.id}`,
    color: r.avatarColor,
    rank: r.rank,
  }));
}

export function searchEvents(db: Db, me: UserWithTeam, tokens: string[], q: string, today: string): SearchResult[] {
  if (me.role === 'rep' && me.teamId === null) return [];
  const words = wordClauses(tokens);
  const scope: Param[] = me.role === 'rep' ? [me.teamId] : [];
  const rows = all<EventRow>(
    db,
    `SELECT *, ${rankSql('title')} AS rank FROM (
       SELECT e.id, e.name, e.venue, e.city, e.date, e.start_time AS startTime, e.status, t.name AS teamName, c.color,
              lower(e.name || ' ' || e.venue || ' ' || e.city || ' ' || c.name || ' ' || c.code || ' ' || t.name) AS hay,
              lower(e.name) AS title
       FROM events e JOIN campaigns c ON c.id = e.campaign_id JOIN teams t ON t.id = e.team_id
       ${scope.length ? 'WHERE e.team_id = ?' : ''}
     ) WHERE ${words.sql}
     ORDER BY rank, CASE WHEN date >= ? THEN 0 ELSE 1 END, CASE WHEN date >= ? THEN date END ASC, date DESC, startTime, id
     LIMIT ?`,
    [...rankParams(q), ...scope, ...words.params, today, today, SEARCH_KIND_LIMITS.event],
  );
  return rows.map((r) => ({
    kind: 'event',
    id: r.id,
    title: r.name,
    subtitle: eventSearchSubtitle(r, today),
    href: `/events/${r.id}`,
    color: r.color,
    rank: r.rank,
  }));
}

export function searchCandidates(db: Db, tokens: string[], q: string): SearchResult[] {
  const words = wordClauses(tokens);
  const rows = all<CandidateRow>(
    db,
    `SELECT *, ${rankSql('title')} AS rank FROM (
       SELECT c.id, c.first_name AS firstName, c.last_name AS lastName, c.stage, c.position_applied AS positionApplied, c.city,
              c.stage_updated_at AS stageUpdatedAt,
              lower(c.first_name || ' ' || c.last_name || ' ' || substr(c.email, 1, instr(c.email, '@') - 1) || ' ' || COALESCE(c.city, '')) AS hay,
              lower(c.first_name || ' ' || c.last_name) AS title
       FROM candidates c
     ) WHERE ${words.sql}
     ORDER BY rank, CASE WHEN stage IN (${placeholders(TERMINAL_STAGES.length)}) THEN 1 ELSE 0 END, stageUpdatedAt DESC, id
     LIMIT ?`,
    [...rankParams(q), ...words.params, ...TERMINAL_STAGES, SEARCH_KIND_LIMITS.candidate],
  );
  return rows.map((r) => ({
    kind: 'candidate',
    id: r.id,
    title: `${r.firstName} ${r.lastName}`,
    subtitle: [STAGE_LABELS[r.stage] ?? r.stage, POSITION_LABELS[r.positionApplied] ?? null, r.city].filter(Boolean).join(' · '),
    href: `/recruitment/${r.id}`,
    color: null,
    rank: r.rank,
  }));
}

export function searchCampaigns(db: Db, me: UserWithTeam, tokens: string[], q: string): SearchResult[] {
  const manager = me.role === 'admin' || me.role === 'leader';
  const words = wordClauses(tokens);
  // A campaign whose code starts with the query ranks with the names that do ("bcn" → Breast Cancer Now).
  const rows = all<CampaignRow>(
    db,
    `SELECT *, CASE WHEN codeKey LIKE ? ESCAPE '\\' THEN 0 ELSE ${rankSql('title')} END AS rank FROM (
       SELECT c.id, c.name, c.code, c.sector, c.active, c.color,
              lower(c.name || ' ' || c.code || ' ' || c.sector) AS hay, lower(c.name) AS title, lower(c.code) AS codeKey
       FROM campaigns c
       ${manager ? '' : 'WHERE c.active = 1'}
     ) WHERE ${words.sql}
     ORDER BY rank, active DESC, name, id
     LIMIT ?`,
    [likePrefix(q), ...rankParams(q), ...words.params, SEARCH_KIND_LIMITS.campaign],
  );
  return rows.map((r) => ({
    kind: 'campaign',
    id: r.id,
    title: r.name,
    subtitle: manager
      ? [r.code, SEARCH_SECTOR_LABELS[r.sector] ?? r.sector, r.active ? null : 'Inactive'].filter(Boolean).join(' · ')
      : `${r.code} · Pitch`,
    href: manager ? '/campaigns' : `/learning/pitch/${encodeURIComponent(r.code)}`,
    color: r.color,
    rank: r.rank,
  }));
}

/** The whole answer for `me` (pure apart from the reads; exported for tests). */
export function searchFor(db: Db, me: UserWithTeam, rawQ: unknown, today = todayISO()): SearchResponse {
  const q = normaliseSearchQuery(rawQ);
  const tokens = searchTokens(q);
  if (q.length < SEARCH_MIN_LENGTH || !tokens.length) return { q, results: [] };
  const lower = q.toLowerCase();
  const kinds = new Set(searchKindsFor(me.role));
  const results: SearchResult[] = [
    ...(kinds.has('person') ? searchPeople(db, me, tokens, lower) : []),
    ...(kinds.has('event') ? searchEvents(db, me, tokens, lower, today) : []),
    ...(kinds.has('candidate') ? searchCandidates(db, tokens, lower) : []),
    ...(kinds.has('campaign') ? searchCampaigns(db, me, tokens, lower) : []),
  ];
  return { q, results };
}

export function searchRouter(db: Db): Router {
  const router = Router();
  router.get('/', (req, res) => {
    res.json(searchFor(db, currentUser(req), req.query.q));
  });
  return router;
}
