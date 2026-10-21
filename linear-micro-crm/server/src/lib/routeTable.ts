/**
 * Release 1.3 (r3-foundation, STABLE): the API's route table. Express 5 does not keep a mounted router's path, so app.ts
 * records every `/api` mount here (path + handlers) as it builds the app, and listApiRoutes(app) joins each mount path
 * with its routers' own routes. Used by r3-contracts.test.ts (every 1.3 path mounted behind requireAuth), P6's client
 * guard test (a client session gets 403 on every non-portal route) and P9's audit coverage test (every write route has
 * an audit spec). Routers mounted inside routers are not followed (the app has none).
 */
export interface ApiRoute {
  /** 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'. */
  method: string;
  /** Relative to /api, Express-style: "/finance/payroll/:id/pay". */
  path: string;
  /** The mount it came from, e.g. "/finance". */
  mount: string;
}

interface Mount {
  path: string;
  handlers: readonly unknown[];
}

interface RouteLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

const MOUNTS = new WeakMap<object, Mount[]>();

/** app.ts: remember that `handlers` were mounted at `path` on `app`'s /api router. */
export function recordApiMount(app: object, path: string, handlers: readonly unknown[]): void {
  const list = MOUNTS.get(app) ?? [];
  list.push({ path, handlers });
  MOUNTS.set(app, list);
}

const join = (a: string, b: string) => (`${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/');

/** Every route of every router mounted on /api, in mount order (a path served by two routers is listed twice). */
export function listApiRoutes(app: object): ApiRoute[] {
  const out: ApiRoute[] = [];
  for (const m of MOUNTS.get(app) ?? []) {
    for (const h of m.handlers) {
      const stack = (h as { stack?: unknown }).stack;
      if (!Array.isArray(stack)) continue;
      for (const layer of stack as RouteLayer[]) {
        const route = layer.route;
        if (!route || typeof route.path !== 'string') continue;
        for (const [method, on] of Object.entries(route.methods ?? {})) {
          if (on && method !== '_all') out.push({ method: method.toUpperCase(), path: join(m.path, route.path), mount: m.path });
        }
      }
    }
  }
  return out;
}
