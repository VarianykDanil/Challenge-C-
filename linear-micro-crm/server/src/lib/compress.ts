/**
 * On-the-fly HTTP compression for phones on a mobile hotspot (p10), with the built-in node:zlib (no dependency).
 *
 * gzip (level 6) — or brotli (quality 4) when the client prefers it, i.e. ranks br above gzip with q-values, or accepts
 * only br — for JSON, HTML, JavaScript, CSS and SVG responses of 1 KB or more. Browsers list both without q-values
 * and get gzip: measured on this app, brotli at quality 4 is no smaller than gzip 6 (main bundle 139.8 KB v 138.7 KB,
 * dashboard JSON 2.77 KB v 2.81 KB) and costs ~70% more CPU on the JSON that makes up most of the traffic.
 *
 * A response is left alone when it is a HEAD, a 204/206/304 or another non-2xx status, already has a
 * Content-Encoding, says `Cache-Control: no-transform`, or the client sends no usable Accept-Encoding. Compressible
 * responses always carry `Vary: Accept-Encoding`.
 *
 * The body is collected and compressed in one go (every response here is small: the largest is a ~450 KB bundle),
 * so the compressed response has an exact Content-Length, a replay from the response cache (X-Cache: HIT) is
 * compressed like a fresh one, and Express's ETag / 304 handling is untouched (ETags are weak, so one ETag for both
 * encodings is correct). Bodies over 16 KB are compressed on the libuv thread pool so the event loop keeps serving.
 *
 * Nothing is precompressed at build time. Compressed bytes are remembered in two small in-memory LRUs keyed by
 * encoding, path and ETag: one for the immutable `/assets/*` bundles (Vite's hashed files), one for everything else
 * that has an ETag. Express derives an API response's ETag from a SHA-1 of its exact bytes and static files get
 * size + mtime, so equal keys mean equal bytes: a response-cache replay, or the same JSON fetched again, is not
 * compressed twice, and nobody can be sent bytes other than the ones the route produced for them.
 */
import zlib from 'node:zlib';
import type { RequestHandler } from 'express';

export const COMPRESSION_RULES = {
  /** Smaller bodies are sent as they are (compression would not pay for its headers). */
  minBytes: 1024,
  gzipLevel: 6,
  brotliQuality: 4,
  /** Bodies up to this size are compressed synchronously (faster than a thread-pool round trip). */
  syncMaxBytes: 16 * 1024,
  /** The /assets LRU: at most this many entries and this many compressed bytes. */
  assetCacheEntries: 64,
  assetCacheBytes: 12 * 1024 * 1024,
  /** The LRU for other responses with an ETag (API JSON, the SPA shell). */
  bodyCacheEntries: 512,
  bodyCacheBytes: 4 * 1024 * 1024,
} as const;

export type Coding = 'br' | 'gzip';

const COMPRESSIBLE = /^\s*(?:application\/(?:[\w.+-]+\+)?json|text\/html|(?:text|application)\/(?:x-)?javascript|text\/css|image\/svg\+xml)\s*(?:;|$)/i;

/** True for the content types this middleware compresses. */
export function isCompressibleType(contentType: string | undefined): boolean {
  return !!contentType && COMPRESSIBLE.test(contentType);
}

/**
 * The coding to use for an Accept-Encoding header: brotli when the client prefers it (br's q-value above gzip's), else
 * gzip when acceptable (q > 0), else brotli when only br is acceptable, else none. `*` stands in for codings not
 * listed. A tie (every browser: "gzip, deflate, br, zstd") goes to gzip.
 */
export function chooseEncoding(header: string | string[] | undefined): Coding | null {
  if (!header) return null;
  const text = Array.isArray(header) ? header.join(',') : header;
  let br: number | null = null;
  let gzip: number | null = null;
  let star: number | null = null;
  for (const part of text.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName!.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(p);
      if (m) q = Math.min(1, Number(m[1]));
    }
    if (name === 'br') br = q;
    else if (name === 'gzip' || name === 'x-gzip') gzip = q;
    else if (name === '*') star = q;
  }
  const qBr = br ?? star ?? 0;
  const qGzip = gzip ?? star ?? 0;
  if (qBr > qGzip) return 'br';
  if (qGzip > 0) return 'gzip';
  return null;
}

function brotliOptions(size: number): zlib.BrotliOptions {
  return {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: COMPRESSION_RULES.brotliQuality,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  };
}

/** Compress synchronously (small bodies) or on the thread pool. */
function compressBody(coding: Coding, body: Buffer, done: (err: Error | null, out: Buffer | null) => void): void {
  if (body.length <= COMPRESSION_RULES.syncMaxBytes) {
    try {
      done(null, coding === 'br' ? zlib.brotliCompressSync(body, brotliOptions(body.length)) : zlib.gzipSync(body, { level: COMPRESSION_RULES.gzipLevel }));
    } catch (err) {
      done(err as Error, null);
    }
    return;
  }
  const cb = (err: Error | null, out: Buffer) => done(err, err ? null : out);
  if (coding === 'br') zlib.brotliCompress(body, brotliOptions(body.length), cb);
  else zlib.gzip(body, { level: COMPRESSION_RULES.gzipLevel }, cb);
}

// ── the compressed-bytes LRUs ────────────────────────────────────────────────

/** A Map-backed LRU bounded by entry count and total bytes; a single value over a quarter of the budget is not kept. */
class BytesLru {
  private readonly map = new Map<string, Buffer>();
  private total = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key: string): Buffer | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit); // most recently used last
    }
    return hit;
  }

  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes / 4) return;
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.total -= old.length;
    }
    while (this.map.size >= this.maxEntries || this.total + value.length > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.total -= this.map.get(oldest)!.length;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
    this.total += value.length;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.total };
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

const assetCache = new BytesLru(COMPRESSION_RULES.assetCacheEntries, COMPRESSION_RULES.assetCacheBytes);
const bodyCache = new BytesLru(COMPRESSION_RULES.bodyCacheEntries, COMPRESSION_RULES.bodyCacheBytes);

/** Test hook and introspection: entries and bytes held by the /assets cache. */
export function assetCacheStats(): { entries: number; bytes: number } {
  return assetCache.stats();
}

/** Test hook and introspection: entries and bytes held by the cache for other responses. */
export function bodyCacheStats(): { entries: number; bytes: number } {
  return bodyCache.stats();
}

export function clearAssetCache(): void {
  assetCache.clear();
  bodyCache.clear();
}

// ── the middleware ───────────────────────────────────────────────────────────

type Chunk = string | Buffer | Uint8Array;
type Callback = (err?: Error | null) => void;
type WriteFn = (chunk: Chunk, encoding?: BufferEncoding | Callback, cb?: Callback) => boolean;
type EndFn = (chunk?: Chunk | Callback, encoding?: BufferEncoding | Callback, cb?: Callback) => unknown;

function toBuffer(chunk: Chunk, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function addVary(res: Parameters<RequestHandler>[1]): void {
  const vary = res.getHeader('Vary');
  const list = (Array.isArray(vary) ? vary.join(',') : vary === undefined ? '' : String(vary))
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (list.some((v) => v === '*' || v.toLowerCase() === 'accept-encoding')) return;
  res.setHeader('Vary', [...list, 'Accept-Encoding'].join(', '));
}

export function compression(): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'HEAD') return next();
    const coding = chooseEncoding(req.headers['accept-encoding']);
    // originalUrl, not req.path: inside a mounted router (express.static at /assets) req.url is rewritten
    const urlPath = req.originalUrl.split('?')[0]!;
    const write = res.write as unknown as WriteFn;
    const end = res.end as unknown as EndFn;
    const chunks: Buffer[] = [];
    let mode: 'undecided' | 'pass' | 'buffer' = 'undecided';

    const restore = () => {
      res.write = write as unknown as typeof res.write;
      res.end = end as unknown as typeof res.end;
    };

    /** Called on the first write/end, before any header is sent. */
    const decide = (endChunkBytes: number | null): void => {
      mode = 'pass';
      if (res.headersSent) return;
      const status = res.statusCode;
      if (status < 200 || status >= 300 || status === 204 || status === 206) return;
      const contentEncoding = res.getHeader('Content-Encoding');
      if (contentEncoding !== undefined && String(contentEncoding).toLowerCase() !== 'identity') return;
      if (!isCompressibleType(res.getHeader('Content-Type') as string | undefined)) return;
      if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') ?? ''))) return;
      addVary(res);
      if (!coding) return;
      const declared = res.getHeader('Content-Length');
      const length = declared !== undefined ? Number(declared) : endChunkBytes;
      if (length !== null && Number.isFinite(length) && length < COMPRESSION_RULES.minBytes) return;
      mode = 'buffer';
    };

    const finish = (cb: Callback | undefined): void => {
      const body = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      restore();
      const sendRaw = () => {
        res.setHeader('Content-Length', body.length);
        end.call(res, body, cb);
      };
      if (body.length < COMPRESSION_RULES.minBytes || !coding) return sendRaw();
      const sendCompressed = (out: Buffer) => {
        res.setHeader('Content-Encoding', coding);
        res.setHeader('Content-Length', out.length);
        res.removeHeader('Accept-Ranges');
        end.call(res, out, cb);
      };
      const etag = res.getHeader('ETag');
      const key = etag === undefined ? null : `${coding} ${urlPath} ${String(etag)}`;
      const lru = urlPath.startsWith('/assets/') && /\bimmutable\b/.test(String(res.getHeader('Cache-Control') ?? '')) ? assetCache : bodyCache;
      const cached = key ? lru.get(key) : undefined;
      if (cached) return sendCompressed(cached);
      compressBody(coding, body, (err, out) => {
        if (err || !out) return sendRaw();
        if (key) lru.set(key, out);
        sendCompressed(out);
      });
    };

    res.write = function (chunk: Chunk, encoding?: BufferEncoding | Callback, cb?: Callback): boolean {
      if (mode === 'undecided') decide(null);
      if (mode === 'pass') {
        restore();
        return write.call(res, chunk, encoding, cb);
      }
      chunks.push(toBuffer(chunk, typeof encoding === 'string' ? encoding : undefined));
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (callback) process.nextTick(callback);
      return true;
    } as unknown as typeof res.write;

    res.end = function (chunk?: Chunk | Callback, encoding?: BufferEncoding | Callback, cb?: Callback) {
      let data: Chunk | undefined;
      let enc: BufferEncoding | undefined;
      let callback: Callback | undefined;
      if (typeof chunk === 'function') callback = chunk;
      else {
        data = chunk;
        if (typeof encoding === 'function') callback = encoding;
        else {
          enc = encoding;
          callback = cb;
        }
      }
      const hasData = data !== undefined && data !== null;
      if (mode === 'undecided') decide(!hasData ? 0 : typeof data === 'string' ? Buffer.byteLength(data, enc ?? 'utf8') : (data as Uint8Array).byteLength);
      if (mode === 'pass') {
        restore();
        return end.call(res, chunk, encoding, cb);
      }
      if (hasData) chunks.push(toBuffer(data!, enc));
      finish(callback);
      return res;
    } as unknown as typeof res.end;

    next();
  };
}
