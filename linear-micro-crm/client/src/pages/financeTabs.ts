// Finance's tabs and the one it opens on. Pure, tested in financeTabs.test.ts.
import type { Role } from '@lm/shared';

export type FinanceTab = 'me' | 'team' | 'company';

export function financeTabs(role: Role, teamId: number | null): { value: FinanceTab; label: string }[] {
  const t: { value: FinanceTab; label: string }[] = [{ value: 'me', label: 'My pay' }];
  if (role === 'leader' && teamId != null) t.push({ value: 'team', label: 'Team pay' });
  if (role === 'admin') t.push({ value: 'company', label: 'Company' });
  return t;
}

/**
 * The tab Finance opens on: the one a link names (when this person has it), else Company for the owner and office
 * (they run the business; most have no pay runs of their own), else My pay.
 */
export function openingFinanceTab(role: Role, teamId: number | null, link: { tab: string | null; hash: string; run?: string | null }): FinanceTab {
  const tabs = financeTabs(role, teamId);
  if (link.hash === '#runs' && role === 'admin' && (link.tab === null || link.tab === 'company')) return 'company';
  const named = tabs.find((t) => t.value === link.tab)?.value;
  if (named) return named;
  if (link.run) return 'me';
  return role === 'admin' ? 'company' : 'me';
}
