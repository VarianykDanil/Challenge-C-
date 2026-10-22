/**
 * Release 1.3 — OWNED BY P5 learning-videos. POST /videos/upload's body: multipart/form-data read with busboy as it
 * arrives, the video streamed straight to disk (never held in memory), at most VIDEO_MAX_BYTES (2 GB).
 *
 * Parts, in the order the client sends them (VIDEO_UPLOAD_FIELDS): the text fields, an optional `poster` (a JPEG
 * still of at most 600 KB, kept in memory; one that is too big or not a JPEG is simply left out), then `video`. When the
 * video part starts, `onVideoStart(fields)` checks the fields already received, so a form with a missing title fails
 * at once rather than after 2 GB. The file is written to media/videos/<uuid>.upload and the caller renames it; on any
 * failure the partial file is removed. The first bytes must be an MP4 / MOV or WebM container (sniffVideoContainer),
 * whatever the file's name or type say.
 *
 * Errors are HttpErrors: 400 (not multipart, no file, the upload cut off), 413 (over 2 GB, too many parts, a field
 * too long), 415 (not an MP4, WebM or MOV), 507 (the disk is full).
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, rmSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import busboy from 'busboy';
import { VIDEO_FILE_EXTENSIONS, VIDEO_LIMITS, VIDEO_MAX_BYTES, VIDEO_MIME_TYPES, type VideoMime } from '@lm/shared';
import { HttpError, badRequest } from '../errors.ts';
import { isJpeg, isQuickTime, sniffVideoContainer } from './files.ts';

export type VideoExtension = keyof typeof VIDEO_FILE_EXTENSIONS;

export interface ReceivedVideo {
  /** media/videos/<uuid>.upload, to be renamed by the caller. */
  tmpPath: string;
  uuid: string;
  size: number;
  mime: VideoMime;
  ext: VideoExtension;
  fileName: string;
}

export interface ReceivedUpload {
  fields: Record<string, string>;
  video: ReceivedVideo;
  /** A JPEG still, when one came with it. */
  poster: Buffer | null;
}

export interface ReceiveOptions {
  maxBytes?: number;
  /** Called with the fields received so far when the video part starts; throw to refuse the upload at once. */
  onVideoStart?: (fields: Record<string, string>) => void;
}

export const notAVideo = () => new HttpError(415, 'Upload an MP4, WebM or MOV video');
const tooBig = (maxBytes: number) => new HttpError(413, `Videos can be up to ${Math.round(maxBytes / 1024 ** 3) >= 1 ? `${Math.round(maxBytes / 1024 ** 3)} GB` : `${Math.round(maxBytes / 1024 ** 2)} MB`}`);

const MIME_SET: ReadonlySet<string> = new Set(VIDEO_MIME_TYPES);
const MIME_TO_EXT: Record<VideoMime, VideoExtension> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

function extensionOf(fileName: string): VideoExtension | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return ext in VIDEO_FILE_EXTENSIONS ? (ext as VideoExtension) : null;
}

/** The stored type and extension from what the bytes are, then what the name and the browser said. */
function storedType(head: Uint8Array, nameExt: VideoExtension | null, declared: string): { mime: VideoMime; ext: VideoExtension } | null {
  const container = sniffVideoContainer(head);
  if (container === 'webm') return { mime: 'video/webm', ext: 'webm' };
  if (container !== 'isobmff') return null;
  if (isQuickTime(head) || nameExt === 'mov' || declared === 'video/quicktime') return { mime: 'video/quicktime', ext: 'mov' };
  return { mime: 'video/mp4', ext: 'mp4' };
}

export function receiveVideoUpload(req: Request, dir: string, opts: ReceiveOptions = {}): Promise<ReceivedUpload> {
  const maxBytes = opts.maxBytes ?? VIDEO_MAX_BYTES;
  return new Promise<ReceivedUpload>((resolve, reject) => {
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    let poster: Buffer | null = null;
    let video: ReceivedVideo | null = null;
    let out: WriteStream | null = null;
    let writing: Promise<void> | null = null;
    let failed: HttpError | Error | null = null;
    let parsed = false;
    let settled = false;

    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { fields: 12, fieldSize: 16 * 1024, files: 2, parts: 16, fileSize: maxBytes },
      });
    } catch {
      reject(badRequest('Send the video as multipart/form-data'));
      return;
    }

    const cleanup = () => {
      if (video) rmSync(video.tmpPath, { force: true });
    };

    const fail = (err: HttpError | Error) => {
      if (failed) return;
      failed = err;
      req.unpipe(bb);
      const done = () => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      if (out && !out.closed) {
        out.once('close', done);
        out.destroy();
      } else done();
    };

    const finish = () => {
      if (failed || settled || !parsed) return;
      void (writing ?? Promise.resolve()).then(() => {
        if (failed || settled) return;
        if (!video) return fail(badRequest('Choose a video file to upload'));
        if (video.size === 0) return fail(badRequest('The video file is empty'));
        settled = true;
        resolve({ fields, video, poster });
      });
    };

    bb.on('field', (name, value, info) => {
      if (info.valueTruncated) return fail(new HttpError(413, `The ${name} field is too long`));
      if (!Object.hasOwn(fields, name)) fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      if (failed) return void stream.resume();
      if (name === 'poster') {
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= VIDEO_LIMITS.posterMaxBytes) chunks.push(c);
        });
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (size <= VIDEO_LIMITS.posterMaxBytes && !stream.truncated && isJpeg(buf)) poster = buf;
        });
        return;
      }
      if (name !== 'video') return void stream.resume();
      if (video) {
        stream.resume();
        return fail(badRequest('Send one video at a time'));
      }
      const nameExt = extensionOf(info.filename ?? '');
      const declared = (info.mimeType ?? '').toLowerCase();
      if (!nameExt && !MIME_SET.has(declared)) {
        stream.resume();
        return fail(notAVideo());
      }
      try {
        opts.onVideoStart?.(fields);
      } catch (err) {
        stream.resume();
        return fail(err as Error);
      }
      const uuid = randomUUID();
      const tmpPath = path.join(dir, `${uuid}.upload`);
      const declaredMime = MIME_SET.has(declared) ? (declared as VideoMime) : VIDEO_FILE_EXTENSIONS[nameExt!];
      video = { tmpPath, uuid, size: 0, mime: declaredMime, ext: nameExt ?? MIME_TO_EXT[declaredMime], fileName: info.filename ?? '' };
      const current = video;
      const file = createWriteStream(tmpPath, { flags: 'wx' });
      out = file;
      let head = Buffer.alloc(0);
      let checked = false;
      writing = new Promise<void>((done) => {
        file.on('close', () => done());
      });
      file.on('error', (err: NodeJS.ErrnoException) => {
        stream.resume();
        fail(err.code === 'ENOSPC' ? new HttpError(507, 'The server has no room for this video: free some disk space and try again') : err);
      });
      stream.on('data', (chunk: Buffer) => {
        current.size += chunk.length;
        if (!checked) {
          head = Buffer.concat([head, chunk]).subarray(0, 64);
          if (head.length >= 12 || current.size >= 12) {
            checked = true;
            const type = storedType(head, nameExt, declared);
            if (!type) {
              stream.resume();
              return fail(notAVideo());
            }
            current.mime = type.mime;
            current.ext = type.ext;
          }
        }
      });
      stream.on('limit', () => {
        stream.resume();
        fail(tooBig(maxBytes));
      });
      stream.on('end', () => {
        if (!checked && !failed) {
          checked = true;
          if (current.size > 0 && !storedType(head, nameExt, declared)) fail(notAVideo());
        }
      });
      stream.pipe(file);
    });

    bb.on('partsLimit', () => fail(new HttpError(413, 'Too many parts in the upload')));
    bb.on('filesLimit', () => fail(new HttpError(413, 'Too many files in the upload')));
    bb.on('fieldsLimit', () => fail(new HttpError(413, 'Too many fields in the upload')));
    bb.on('error', () => fail(badRequest('The upload was cut off before it finished: try again')));
    bb.on('close', () => {
      parsed = true;
      finish();
    });
    req.on('close', () => {
      if (!req.complete) fail(badRequest('The upload was cut off before it finished: try again'));
    });
    req.pipe(bb);
  });
}
