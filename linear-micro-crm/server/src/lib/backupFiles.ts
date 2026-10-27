/**
 * The uploaded files that live beside the database, in the backups too.
 *
 * Client statement PDFs (the evidence for commission), the office's signature image and, when LM_BACKUP_VIDEOS=1,
 * the learning videos are not in the database file. Each backup now gets a snapshot of them next to it:
 * `linear-2026-10-27-0200.sqlite` + `linear-2026-10-27-0200.files/` (`statements/`, `uploads/`, `media/`). A file that
 * has not changed since the previous snapshot (same size and modification time) is a hard link to that snapshot's
 * copy, so a nightly snapshot costs almost no extra disk. Rotation removes a snapshot with its database file, and
 * restore puts the snapshot of the chosen backup back.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';

/** The folders kept beside the database (lib/backup.ts foldersOutsideBackup resolves them as the server does). */
export interface DataFolders {
  /** Learning videos: `<data dir>/media` (uploads in media/videos). */
  media: string;
  /** Client statement PDFs. */
  statements: string;
  /** The signature image. */
  uploads: string;
}

/** The parts of a snapshot, in order, and the folder each comes from. */
export function snapshotParts(folders: DataFolders, includeVideos: boolean): Array<[string, string]> {
  return [
    ['statements', folders.statements],
    ['uploads', folders.uploads],
    ...(includeVideos ? ([['media', folders.media]] as Array<[string, string]>) : []),
  ];
}

/** `LM_BACKUP_VIDEOS=1`: put the learning videos in the backups too (off by default: they can be large). */
export function backupVideos(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LM_BACKUP_VIDEOS?.trim() === '1';
}

/** `linear-2026-10-27-0200.sqlite` → `linear-2026-10-27-0200.files`. */
export function filesSnapshotName(backupName: string): string {
  return backupName.replace(/\.sqlite$/, '.files');
}

export const FILES_SNAPSHOT_RE = /^linear-\d{4}-\d{2}-\d{2}-\d{4}\.files$/;
/** A snapshot being written (`.linear-…files.<pid>.partial`). */
export const FILES_PARTIAL_RE = /^\.linear-\d{4}-\d{2}-\d{2}-\d{4}\.files\.\d+\.partial$/;

/** Every regular file under `dir`, as paths relative to it (links and other special files are skipped). */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(path.join(dir, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const r = rel ? path.join(rel, name) : name;
      let st;
      try {
        st = lstatSync(path.join(dir, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(r);
      else if (st.isFile()) out.push(r);
    }
  };
  visit('');
  return out;
}

export interface SnapshotResult {
  /** The snapshot folder. */
  dir: string;
  files: number;
  bytes: number;
  /** Files shared with the previous snapshot (hard links). */
  linked: number;
}

/** The newest snapshot in `backupDir` older than `name`, or null. */
function previousSnapshot(backupDir: string, name: string): string | null {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return null;
  }
  const older = names.filter((n) => FILES_SNAPSHOT_RE.test(n) && n < name).sort();
  return older.length ? path.join(backupDir, older.at(-1)!) : null;
}

/**
 * Writes `<backupDir>/<backup name>.files/` with the files of every part. Staged under a private name and renamed into
 * place, so a half-written snapshot never carries the backup's name.
 */
export function snapshotFiles(folders: DataFolders, backupDir: string, backupName: string, opts: { includeVideos: boolean }): SnapshotResult {
  const name = filesSnapshotName(backupName);
  const target = path.join(backupDir, name);
  const staging = path.join(backupDir, `.${name}.${process.pid}.partial`);
  const previous = previousSnapshot(backupDir, name);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  let files = 0;
  let bytes = 0;
  let linked = 0;
  try {
    for (const [part, source] of snapshotParts(folders, opts.includeVideos)) {
      for (const rel of walkFiles(source)) {
        const src = path.join(source, rel);
        const dest = path.join(staging, part, rel);
        mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        const st = statSync(src);
        // same size and modification time (to the millisecond; the copy's time is set from the original) → unchanged
        const before = previous ? path.join(previous, part, rel) : null;
        let done = false;
        if (before) {
          try {
            const old = statSync(before);
            if (old.size === st.size && Math.abs(old.mtimeMs - st.mtimeMs) < 2) {
              linkSync(before, dest);
              linked++;
              done = true;
            }
          } catch {
            // not in the previous snapshot, or links are not possible here: copy instead
          }
        }
        if (!done) {
          copyFileSync(src, dest);
          utimesSync(dest, st.atime, st.mtime);
        }
        files++;
        bytes += st.size;
      }
    }
    rmSync(target, { recursive: true, force: true }); // a second backup in the same minute replaces the first
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return { dir: target, files, bytes, linked };
}

const sameContent = (a: string, b: string): boolean => {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  return hash(a) === hash(b);
};

export interface FilesRestoreResult {
  /** Files put back (they were missing or different). */
  restored: number;
  /** Files that were already the same. */
  unchanged: number;
  /** Different files that were there, kept as `<name>.before-restore-<time>`. */
  setAside: number;
  /** Which parts the snapshot had ('statements', 'uploads', 'media'). */
  parts: string[];
}

/**
 * Puts a snapshot's files back into the live folders. A file that is missing is copied back; one that differs is
 * kept as `<name>.before-restore-<stamp>` and replaced; files that exist only in the live folders (added after the
 * backup) are left alone.
 */
export function restoreFiles(snapshotDir: string, folders: DataFolders, stamp: string): FilesRestoreResult {
  const result: FilesRestoreResult = { restored: 0, unchanged: 0, setAside: 0, parts: [] };
  const targets: Record<string, string> = { statements: folders.statements, uploads: folders.uploads, media: folders.media };
  for (const part of ['statements', 'uploads', 'media']) {
    const from = path.join(snapshotDir, part);
    if (!existsSync(from)) continue;
    result.parts.push(part);
    for (const rel of walkFiles(from)) {
      const src = path.join(from, rel);
      const dest = path.join(targets[part]!, rel);
      if (existsSync(dest)) {
        if (sameContent(src, dest)) {
          result.unchanged++;
          continue;
        }
        renameSync(dest, `${dest}.before-restore-${stamp}`);
        result.setAside++;
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      result.restored++;
    }
  }
  return result;
}
