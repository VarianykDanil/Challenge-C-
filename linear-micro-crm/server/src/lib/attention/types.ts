/**
 * Release 1.3 (r3-foundation, STABLE): one package's contribution to the role-scoped Needs-attention feed (the
 * dashboard's top box and the topbar bell, GET /me/attention). `items` gets the signed-in caller and the business clock
 * and returns only items that caller may see, built from already-scoped data — ONE grouped statement per caller (a
 * UNION ALL or a joined aggregate when it needs two sets), never a query per row: the whole feed has a budget of 12
 * statements for every role (attention.test.ts holds each provider to one). The feed is built on every dashboard load;
 * GET /me/attention is cached and every write invalidates it.
 * Keys must be deterministic and prefixed with the kind (`invoices:dispute:12`), so a resolved item disappears and the
 * bell's seen-state sticks. Kinds: P2 'invoices', P3 'statements', P6 'client' (AttentionKind in shared/src/types.ts).
 */
import type { AttentionItem, AttentionNow, UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';

export interface AttentionProvider {
  /** Short and unique: 'invoices', 'statements', 'client-posts'. */
  name: string;
  items(db: Db, me: UserWithTeam, now: AttentionNow): AttentionItem[];
}
