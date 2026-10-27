/**
 * Trial mode in the Needs-attention feed, for administrators only: while the database still holds the demo company,
 * the first thing every admin sees is that it is a trial and that it must go live before real pay or bank details go
 * in. One cached read (lib/trialMode.ts), within the feed's statement budget.
 */
import { ACCESS_MESSAGES, trialHeadline, type AttentionItem } from '@lm/shared';
import { trialStatus } from '../trial.ts';
import type { AttentionProvider } from './types.ts';

export const provider: AttentionProvider = {
  name: 'trial',
  items(db, me) {
    if (me.role !== 'admin') return [];
    const status = trialStatus(db);
    if (!status.trialMode) return [];
    const item: AttentionItem = {
      key: `security:trial:${status.demoSignIns ? 'demo-on' : 'demo-off'}`,
      kind: 'security',
      severity: 'danger',
      title: trialHeadline(status.demoSignIns),
      body: ACCESS_MESSAGES.trialBody,
      href: '/settings#trial',
      actionLabel: 'How to go live',
    };
    return [item];
  },
};
