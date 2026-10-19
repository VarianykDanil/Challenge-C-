import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { BackupStatus } from '@lm/shared';
import { get, type Db } from '../db/connection.ts';
import { backupScheduleOn, backupStatus, currentBackupDir } from '../lib/backup.ts';

/** The admin-only backup status, plus whether this server runs the nightly schedule (false with LM_BACKUP=0). */
type HealthBackup = BackupStatus & { enabled?: boolean };

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
  router.get('/', (req, res) => {
    const row = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'seeded_at'`);
    const body: { ok: true; version: string; seededAt: string; backup?: HealthBackup } = { ok: true, version, seededAt: row?.value ?? '' };
    // Smart release 1.1 (p10): administrators also see the backup status (the router runs after `authenticate`, so a
    // signed-in request has req.user). Everyone else, and the unauthenticated probes, get exactly today's shape.
    if (req.user?.role === 'admin') body.backup = { ...backupStatus(db, currentBackupDir()), enabled: backupScheduleOn() };
    res.json(body);
  });
  return router;
}
