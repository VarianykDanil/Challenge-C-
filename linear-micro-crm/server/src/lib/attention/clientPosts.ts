/**
 * Release 1.3 — OWNED BY P6 client-portal (laid down by r3-foundation; returns nothing until P6 fills it). Kind
 * 'client', admin (and leaders where P6 decides): every new client post — an update, an announcement, a commission
 * change waiting for approval. Contract: ./types.ts.
 */
import type { AttentionProvider } from './types.ts';

export const provider: AttentionProvider = {
  name: 'client-posts',
  items: () => [],
};
