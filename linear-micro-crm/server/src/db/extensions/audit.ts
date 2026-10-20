/**
 * Release 1.2 — OWNED BY U3 audit-trail (laid down empty by r2-foundation).
 * Planned: audit_log(id, at, user_id, action, entity, entity_id, summary, before_json, after_json, ip) with indexes for
 * the /audit filters and the entity history, and announcement_reads(announcement_id, user_id, read_at,
 * PRIMARY KEY(announcement_id, user_id)). No seed rows needed (the log starts when the release goes live). Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'audit',
  sql: '',
  upgrade: () => [],
};
