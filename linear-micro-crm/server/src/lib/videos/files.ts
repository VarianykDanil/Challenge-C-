/**
 * Release 1.3 — OWNED BY P5 learning-videos. Where learning-video files live and how they are read:
 *
 *  - the media folder sits next to the database: <data dir>/media (server/data/media by default, so DB_PATH moves it
 *    too), uploads in media/videos/<uuid>.<ext> with an optional still <uuid>.jpg; the database stores the path
 *    relative to the media folder ("videos/<uuid>.mp4"), so the folder can move with the data. An in-memory database
 *    (tests) gets a temporary folder; configureMediaRoot() points it anywhere (tests).
 *  - parseRangeHeader: the HTTP Range header of a stream request (RFC 9110 §14), one range, as byte offsets.
 *  - sniffVideoContainer: the first bytes of an upload, so a file that is not an MP4 / MOV or WebM is refused whatever
 *    its name says; isJpeg for the still.
 *  - mp4DurationSeconds: an MP4 / MOV's own length from its `moov` → `mvhd` box (wherever `moov` sits in the file).
 *  - diskSpaceAt / uploadRoomBytes: the free space of the disk the media folder is on, and how much of it an upload
 *    may use (it leaves a tenth of the disk, at most 500 MB, for the database, its backups and everything else).
 * The nightly backup copies the database only: the media folder is backed up by hand (P5's Owner notes).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../../db/connection.ts';

export const MEDIA_VIDEOS_DIR = 'videos';

let configuredRoot: string | null = null;

/** Tests: put the media folder here (null: back to the default next to the database). */
export function configureMediaRoot(dir: string | null): void {
  configuredRoot = dir;
}

/**
 * The media folder of this database: next to its file, or (an in-memory database) a folder of this process under the
 * system's temporary folder. Nothing is created here: videosDirFor creates media/videos when a file is written.
 */
export function mediaRootFor(db: Db): string {
  if (configuredRoot) return configuredRoot;
  let file = '';
  try {
    const rows = db.prepare(`PRAGMA database_list`).all() as { name: string; file: string }[];
    file = rows.find((r) => r.name === 'main')?.file ?? '';
  } catch {
    file = '';
  }
  if (file) return path.join(path.dirname(file), 'media');
  return path.join(os.tmpdir(), `lm-media-${process.pid}`);
}

/** media/videos (not created). */
export function videosPathFor(db: Db): string {
  return path.join(mediaRootFor(db), MEDIA_VIDEOS_DIR);
}

/** media/videos, created when missing (before a file is written there). */
export function videosDirFor(db: Db): string {
  const dir = videosPathFor(db);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What the database stores for a file in media/videos. */
export function storedPathOf(fileName: string): string {
  return `${MEDIA_VIDEOS_DIR}/${fileName}`;
}

const STORED_PATH = /^videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm|mov|jpg)$/;

/** The absolute path of a stored file, or null for anything that is not one of ours (no way out of the folder). */
export function resolveStoredPath(db: Db, stored: string | null | undefined): string | null {
  if (!stored || !STORED_PATH.test(stored)) return null;
  return path.join(mediaRootFor(db), ...stored.split('/'));
}

/** Removes a stored file; a file already gone is fine. */
export function removeStoredFile(db: Db, stored: string | null | undefined): void {
  const file = resolveStoredPath(db, stored);
  if (!file) return;
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Could not remove ${file}`, err);
  }
}

/** Unfinished uploads (`*.upload`) older than a day: left by a server stopped mid-upload. Returns how many went. */
export function removeStaleUploads(dir: string, now = Date.now(), maxAgeMs = 86_400_000): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.upload')) continue;
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      /* gone already */
    }
  }
  return removed;
}

// ───────────────────────────── disk space ─────────────────────────────

export interface DiskSpace {
  /** Bytes this process may still write. */
  freeBytes: number;
  /** The size of the whole disk (volume). */
  totalBytes: number;
}

let diskProbe: ((dir: string) => DiskSpace | null) | null = null;

/** Tests: what the disk reports (null: ask the operating system). */
export function configureDiskSpace(fn: ((dir: string) => DiskSpace | null) | null): void {
  diskProbe = fn;
}

/** The disk the folder (or its nearest existing parent) is on; null when the system cannot say. */
export function diskSpaceAt(dir: string): DiskSpace | null {
  if (diskProbe) return diskProbe(dir);
  let at = path.resolve(dir);
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    const s = statfsSync(at);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/** What an upload leaves free on the disk: a tenth of it, at most 500 MB (a 1 GB cloud volume keeps 100 MB). */
export const UPLOAD_RESERVE_MAX_BYTES = 500 * 1024 * 1024;

export function uploadReserveBytes(totalBytes: number): number {
  return Math.min(UPLOAD_RESERVE_MAX_BYTES, Math.floor(Math.max(0, totalBytes) / 10));
}

/** Bytes an upload may take on this disk now (never negative). */
export function uploadRoomBytes(space: DiskSpace): number {
  return Math.max(0, space.freeBytes - uploadReserveBytes(space.totalBytes));
}

/** "312 MB", "1.4 GB", "820 KB" (as the client writes sizes). */
export function formatByteSize(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

// ───────────────────────────── HTTP Range ─────────────────────────────

export type RangeAnswer = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * One byte range of a file of `size` bytes, inclusive offsets: "bytes=0-1023" → 0–1023, "bytes=1000-" → 1000 to the
 * end, "bytes=-500" → the last 500 bytes, an end past the file → the end. A start at or past the end, or a suffix of
 * 0 bytes, is unsatisfiable (416). No header, another unit, several ranges or anything malformed → the whole file
 * (a server may ignore a Range header it does not serve).
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeAnswer {
  if (!header) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'full' };
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'full' };
  if (m[2] !== '' && end < start) return { kind: 'full' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

// ───────────────────────────── what a file is ─────────────────────────────

export type VideoContainer = 'isobmff' | 'webm';

/** ISO base media (MP4 / MOV) boxes a file can start with. */
const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);

/** The container of a file from its first 12 bytes: MP4 / MOV (ISO base media) or WebM (Matroska); null otherwise. */
export function sniffVideoContainer(head: Uint8Array): VideoContainer | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (head.length < 8) return null;
  const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
  if (!FIRST_BOXES.has(type)) return null;
  const size = ((head[0]! << 24) >>> 0) + (head[1]! << 16) + (head[2]! << 8) + head[3]!;
  return size === 0 || size === 1 || size >= 8 ? 'isobmff' : null;
}

/** A QuickTime file (`ftyp` with the "qt  " brand): stored and streamed as video/quicktime. */
export function isQuickTime(head: Uint8Array): boolean {
  return head.length >= 12 && String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!) === 'ftyp' && String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!) === 'qt  ';
}

export function isJpeg(head: Uint8Array): boolean {
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

// ───────────────────────────── an MP4's length ─────────────────────────────

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type ByteReader = (offset: number, length: number) => Uint8Array;

const MAX_BOXES = 10_000;

const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4);
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** The boxes between `from` and `to`: [type, start of its body, end]; stops at the first broken box. */
function* boxes(read: ByteReader, from: number, to: number): Generator<[string, number, number]> {
  let at = from;
  for (let n = 0; n < MAX_BOXES && at + 8 <= to; n++) {
    const h = read(at, 16);
    if (h.length < 8) return;
    let size = u32(h, 0);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) return;
      size = u64(h, 8);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield [fourcc(h, 4), at + header, at + size];
    at += size;
  }
}

/**
 * The length in whole seconds from the `mvhd` box inside `moov` (version 0: 32-bit timescale and duration after the
 * two dates; version 1: 64-bit dates and duration); null when there is none, the timescale is 0 or the duration is
 * unknown (all ones).
 */
export function mp4DurationFrom(read: ByteReader, size: number): number | null {
  for (const [type, body, end] of boxes(read, 0, size)) {
    if (type !== 'moov') continue;
    for (const [child, start] of boxes(read, body, end)) {
      if (child !== 'mvhd') continue;
      const b = read(start, 32);
      if (b.length < 20) return null;
      const version = b[0];
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (b.length < 32) return null;
        timescale = u32(b, 20);
        duration = u64(b, 24);
        if (u32(b, 24) === 0xffffffff && u32(b, 28) === 0xffffffff) return null;
      } else {
        timescale = u32(b, 12);
        duration = u32(b, 16);
        if (duration === 0xffffffff) return null;
      }
      if (!timescale || !duration) return null;
      return Math.round(duration / timescale);
    }
    return null;
  }
  return null;
}

/** mp4DurationFrom on a file; null for a file it cannot read. */
export function mp4DurationSeconds(file: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const handle = fd;
    const read: ByteReader = (offset, length) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      const n = buf.length ? readSync(handle, buf, 0, buf.length, offset) : 0;
      return buf.subarray(0, n);
    };
    return mp4DurationFrom(read, size);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
