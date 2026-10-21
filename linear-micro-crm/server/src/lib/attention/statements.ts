/**
 * Release 1.3 — OWNED BY P3 statements (laid down by r3-foundation; returns nothing until P3 fills it). Kind
 * 'statements', admin only: a commission statement that needs review (unmatched rows, unknown template, a parse
 * failure), and a mail connection that keeps failing. Contract: ./types.ts.
 */
import type { AttentionProvider } from './types.ts';

export const provider: AttentionProvider = {
  name: 'statements',
  items: () => [],
};
