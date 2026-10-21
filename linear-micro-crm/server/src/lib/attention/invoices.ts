/**
 * Release 1.3 — OWNED BY P2 invoices (laid down by r3-foundation; returns nothing until P2 fills it). Kind 'invoices':
 * the field person's invoice is issued ("Accept your invoice by 12:00 Thu"), deemed accepted soon, resolved; the
 * office's disputed invoices (admin). Contract: ./types.ts.
 */
import type { AttentionProvider } from './types.ts';

export const provider: AttentionProvider = {
  name: 'invoices',
  items: () => [],
};
