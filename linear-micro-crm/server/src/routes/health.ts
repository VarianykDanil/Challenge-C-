import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { get, type Db } from '../db/connection.ts';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function healthRouter(db: Db): Router {
  const router = Router();
  const version = readVersion();
  router.get('/', (_req, res) => {
    const row = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'seeded_at'`);
    res.json({ ok: true, version, seededAt: row?.value ?? '' });
  });
  return router;
}
