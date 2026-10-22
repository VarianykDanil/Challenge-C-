/**
 * P5 learning-videos test fixtures: tiny hand-built media files (ISO base media boxes, a WebM header, a JPEG) and a
 * multipart upload helper. Not a test file itself (no .test.ts), so node --test does not run it.
 */
import type { TestClient } from './helpers.ts';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** An ISO base media box: 32-bit size, the four-character type, the body. */
export function box(type: string, ...body: Uint8Array[]): Buffer {
  const content = Buffer.concat(body);
  return Buffer.concat([u32(8 + content.length), Buffer.from(type, 'latin1'), content]);
}

/** The same with a 64-bit "largesize" (size field 1). */
export function largeBox(type: string, ...body: Uint8Array[]): Buffer {
  const content = Buffer.concat(body);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(16 + content.length));
  return Buffer.concat([u32(1), Buffer.from(type, 'latin1'), size, content]);
}

/** mvhd version 0: version + flags, creation, modification, timescale, duration (32-bit), then the rest zeroed. */
export function mvhdV0(timescale: number, duration: number): Buffer {
  return box('mvhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80));
}

/** mvhd version 1: 64-bit creation and modification, 32-bit timescale, 64-bit duration. */
export function mvhdV1(timescale: number, duration: bigint): Buffer {
  const d = Buffer.alloc(8);
  d.writeBigUInt64BE(duration);
  return box('mvhd', Buffer.from([1, 0, 0, 0]), Buffer.alloc(8), Buffer.alloc(8), u32(timescale), d, Buffer.alloc(80));
}

export function ftyp(brand = 'isom'): Buffer {
  return box('ftyp', Buffer.from(brand, 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1'));
}

/** Deterministic "video data". */
export function payload(bytes: number, salt = 7): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (i * 31 + salt) & 0xff;
  return b;
}

export interface Mp4Options {
  timescale?: number;
  duration?: number;
  /** moov after mdat (a file not "fast-started"). */
  moovLast?: boolean;
  mdatBytes?: number;
  brand?: string;
}

/** A minimal MP4 (or MOV with brand 'qt  '): ftyp, moov → mvhd, mdat. 12 s by default. */
export function sampleMp4(o: Mp4Options = {}): Buffer {
  const moov = box('moov', mvhdV0(o.timescale ?? 1000, o.duration ?? 12_000));
  const mdat = box('mdat', payload(o.mdatBytes ?? 4000));
  return Buffer.concat(o.moovLast ? [ftyp(o.brand), mdat, moov] : [ftyp(o.brand), moov, mdat]);
}

/** The start of a WebM file (EBML header) and some data. */
export function sampleWebm(bytes = 3000): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]), payload(bytes, 3)]);
}

/** A (not decodable, but correctly marked) JPEG. */
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), payload(200, 9), Buffer.from([0xff, 0xd9])]);

export interface UploadParts {
  fields?: Record<string, string>;
  poster?: Buffer | null;
  video?: { bytes: Uint8Array; name: string; type: string } | null;
}

/** POST /videos/upload as the browser sends it: the fields, the poster, then the video (FormData, multipart). */
export async function uploadVideo(base: string, as: TestClient | null, parts: UploadParts): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const form = new FormData();
  for (const [k, v] of Object.entries(parts.fields ?? {})) form.append(k, v);
  if (parts.poster) form.append('poster', new Blob([new Uint8Array(parts.poster)], { type: 'image/jpeg' }), 'poster.jpg');
  if (parts.video) form.append('video', new Blob([new Uint8Array(parts.video.bytes)], { type: parts.video.type }), parts.video.name);
  const res = await fetch(`${base}/videos/upload`, { method: 'POST', body: form, headers: as?.cookie ? { cookie: as.cookie } : {} });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
