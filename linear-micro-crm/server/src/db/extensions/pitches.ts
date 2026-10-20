/**
 * Release 1.2 — OWNED BY L2 learning-pitch (laid down empty by r2-foundation).
 * Planned: campaign_pitches(id, campaign_id UNIQUE, title, body TEXT, facts TEXT, updated_by, updated_at) and, in
 * `seed`, the owner's BCN pitch (verbatim) with its fact-check notes for the BCN campaign (ctx.campaigns, code 'BCN').
 * An already-seeded database never runs `seed`: if it should get the BCN pitch too, add it in `upgrade` as well (guarded
 * by a meta key). On a FRESH install `upgrade` runs before `seed`, when the campaigns table is still empty: skip without
 * setting the flag when there is no BCN campaign, insert with INSERT OR IGNORE on campaign_id, report a change only when
 * a row went in, and keep the same insert in `seed`. Rules: ./types.ts ("ORDER ON A FRESH INSTALL").
 */
import type { DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'pitches',
  sql: '',
  upgrade: () => [],
};
