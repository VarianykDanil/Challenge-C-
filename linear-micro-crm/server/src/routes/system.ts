/**
 * System health (Settings › Backups).
 *
 *  - GET /system/status: administrators. The app key's fingerprint and whether a recovery sheet is confirmed for it,
 *    whether local backups still carry the key, the off-site copies, the last backup failure, free disk space and
 *    the server errors of the last 24 hours. Never the key itself.
 *
 * The recovery sheet itself is made and confirmed only on the server computer (`npm run recovery-sheet`), so no
 * route returns the app key or takes it.
 */
import path from 'node:path';
import { Router, type Request } from 'express';
import type { UserWithTeam } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { disk } from '../lib/attention/system.ts';
import { currentBackupDir, currentOffsite, lastBackupFailure } from '../lib/backup.ts';
import { backupVideos } from '../lib/backupFiles.ts';
import { appSecretFile, currentAppSecret, secretFingerprint, shortFingerprint } from '../lib/crypto.ts';
import { errorLogFile, serverErrorsSince } from '../lib/errorLog.ts';
import { forbidden } from '../lib/errors.ts';
import { offsiteStatus } from '../lib/offsite.ts';
import { keyLeftOutOfBackups, sheetStatus } from '../lib/recoverySheet.ts';
import { currentUser } from '../middleware/auth.ts';

function requireAdmin(req: Request): UserWithTeam {
  const me = currentUser(req);
  if (me.role !== 'admin') throw forbidden('Only administrators can see the system status.');
  return me;
}

function databasePath(db: Db): string {
  const row = db.prepare(`SELECT file FROM pragma_database_list WHERE name = 'main'`).get() as { file?: string } | undefined;
  return row?.file || '(in memory)';
}

export function systemRouter(db: Db): Router {
  const router = Router();

  router.get('/status', (req, res) => {
    requireAdmin(req);
    const current = currentAppSecret();
    const fingerprint = current ? secretFingerprint(current.secret) : null;
    const sheet = sheetStatus(db, fingerprint);
    const dbFile = databasePath(db);
    const space = disk(dbFile.startsWith('(') ? currentBackupDir() : path.dirname(dbFile));
    const offsite = offsiteStatus(db, currentOffsite());
    res.json({
      key: {
        fingerprint: fingerprint ? shortFingerprint(fingerprint) : null,
        source: current?.source ?? null,
        sheetMadeAt: sheet.madeAt,
        sheetConfirmedAt: sheet.confirmedForThisKey ? sheet.confirmedAt : null,
        confirmedForThisKey: sheet.confirmedForThisKey,
        // a key file is copied into the local backups until the owner confirms the sheet for it
        inLocalBackups: current?.source === 'file' && !keyLeftOutOfBackups(db, appSecretFile()),
      },
      offsite: { configured: offsite.configured, dir: offsite.dir, lastAt: offsite.lastAt, file: offsite.file, error: offsite.error, errorAt: offsite.errorAt, problem: offsite.problem },
      backupFailure: lastBackupFailure(db),
      files: { includeVideos: backupVideos() },
      disk: space ? { freeBytes: space.free, totalBytes: space.total } : null,
      serverErrors24h: serverErrorsSince(),
      errorLog: errorLogFile() ? path.join(path.basename(path.dirname(errorLogFile()!)), path.basename(errorLogFile()!)) : null,
    });
  });

  return router;
}
