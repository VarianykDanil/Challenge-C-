/**
 * System health and the recovery sheet (Settings › Backups).
 *
 *  - GET  /system/status: administrators. The app key's fingerprint and whether a recovery sheet is confirmed for it,
 *    whether local backups still carry the key, the off-site copies, the last backup failure, free disk space and
 *    the server errors of the last 24 hours. Never the key itself.
 *  - POST /system/recovery-sheet { code }: the owner only (an administrator whose position is Owner), over a secure
 *    request (HTTPS, or on the server itself), with a fresh two-step code. Answers the sheet, key included, with
 *    Cache-Control: no-store. The audit trail records that a sheet was made, never the key.
 *  - POST /system/recovery-sheet/confirm { lastSix }: the owner, over a secure request, types the last six characters
 *    of the key from the printed sheet. From then on local backups leave the key out (the sheet holds it).
 */
import path from 'node:path';
import { statfsSync } from 'node:fs';
import { Router, type Request } from 'express';
import type { UserWithTeam } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { currentBackupDir, currentOffsite, lastBackupFailure } from '../lib/backup.ts';
import { backupVideos } from '../lib/backupFiles.ts';
import { appSecretFile, currentAppSecret, secretFingerprint, shortFingerprint } from '../lib/crypto.ts';
import { errorLogFile, serverErrorsSince } from '../lib/errorLog.ts';
import { HttpError, badRequest, forbidden } from '../lib/errors.ts';
import { offsiteStatus } from '../lib/offsite.ts';
import { assertFreshCode, codeSource } from '../lib/payments/code.ts';
import { buildRecoverySheet, confirmsKey, keyLeftOutOfBackups, recordSheetConfirmed, recordSheetMade, sheetStatus } from '../lib/recoverySheet.ts';
import { isSecureRequest } from '../lib/secureRequest.ts';
import { currentUser } from '../middleware/auth.ts';

export const OWNER_ONLY_MESSAGE = 'Only the owner can make the recovery sheet. Ask them to do it in Settings › Backups.';
export const TWO_FACTOR_FOR_SHEET_MESSAGE = 'Set up two-step verification in Settings › Security first: the recovery sheet needs a code from your authenticator app.';
export const SECURE_ONLY_MESSAGE =
  'The recovery sheet holds the app key, so it is only shown over a secure connection: open Linear Hub with its https:// address, or on the server computer itself.';

const isOwner = (me: UserWithTeam) => me.role === 'admin' && me.position === 'owner';

function requireAdmin(req: Request): UserWithTeam {
  const me = currentUser(req);
  if (me.role !== 'admin') throw forbidden('Only administrators can see the system status.');
  return me;
}

function requireOwnerSecure(req: Request): UserWithTeam {
  const me = requireAdmin(req);
  if (!isOwner(me)) throw forbidden(OWNER_ONLY_MESSAGE);
  if (!isSecureRequest(req)) throw new HttpError(403, SECURE_ONLY_MESSAGE, { code: 'secure_connection_required' });
  return me;
}

function currentKey(): { secret: string; source: 'env' | 'file'; fingerprint: string } {
  const current = currentAppSecret();
  if (!current) throw new HttpError(409, 'The server has no app key yet. Start it once, then try again.');
  return { secret: current.secret, source: current.source, fingerprint: secretFingerprint(current.secret) };
}

function databasePath(db: Db): string {
  const row = db.prepare(`SELECT file FROM pragma_database_list WHERE name = 'main'`).get() as { file?: string } | undefined;
  return row?.file || '(in memory)';
}

export function systemRouter(db: Db): Router {
  const router = Router();

  router.get('/status', (req, res) => {
    const me = requireAdmin(req);
    const current = currentAppSecret();
    const fingerprint = current ? secretFingerprint(current.secret) : null;
    const sheet = sheetStatus(db, fingerprint);
    const dbFile = databasePath(db);
    let disk: { freeBytes: number; totalBytes: number } | null = null;
    try {
      const s = statfsSync(dbFile.startsWith('(') ? currentBackupDir() : path.dirname(dbFile));
      disk = { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      disk = null;
    }
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
      disk,
      serverErrors24h: serverErrorsSince(),
      errorLog: errorLogFile() ? path.join(path.basename(path.dirname(errorLogFile()!)), path.basename(errorLogFile()!)) : null,
      canMakeSheet: isOwner(me),
      secure: isSecureRequest(req),
    });
  });

  router.post('/recovery-sheet', (req, res) => {
    const me = requireOwnerSecure(req);
    try {
      assertFreshCode(db, me, (req.body as { code?: unknown } | undefined)?.code, codeSource(req), { required: true });
    } catch (err) {
      // the shared message talks about payments; say what this needs instead
      if (err instanceof HttpError && err.status === 403) throw new HttpError(403, TWO_FACTOR_FOR_SHEET_MESSAGE, err.details);
      throw err;
    }
    const key = currentKey();
    const offsite = currentOffsite();
    const sheet = buildRecoverySheet({
      secret: key.secret,
      keySource: key.source,
      keyFile: key.source === 'file' ? appSecretFile() : null,
      dbPath: databasePath(db),
      backupDir: currentBackupDir(),
      offsiteDir: offsite?.dir ?? null,
    });
    recordSheetMade(db, key.fingerprint);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sheet });
  });

  router.post('/recovery-sheet/confirm', (req, res) => {
    requireOwnerSecure(req);
    const key = currentKey();
    const typed = (req.body as { lastSix?: unknown } | undefined)?.lastSix;
    if (!confirmsKey(key.secret, typed)) {
      throw badRequest('Those are not the last six characters of the key on the sheet. Check the sheet and type them again.', [
        { path: 'lastSix', message: 'Type the last six characters of the key' },
      ]);
    }
    const at = new Date();
    recordSheetConfirmed(db, key.fingerprint, at);
    res.json({ confirmedAt: at.toISOString(), fingerprint: shortFingerprint(key.fingerprint) });
  });

  return router;
}
