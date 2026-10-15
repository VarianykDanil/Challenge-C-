import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { ZodError } from 'zod';
import type { Db } from './db/connection.ts';
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
}

export function createApp(db: Db, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind a TLS terminator: req.secure / req.ip follow X-Forwarded-*
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173', ...(opts.corsOrigins ?? [])],
      credentials: true,
      exposedHeaders: ['X-Total-Count'],
    }),
  );

  const api = express.Router();
  api.use(authenticate(db));
  api.use('/health', healthRouter(db));
  api.use('/auth', authRouter(db));
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
    app.use(express.static(opts.staticDir, { index: 'index.html', maxAge: '1h' }));
    // Express 5 wildcard syntax; API paths never reach here because the /api router answers 404 itself.
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(indexHtml);
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
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
    res.status(e.status).json({ error: e.message ?? 'Request error' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
