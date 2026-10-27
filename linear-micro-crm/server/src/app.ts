import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Db } from './db/connection.ts';
import { bumpDataVersion, responseCache } from './lib/cache.ts';
import { compression } from './lib/compress.ts';
import { logServerError } from './lib/errorLog.ts';
import { HttpError } from './lib/errors.ts';
import { authenticate, pinSetupGate, requireAuth } from './middleware/auth.ts';
import { perUserWriteLimit } from './middleware/writeLimit.ts';
import { auditMiddleware } from './lib/audit.ts';
import { announcementsRouter } from './routes/announcements.ts';
import { authRouter } from './routes/auth.ts';
import { campaignsRouter } from './routes/campaigns.ts';
import { dashboardRouter } from './routes/dashboard.ts';
import { eventsRouter } from './routes/events.ts';
import { financeRouter } from './routes/finance.ts';
import { gaugesRouter } from './routes/gauges.ts';
import { attentionRouter } from './routes/attention.ts';
import { digestRouter } from './routes/digest.ts';
import { healthRouter } from './routes/health.ts';
import { insightsRouter } from './routes/insights.ts';
import { leaderboardRouter } from './routes/leaderboard.ts';
import { recruitmentRouter } from './routes/recruitment.ts';
import { teamsRouter } from './routes/teams.ts';
import { usersRouter } from './routes/users.ts';
// Release 1.2 (r2-foundation mounts every package's router; each file names its owner)
import { announcementReadsRouter, auditRouter } from './routes/audit.ts';
import { bulkGaugesRouter } from './routes/bulkGauges.ts';
import { checkinsRouter } from './routes/checkins.ts';
import { learningRouter } from './routes/learning.ts';
import { payExportRouter } from './routes/payExport.ts';
import { pitchesRouter } from './routes/pitches.ts';
import { searchRouter } from './routes/search.ts';
// Release 1.3 (r3-foundation mounts every package's router; each file names its owner)
import { clientGuard } from './middleware/clientGuard.ts';
import { recordApiMount } from './lib/routeTable.ts';
import { VIDEO_EMBED_ORIGINS, VIDEO_THUMBNAIL_ORIGINS } from './lib/videoEmbeds.ts';
import { auditEventsRouter } from './routes/auditEvents.ts';
import { campaignPagesRouter } from './routes/campaignPages.ts';
import { clientRouter } from './routes/client.ts';
import { clientAccountsRouter, clientPostsRouter } from './routes/clientOffice.ts';
import { eventPlansRouter } from './routes/eventPlans.ts';
import { invoicesRouter } from './routes/invoices.ts';
import { payRouter } from './routes/pay.ts';
import { recruitmentPlusRouter } from './routes/recruitmentPlus.ts';
import { statementsRouter } from './routes/statements.ts';
import { venuesRouter } from './routes/venues.ts';
import { videosRouter } from './routes/videos.ts';
import { isVideoProgressReport } from './lib/videos/progress.ts';
// Release 1.4 (F): paying people from Linear Hub, and bank details
import { myBankDetailsRouter, userBankDetailsRouter } from './routes/bankDetails.ts';
import { paymentsRouter } from './routes/payments.ts';
import { systemRouter } from './routes/system.ts';

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
  /**
   * The per-person limit on the 1.2 writes anyone can repeat (middleware/writeLimit.ts): writes per person per
   * minute, default 60; 0 turns it off.
   */
  writeLimitPerMinute?: number;
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
 * Google Fonts, fonts from gstatic, no framing of the app, no foreign form targets or base URLs. Release 1.3: frames
 * and thumbnails from the learning-video providers only (lib/videoEmbeds.ts, P5).
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
    `img-src 'self' data: ${VIDEO_THUMBNAIL_ORIGINS.join(' ')}`,
    "connect-src 'self'",
    // Release 1.3 (P5): learning videos linked from YouTube, Vimeo or Google Drive play in an embed (lib/videoEmbeds.ts);
    // same-origin frames stay allowed (P3 shows a statement's PDF).
    `frame-src 'self' ${VIDEO_EMBED_ORIGINS.join(' ')}`,
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
const CACHED_PATHS = [
  '/me/dashboard',
  '/finance/summary',
  '/recruitment/summary',
  '/leaderboard',
  '/gauges/summary',
  // Smart release 1.1
  '/me/insights',
  '/me/attention',
  '/me/digest',
  '/events/forecast',
  // Release 1.2
  '/learning/progress',
  '/learning/team',
  '/learning/progression',
  '/pitches',
  '/search',
  // Release 1.3: the aggregating reads (P1 breakdown, P5 team progress, P6 campaign page, P8 venues and event plans)
  '/pay/breakdown',
  '/videos/team',
  '/campaigns/:id/page',
  '/venues',
  '/events/:id/plan',
];

export function createApp(db: Db, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? false);
  app.use(securityHeaders(contentSecurityPolicy(opts.staticDir)));
  // gzip / brotli for JSON, HTML, JS, CSS and SVG over 1 KB (lib/compress.ts): phones on a hotspot download less.
  // LM_COMPRESSION=0 turns it off (e.g. behind a reverse proxy that compresses already).
  if (process.env.LM_COMPRESSION?.trim() !== '0') app.use(compression());
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
  // Release 1.3 (r3-foundation): a client portal session may call only /auth (me, logout, PIN), /health and /client;
  // everything else answers 403 here, before any router, cache or audit step (middleware/clientGuard.ts).
  api.use(clientGuard());
  // Release 1.2 slots, both pass-through until their packages land: U1's PIN gate (403 until a required PIN is set),
  // then U3's audit recorder (successful writes, with before/after snapshots).
  api.use(pinSetupGate(db));
  // Per person, at most 60 a minute of POST /learning/*, PUT /pitches/*, POST /checkins, POST /auth/pin(/*),
  // POST /gauges/bulk, POST /users(/*) and (1.3.1 fix) the event roster writes and PUT /recruitment/interviews/:id/answers
  // together (429 after that); before the recorder and the cache bump, so a refused write is never recorded and clears
  // nothing (middleware/writeLimit.ts WRITE_LIMITED_ROUTES).
  api.use(perUserWriteLimit({ perMinute: opts.writeLimitPerMinute }));
  api.use(auditMiddleware(db));
  // any write invalidates the aggregate cache before the handler runs (handlers are synchronous node:sqlite calls);
  // Release 1.3 (P5 merge note): not a video progress report (every 15 s per viewer) — that route clears the cache
  // itself when a report makes a video watched
  api.use((req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !isVideoProgressReport(req.method, req.path)) bumpDataVersion();
    next();
  });
  // Release 1.3 (r3-foundation): every router mount is recorded for the route table (lib/routeTable.ts listApiRoutes).
  const mount = (path: string, ...handlers: RequestHandler[]) => {
    api.use(path, ...handlers);
    recordApiMount(app, path, handlers);
  };
  mount('/health', healthRouter(db));
  mount('/auth', authRouter(db));
  api.use(CACHED_PATHS, requireAuth, responseCache());
  // requireAuth is attached per router (not globally) so unknown /api paths always get the JSON 404 below.
  mount('/me', requireAuth, dashboardRouter(db));
  // Smart release 1.1: GET /me/insights (p1 composes), /me/attention (p5), /me/digest (p9).
  mount('/me', requireAuth, insightsRouter(db));
  mount('/me', requireAuth, attentionRouter(db));
  mount('/me', requireAuth, digestRouter(db));
  // Release 1.4 (F): GET/PUT /me/bank-details, and the admin's /users/:id/bank-details(/confirm) before the users router
  mount('/me', requireAuth, myBankDetailsRouter(db));
  mount('/users', requireAuth, userBankDetailsRouter(db));
  mount('/users', requireAuth, usersRouter(db));
  mount('/teams', requireAuth, teamsRouter(db));
  mount('/campaigns', requireAuth, campaignPagesRouter(db)); // Release 1.3 (P6), before the campaigns router
  mount('/campaigns', requireAuth, campaignsRouter(db));
  mount('/events', requireAuth, eventPlansRouter(db)); // Release 1.3 (P8), before the events router
  mount('/events', requireAuth, eventsRouter(db));
  // Release 1.2 (U2): POST /gauges/bulk, before the gauges router.
  mount('/gauges/bulk', requireAuth, bulkGaugesRouter(db));
  mount('/gauges', requireAuth, gaugesRouter(db));
  mount('/leaderboard', requireAuth, leaderboardRouter(db));
  // Release 1.2 (U5): GET /finance/payroll/export, before the finance router (its /payroll/:id would catch "export").
  mount('/finance/payroll/export', requireAuth, payExportRouter(db));
  mount('/finance', requireAuth, financeRouter(db));
  mount('/recruitment', requireAuth, recruitmentPlusRouter(db)); // Release 1.3 (P7), before the recruitment router
  mount('/recruitment', requireAuth, recruitmentRouter(db));
  // Release 1.2 (U3): POST /announcements/:id/read and GET /announcements/reads, before the announcements router.
  mount('/announcements', requireAuth, announcementReadsRouter(db));
  mount('/announcements', requireAuth, announcementsRouter(db));
  // Release 1.2: learning (L1), pitches (L2), audit (U3), shift check-ins (U4), search (U5).
  mount('/learning', requireAuth, learningRouter(db));
  mount('/pitches', requireAuth, pitchesRouter(db));
  mount('/audit/events', requireAuth, auditEventsRouter(db)); // Release 1.3 (P9), before the audit router
  mount('/audit', requireAuth, auditRouter(db));
  mount('/checkins', requireAuth, checkinsRouter(db));
  mount('/search', requireAuth, searchRouter(db));
  // Release 1.3: pay rule (P1), invoices (P2), statements (P3), videos (P5), the client portal and its office side (P6),
  // venues (P8) and client-side audit events (P9). Routers that share a prefix with a 1.0 router are mounted before it
  // and answer only their own paths: campaign pages (P6) before /campaigns, recruitment additions (P7) before
  // /recruitment, event rosters and plans (P8) before /events, audit events (P9) before /audit.
  mount('/pay', requireAuth, payRouter(db));
  mount('/invoices', requireAuth, invoicesRouter(db));
  mount('/statements', requireAuth, statementsRouter(db));
  mount('/videos', requireAuth, videosRouter(db));
  mount('/client', requireAuth, clientRouter(db));
  mount('/client-posts', requireAuth, clientPostsRouter(db));
  mount('/client-accounts', requireAuth, clientAccountsRouter(db));
  mount('/venues', requireAuth, venuesRouter(db));
  // Release 1.4 (F): connections, batches, approval with a fresh two-step code, bank files (admin only)
  mount('/payments', requireAuth, paymentsRouter(db));
  // System health and the recovery sheet (Settings › Backups; admin, the sheet owner only)
  mount('/system', requireAuth, systemRouter(db));
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

const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
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
  // to the terminal and <data dir>/logs/errors.log (path only, never the query or body), counted for the admins' bell
  logServerError('Server error', err, { method: req.method, path: req.originalUrl, userId: req.user?.id ?? null });
  res.status(500).json({ error: 'Internal server error' });
};
