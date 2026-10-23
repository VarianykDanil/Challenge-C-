/**
 * Release 1.3 (r3-foundation; OWNED BY P9 audit-everything from here on): the audit spec REGISTRY. Each 1.3 package
 * registers the specs for its own write routes in its own file (./<package>Specs.ts, exporting AUDIT_SPECS); this file
 * lists them in a fixed order and lib/audit.ts matches every write against them. Package specs are matched BEFORE the
 * 1.2 specs in lib/auditSpecs.ts (first match wins), so a package may refine a 1.2 route's entry from its own file;
 * within a list, literal paths go before `:param` ones. lib/auditSpecs.ts keeps its own matchAuditRoute (1.2 specs
 * only) for the 1.2 tests.
 */
import { AUDIT_ROUTES, type AuditRouteSpec } from '../auditSpecs.ts';
import { AUDIT_SPECS as auditEvents } from './auditEventSpecs.ts';
import { AUDIT_SPECS as client } from './clientSpecs.ts';
import { AUDIT_SPECS as invoices } from './invoiceSpecs.ts';
import { AUDIT_SPECS as pay } from './paySpecs.ts';
import { AUDIT_SPECS as recruitment } from './recruitmentSpecs.ts';
import { AUDIT_SPECS as security } from './securitySpecs.ts';
import { AUDIT_SPECS as statements } from './statementSpecs.ts';
import { AUDIT_SPECS as venues } from './venueSpecs.ts';
import { AUDIT_SPECS as videos } from './videoSpecs.ts';

/** The 1.3 packages' specs by package, in match order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PACKAGE_AUDIT_SPECS: Readonly<Record<string, readonly AuditRouteSpec<any>[]>> = {
  pay, invoices, statements, videos, client, recruitment, venues, auditEvents,
  // Release 1.4
  security,
};

/** Every spec, in match order: the 1.3 packages' first, then the 1.2 registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function allAuditSpecs(): readonly AuditRouteSpec<any>[] {
  return [...Object.values(PACKAGE_AUDIT_SPECS).flat(), ...AUDIT_ROUTES];
}

interface CompiledSpec {
  spec: AuditRouteSpec;
  re: RegExp;
  names: string[];
}

function compile(spec: AuditRouteSpec): CompiledSpec {
  const names: string[] = [];
  const source = spec.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { spec, re: new RegExp(`^${source}/?$`, 'i'), names };
}

let compiled: readonly CompiledSpec[] | null = null;

/** The spec for a write (method + path relative to /api), with its params; null when no spec matches. */
export function matchAuditSpec(method: string, path: string): { spec: AuditRouteSpec; params: Record<string, string> } | null {
  compiled ??= allAuditSpecs().map(compile);
  for (const c of compiled) {
    if (c.spec.method !== method) continue;
    const m = c.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.names.forEach((name, i) => {
      const raw = m[i + 1] ?? '';
      try {
        params[name] = decodeURIComponent(raw);
      } catch {
        params[name] = raw;
      }
    });
    return { spec: c.spec, params };
  }
  return null;
}
