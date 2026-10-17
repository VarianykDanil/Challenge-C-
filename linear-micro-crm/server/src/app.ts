import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Db } from './db/connection.ts';
import { bumpDataVersion, responseCache } from './lib/cache.ts';
import { HttpError } from './lib/errors.ts';
import { authenticate, requireAuth } from './middleware/auth.ts';
import { announcementsRouter } from './routes/announcements.ts';
import { authRouter } from './routes/auth.ts';
import { campaignsRouter } from './routes/campaigns.ts';
import { dashboardRouter } from './routes/dashboard.ts';
import { eventsRouter } from './routes/events.ts';
import { financeRouter } from './routes/finance.ts';
import { gaugesRouter } from './routes/gauges.ts';
import { healthRouter } from './routes/health.ts';
import { leaderboardRouter } from './routes/leaderboard.ts';
import { recruitmentRouter } from './routes/recruitment.ts';
import { teamsRouter } from './routes/teams.ts';
import { usersRouter } from './routes/users.ts';

export interface AppOptions {
  /** When set (production), serve the built client from this folder with an SPA fallback. */
  staticDir?: string;
  /** Extra allowed CORS origins (the Vite dev server is always allowed). */
  corsOrigins?: string[];
  /**
   * Express `trust proxy` (env `TRUST_PROXY`). Default `false`: `req.ip`/`req.secure` come from the socket and
   * `X-Forwarded-*` headers are ignored, so nobody can forge an address or "HTTPS". Behind a reverse proxy that
   * rewrites `X-Forwarded-For` set it to the number of hops (`1`), the proxy's address/CIDR (`10.0.0.0/8`,
   * `loopback`) or a comma list — see `parseTrustProxy`.
   */
  trustProxy?: boolean | number | string;
}

/** `TRUST_PROXY` env → Express setting: unset/`0`/`false` → off; `true`; a hop count; otherwise an address list. */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = (value ?? '').trim();
  if (!v || v === '0' || /^false$/i.test(v)) return false;
  if (/^true$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * The Content-Security-Policy for the built client. Scripts are same-origin plus the SHA-256 of each inline
 * `<script>` in `index.html` (Vite emits the theme bootstrap inline), styles may be inline (React/Tailwind) or from
 * Google Fonts, fonts from gstatic, no framing, no foreign form targets or base URLs.
 */
export function contentSecurityPolicy(staticDir?: string): string {
  const hashes: string[] = [];
  const indexHtml = staticDir ? path.join(staticDir, 'index.html') : null;
  if (indexHtml && existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (m[1]!.trim()) hashes.push(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`);
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ` ${hashes.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Defence-in-depth headers on every response; HSTS only when the request itself arrived over HTTPS. */
export function securityHeaders(csp: string): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', csp);
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

/** Read-mostly aggregates served from the short-TTL cache (`lib/cache.ts`); every write invalidates them. */
const CACHED_PATHS = ['/me/dashboard', '/finance/summary', '/recruitment/summary', '/leaderboard', '/gauges/summary'];

export function createApp(db: Db, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? false);
  app.use(securityHeaders(contentSecurityPolicy(opts.staticDir)));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173', ...(opts.corsOrigins ?? [])],
      credentials: true,
      exposedHeaders: ['X-Total-Count', 'X-Cache'],
    }),
  );

  const api = express.Router();
  api.use(authenticate(db));
  // any write invalidates the aggregate cache before the handler runs (handlers are synchronous node:sqlite calls)
  api.use((req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') bumpDataVersion();
    next();
  });
  api.use('/health', healthRouter(db));
  api.use('/auth', authRouter(db));
  api.use(CACHED_PATHS, requireAuth, responseCache());
  // requireAuth is attached per router (not globally) so unknown /api paths always get the JSON 404 below.
  api.use('/me', requireAuth, dashboardRouter(db));
  api.use('/users', requireAuth, usersRouter(db));
  api.use('/teams', requireAuth, teamsRouter(db));
  api.use('/campaigns', requireAuth, campaignsRouter(db));
  api.use('/events', requireAuth, eventsRouter(db));
  api.use('/gauges', requireAuth, gaugesRouter(db));
  api.use('/leaderboard', requireAuth, leaderboardRouter(db));
  api.use('/finance', requireAuth, financeRouter(db));
  api.use('/recruitment', requireAuth, recruitmentRouter(db));
  api.use('/announcements', requireAuth, announcementsRouter(db));
  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const indexHtml = path.join(opts.staticDir, 'index.html');
    // Vite's hashed bundles never change under one name: cache them for a year, immutable.
    app.use('/assets', express.static(path.join(opts.staticDir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    // The shell (index.html) must always be revalidated or it would pin bundle names that no longer exist.
    app.use(
      express.static(opts.staticDir, {
        index: 'index.html',
        setHeaders: (res, filePath) => {
          res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
        },
      }),
    );
    // Express 5 wildcard syntax; API paths never reach here because the /api router answers 404 itself.
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(indexHtml, { cacheControl: false, headers: { 'Cache-Control': 'no-cache' } });
    });
  }

  app.use(errorHandler);
  return app;
}

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details });
    return;
  }
  const e = err as { type?: string; status?: number; code?: string; message?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  if (e?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(e.message ?? '')) {
    res.status(409).json({ error: 'A record with those unique fields already exists' });
    return;
  }
  if (e?.code === 'ERR_SQLITE_ERROR' && /CHECK constraint failed/.test(e.message ?? '')) {
    res.status(400).json({ error: 'A value is outside the range the database accepts' });
    return;
  }
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
    res.status(e.status).json({ error: e.message ?? 'Request error' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
