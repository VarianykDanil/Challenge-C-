/**
 * Release 1.2 — GET /search?q= (command palette) — OWNED BY U5 office-tools (laid down by r2-foundation as a stub).
 *
 *  GET /search?q=  → SearchResponse: people, events, candidates and campaigns the caller may open (role-scoped),
 *                    at most 20; q shorter than SEARCH_MIN_LENGTH → no results. Cached per user (CACHED_PATHS, 20 s).
 * Types: shared/src/types/search.ts; query rules: shared/src/logic/search.ts.
 */
import { Router } from 'express';
import { normaliseSearchQuery, type SearchResponse } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { currentUser } from '../middleware/auth.ts';

export function searchRouter(db: Db): Router {
  void db;
  const router = Router();
  // STUB (U5): no results yet.
  router.get('/', (req, res) => {
    currentUser(req);
    const body: SearchResponse = { q: normaliseSearchQuery(req.query.q), results: [] };
    res.json(body);
  });
  return router;
}
