import { Router } from 'express';
import type { Db } from '../db/connection.ts';
import { listTeams } from '../db/queries.ts';

export function teamsRouter(db: Db): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(listTeams(db));
  });
  return router;
}
