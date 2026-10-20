/**
 * Release 1.2 — /pitches — OWNED BY L2 learning-pitch (laid down by r2-foundation as a stub).
 *
 *  GET /pitches                → PitchListItem[] (every signed-in role) — cached
 *  GET /pitches/:campaignCode  → CampaignPitch (every signed-in role; 404 when the campaign has no pitch) — cached
 *  PUT /pitches/:campaignCode  PitchUpsertInput → CampaignPitch (admin, leader; sets updated_by)
 * Types: shared/src/types/pitches.ts. Mounted in app.ts with requireAuth; '/pitches' is in CACHED_PATHS.
 */
import { Router } from 'express';
import type { PitchListItem } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { requireRole } from '../middleware/auth.ts';

export function pitchesRouter(db: Db): Router {
  void db;
  const router = Router();

  // STUB (L2): no pitches yet.
  router.get('/', (_req, res) => {
    const body: PitchListItem[] = [];
    res.json(body);
  });
  router.get('/:campaignCode', () => {
    throw notFound('Pitch');
  });
  router.put('/:campaignCode', requireRole('admin', 'leader'), () => {
    throw new HttpError(501, 'Editing pitches is not available yet');
  });

  return router;
}
