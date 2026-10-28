/**
 * Release 1.3 (r3-foundation): the Needs-attention provider registry. routes/attention.ts (buildAttentionFeed) adds
 * every provider's items to the 1.1 rules' items, then sorts and caps them with the shared rules (sortAttentionItems,
 * ATTENTION_MAX_ITEMS), so an extra item competes on severity and time like any other. With no extra items the feed is
 * exactly the 1.1 feed. A provider that throws is logged and skipped: one package's bug never blanks the top box.
 * Packages edit only their own provider file; the list and its order are the foundation's.
 */
import { ATTENTION_MAX_ITEMS, sortAttentionItems, type AttentionItem, type AttentionNow, type UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { provider as clientPosts } from './clientPosts.ts';
import { provider as invoices } from './invoices.ts';
import { provider as payments } from './payments.ts';
import { provider as statements } from './statements.ts';
import { provider as system } from './system.ts';
import { provider as trial } from './trial.ts';
import type { AttentionProvider } from './types.ts';

export type { AttentionProvider } from './types.ts';

// Release 1.4 (F): payments (bank details to check, failed payments, bank files waiting, connections to look at)
// system: backups, off-site copies, disk space, the app key on paper, server errors, a restore over payments
// Trial mode (the demo company is still here: go live before real pay or bank details go in), first.
export const ATTENTION_PROVIDERS: readonly AttentionProvider[] = [trial, invoices, statements, clientPosts, payments, system];

/** Every provider's items for `me` (a failing provider contributes nothing). */
export function providerAttentionItems(db: Db, me: UserWithTeam, now: AttentionNow): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const p of ATTENTION_PROVIDERS) {
    try {
      out.push(...p.items(db, me, now));
    } catch (err) {
      console.error(`Needs attention: the ${p.name} items failed and were left out`, err);
    }
  }
  return out;
}

/** The 1.1 items plus the providers' items: one per key, sorted and capped like the 1.1 feed (unchanged when none). */
export function withProviderItems(core: AttentionItem[], extra: AttentionItem[]): AttentionItem[] {
  if (!extra.length) return core;
  const seen = new Set<string>();
  const unique = [...core, ...extra].filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  return sortAttentionItems(unique).slice(0, ATTENTION_MAX_ITEMS);
}
