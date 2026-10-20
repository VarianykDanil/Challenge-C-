/**
 * Release 1.2 — OWNED BY L2 learning-pitch (laid down empty by r2-foundation).
 * Planned: campaign_pitches(id, campaign_id UNIQUE, title, body TEXT, facts TEXT, updated_by, updated_at) and, in
 * `seed`, the owner's BCN pitch (verbatim) with its fact-check notes for the BCN campaign (ctx.campaigns, code 'BCN').
 * An already-seeded database never runs `seed`: if it should get the BCN pitch too, add it in `upgrade` once (guarded
 * by a meta key, only when the BCN campaign exists). Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'pitches',
  sql: '',
  upgrade: () => [],
};
