/**
 * Kind 'system' in the Needs-attention feed, for administrators: the problems nobody sees unless they go looking.
 *
 *  - the last backup failed, or there has been none for 36 hours (a fresh install gets 36 hours first);
 *  - off-site copies: the last one failed, it cannot run (no passphrase, the folder is missing), or the newest is older
 *    than two days; when off-site copies are not switched on, one quiet line says the backups are on this computer only;
 *  - the disk that holds the data is nearly full;
 *  - the app key is not on a recovery sheet yet (the owner makes it; other administrators are told to ask the owner);
 *  - server errors in the last 24 hours (lib/errorLog.ts), with where the details are;
 *  - the database was restored over payments it does not know about (for 14 days after the restore).
 * One statement (the meta values) per call; the rest is the file system, so the feed's budget holds. Backups and the
 * server's errors are about the real clock, not the business day.
 */
import { statfsSync } from 'node:fs';
import path from 'node:path';
import type { AttentionItem } from '@lm/shared';
import { all } from '../../db/connection.ts';
import { BACKUP_FAILURE_META, BACKUP_RULES, backupScheduleOn, currentBackupDir, formatBytes, listBackups } from '../backup.ts';
import { currentAppSecret, secretFingerprint } from '../crypto.ts';
import { errorLogFile, serverErrorsSince } from '../errorLog.ts';
import { OFFSITE_META, OFFSITE_RULES, offsiteProblem, type OffsiteConfig } from '../offsite.ts';
import { SHEET_META } from '../recoverySheet.ts';
import { RESTORE_WARNING_META } from '../restoreCheck.ts';
import type { AttentionProvider } from './types.ts';

const HOUR = 3_600_000;
/** Warn when less than this is free on the data disk (danger under a fifth of it). */
export const LOW_DISK_BYTES = 1024 ** 3;
const RESTORE_WARNING_DAYS = 14;

interface SystemHealthConfig {
  /** The folder that holds the database (for the disk check); null skips it. */
  dataDir: string | null;
  offsite: OffsiteConfig | null;
  /** Free and total bytes of the disk that holds a folder (tests replace it). */
  diskSpace: (dir: string, now: number) => { free: number; total: number } | null;
}

let config: SystemHealthConfig = { dataDir: null, offsite: null, diskSpace: (dir, now) => disk(dir, now) };

/** index.ts: where the data lives and the off-site settings this server runs with. */
export function configureSystemHealth(c: Partial<SystemHealthConfig>): void {
  config = { ...config, ...c };
}

let diskCache: { at: number; dir: string; free: number; total: number } | null = null;
/** Free and total bytes on the disk that holds `dir`, at most once a minute. */
function disk(dir: string, now: number): { free: number; total: number } | null {
  if (diskCache && diskCache.dir === dir && now - diskCache.at < 60_000) return diskCache;
  try {
    const s = statfsSync(dir);
    diskCache = { at: now, dir, free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    return diskCache;
  } catch {
    return null;
  }
}

const hoursText = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} days` : `${Math.max(1, Math.round(h))} hours`);
const SETTINGS = '/settings#backups';

export const provider: AttentionProvider = {
  name: 'system',
  items(db, me) {
    if (me.role !== 'admin') return [];
    const now = Date.now();
    const keys = [
      'last_backup_at',
      BACKUP_FAILURE_META.at,
      BACKUP_FAILURE_META.message,
      OFFSITE_META.at,
      OFFSITE_META.errorAt,
      OFFSITE_META.error,
      SHEET_META.confirmedFor,
      'seeded_at',
      RESTORE_WARNING_META,
    ];
    const m = Object.fromEntries(
      all<{ key: string; value: string }>(db, `SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys).map((r) => [r.key, r.value]),
    );
    const items: AttentionItem[] = [];
    const t = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

    // backups: the newer of the meta record and the newest file (a restore brings back an older meta record)
    const newest = listBackups(currentBackupDir())[0];
    const lastOk = Math.max(Number.isFinite(t(m.last_backup_at)) ? t(m.last_backup_at) : 0, newest?.mtimeMs ?? 0) || null;
    const failedAt = t(m[BACKUP_FAILURE_META.at]);
    if (Number.isFinite(failedAt) && (!lastOk || failedAt > lastOk)) {
      items.push({
        key: `system:backup-failed:${m[BACKUP_FAILURE_META.at]}`,
        kind: 'system',
        severity: 'danger',
        title: 'The last backup failed',
        body: `${(m[BACKUP_FAILURE_META.message] ?? '').slice(0, 160)} Linear Hub tries again at the next check. If it keeps failing, run npm run doctor on the server.`.trim(),
        href: SETTINGS,
        at: m[BACKUP_FAILURE_META.at],
      });
    } else if (!backupScheduleOn()) {
      items.push({
        key: 'system:backups-off',
        kind: 'system',
        severity: 'warning',
        title: 'Automatic backups are off',
        body: 'This server was started with LM_BACKUP=0, so it makes no nightly backups. Run npm run backup on the server, or start it without LM_BACKUP=0.',
        href: SETTINGS,
      });
    } else {
      const since = lastOk ?? (Number.isFinite(t(m.seeded_at)) ? t(m.seeded_at) : null);
      const age = since ? (now - since) / HOUR : Number.POSITIVE_INFINITY;
      if (age > BACKUP_RULES.staleHours) {
        items.push({
          key: `system:backup-old:${lastOk ?? 'none'}`,
          kind: 'system',
          severity: 'warning',
          title: lastOk ? `No backup for ${hoursText(age)}` : 'No backup yet',
          body: 'Backups only run while Linear Hub is running. Leave the server on overnight, or run npm run backup on it now.',
          href: SETTINGS,
          ...(lastOk ? { at: new Date(lastOk).toISOString() } : {}),
        });
      }
    }

    // off-site copies
    if (config.offsite) {
      const okAt = t(m[OFFSITE_META.at]);
      const errAt = t(m[OFFSITE_META.errorAt]);
      const problem = offsiteProblem(config.offsite);
      if (problem || (Number.isFinite(errAt) && (!Number.isFinite(okAt) || errAt > okAt))) {
        items.push({
          key: `system:offsite-failed:${problem ? 'setup' : m[OFFSITE_META.errorAt]}`,
          kind: 'system',
          severity: 'danger',
          title: 'The off-site backup copy is failing',
          body: `${(problem ?? m[OFFSITE_META.error] ?? '').slice(0, 200)} The backups on the server itself are still made.`.trim(),
          href: SETTINGS,
          ...(Number.isFinite(errAt) ? { at: m[OFFSITE_META.errorAt] } : {}),
        });
      } else if (!Number.isFinite(okAt)) {
        items.push({
          key: 'system:offsite-first',
          kind: 'system',
          severity: 'info',
          title: 'No off-site copy yet',
          body: 'Off-site copies are switched on. The first one is made with the next backup, or run npm run backup on the server now.',
          href: SETTINGS,
        });
      } else if ((now - okAt) / HOUR > OFFSITE_RULES.staleHours) {
        items.push({
          key: `system:offsite-old:${m[OFFSITE_META.at]}`,
          kind: 'system',
          severity: 'warning',
          title: `No off-site copy for ${hoursText((now - okAt) / HOUR)}`,
          body: 'The newest backups have not reached the off-site folder. Check that the cloud drive is connected, then run npm run backup on the server.',
          href: SETTINGS,
          at: m[OFFSITE_META.at],
        });
      }
    } else {
      items.push({
        key: 'system:offsite-none',
        kind: 'system',
        severity: 'info',
        title: 'Backups are on this computer only',
        body: 'If the computer is lost or broken, the backups go with it. Noryn can switch on encrypted off-site copies (LM_OFFSITE_DIR).',
        href: SETTINGS,
      });
    }

    // disk space
    if (config.dataDir) {
      const d = config.diskSpace(config.dataDir, now);
      if (d && d.free < LOW_DISK_BYTES) {
        const critical = d.free < LOW_DISK_BYTES / 5;
        items.push({
          key: `system:disk:${critical ? 'critical' : 'low'}`,
          kind: 'system',
          severity: critical ? 'danger' : 'warning',
          title: `Only ${formatBytes(d.free)} free on the server's disk`,
          body: 'Saves and backups fail when the disk is full. Free some space on the server (old downloads, the Bin), or ask Noryn.',
          href: SETTINGS,
        });
      }
    }

    // the app key on paper
    const secret = currentAppSecret();
    if (secret && m[SHEET_META.confirmedFor] !== secretFingerprint(secret.secret)) {
      const owner = me.position === 'owner';
      items.push({
        key: 'system:recovery-sheet',
        kind: 'system',
        severity: 'warning',
        title: 'The app key is not on a recovery sheet yet',
        body: owner
          ? 'Bank details and two-step sign-in are locked with it. Make the recovery sheet, print it and lock it away: without it, losing the server loses them.'
          : 'Bank details and two-step sign-in are locked with it. Ask the owner to make the recovery sheet in Settings › Backups.',
        href: SETTINGS,
        ...(owner ? { actionLabel: 'Make it' } : {}),
      });
    }

    // server errors
    const errors = serverErrorsSince(24 * HOUR, new Date(now));
    if (errors > 0) {
      const file = errorLogFile();
      items.push({
        key: `system:errors:${errors}`,
        kind: 'system',
        severity: 'warning',
        title: `${errors} server error${errors === 1 ? '' : 's'} in the last 24 hours`,
        body: `Something went wrong on the server${errors === 1 ? '' : ` ${errors} times`}. The details are in ${file ? path.basename(path.dirname(file)) + '/' + path.basename(file) : 'the server log'} in the data folder: if people saw errors, send that file to Noryn.`,
        href: SETTINGS,
        count: errors,
      });
    }

    // a restore over payments
    const restored = m[RESTORE_WARNING_META];
    if (restored) {
      try {
        const w = JSON.parse(restored) as { at: string; backup: string; sent: number; approved: number; bankFiles: number; bankDetails: number; paidRuns: number };
        if (now - Date.parse(w.at) < RESTORE_WARNING_DAYS * 24 * HOUR) {
          items.push({
            key: `system:restored:${w.at}`,
            kind: 'system',
            severity: 'danger',
            title: 'Restored from an older backup: check payments with the bank',
            body:
              `The database was restored from ${w.backup}, which did not have some payments, bank files or bank details changes. ` +
              'Before paying anyone, check each payment against the bank statement, so nobody is paid twice or to old bank details.',
            href: '/finance/pay',
            at: w.at,
          });
        }
      } catch {
        // an unreadable record says nothing
      }
    }
    return items;
  },
};
