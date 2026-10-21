/**
 * Release 1.3 — /videos (learning videos: uploads streamed with byte ranges, or YouTube / Vimeo / Drive links, with
 * watch progress) — OWNED BY P5 learning-videos (laid down by r3-foundation as a stub: reads empty, writes 501).
 *
 *  GET    /videos                     → LearningVideo[] (the caller's audience, with their own progress)
 *  GET    /videos/settings, PUT …     → VideoSettings (admin)
 *  GET    /videos/team?userId=        → TeamVideoProgress (admin, leader) — cached
 *  POST   /videos  VideoLinkInput     → 201 LearningVideo (admin; leaders when allowed)
 *  POST   /videos/upload              → 201 LearningVideo (multipart, busboy streaming, 2 GB cap)
 *  GET    /videos/:id                 → LearningVideo
 *  GET    /videos/:id/stream          → 206 byte ranges (private, no-store)
 *  GET    /videos/:id/views           → VideoViewRow[] (admin)
 *  PATCH  /videos/:id  VideoUpdateInput → LearningVideo
 *  DELETE /videos/:id                 → 204
 *  POST   /videos/:id/progress  VideoProgressInput → VideoProgress
 * Types: shared/src/types/videos.ts. Audit specs: lib/audit/videoSpecs.ts. Files: server/data/media/videos/.
 */
import { Router } from 'express';
import type { LearningVideo, TeamVideoProgress, VideoSettings, VideoViewRow } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const notYet = () => {
  throw new HttpError(501, 'Learning videos are not available yet');
};

export function videosRouter(db: Db): Router {
  void db;
  const router = Router();
  router.get('/', (req, res) => {
    currentUser(req);
    const rows: LearningVideo[] = [];
    res.json(rows);
  });
  router.get('/settings', requireRole('admin'), (_req, res) => {
    const body: VideoSettings = { leadersCanAdd: false };
    res.json(body);
  });
  router.put('/settings', requireRole('admin'), notYet);
  router.get('/team', requireRole('admin', 'leader'), (_req, res) => {
    const body: TeamVideoProgress = { required: 0, rows: [] };
    res.json(body);
  });
  router.post('/', notYet);
  router.post('/upload', notYet);
  router.get('/:id', () => {
    throw notFound('Video');
  });
  router.get('/:id/stream', () => {
    throw notFound('Video');
  });
  router.get('/:id/views', requireRole('admin'), (_req, res) => {
    const rows: VideoViewRow[] = [];
    res.json(rows);
  });
  router.patch('/:id', notYet);
  router.delete('/:id', notYet);
  router.post('/:id/progress', notYet);
  return router;
}
