// Release 1.3 slot — OWNED BY P2 invoices. The self-billing agreement, shown once to each field person (rep, leader)
// who has not accepted the current version: a dialog over whatever page they open. "Later" hides it until the next
// visit (this browser tab's session); Settings → Invoices and the first Accept invoice offer it too. Mounted once in
// components/layout/AppShell.tsx in the sticky banner row, in an ErrorBoundary with fallback={null}. The shell is in the
// main chunk, so the dialog itself loads on demand.
import { Suspense, lazy, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CompanySettings, SelfBillingAgreement, UserWithTeam } from '@lm/shared';
import { BRAND, isInvoicedRole } from '@lm/shared';
import { api } from '@/api/client';

const AgreementDialog = lazy(() => import('./AgreementDialog'));

/**
 * The same query as api/invoices.ts useAgreement (same key, so they share the cache), written here so the main chunk
 * does not carry every invoice hook.
 */
function useAgreementStatus(enabled: boolean) {
  return useQuery({ queryKey: ['invoices', 'agreement'], queryFn: () => api<SelfBillingAgreement>('/invoices/agreement'), enabled, staleTime: 5 * 60_000 });
}

/** Settings → Company (the legal name the agreement is with); api/invoices.ts useCompanySettings' key, fetched only when the prompt shows. */
function useCompanyName(enabled: boolean) {
  return useQuery({ queryKey: ['invoices', 'company'], queryFn: () => api<CompanySettings>('/invoices/company'), enabled, staleTime: 5 * 60_000 });
}

export interface AgreementPromptProps {
  user: UserWithTeam;
}

const LATER_KEY = 'lm:agreement-later';

function laterThisSession(version: string): boolean {
  try {
    return sessionStorage.getItem(LATER_KEY) === version;
  } catch {
    return false;
  }
}

export function AgreementPrompt({ user }: AgreementPromptProps) {
  const invoiced = isInvoicedRole(user.role);
  const q = useAgreementStatus(invoiced);
  const [closed, setClosed] = useState(false);
  const a = q.data;
  const show = invoiced && !!a && !a.acceptedAt && !closed && !laterThisSession(a.version);
  const company = useCompanyName(show);
  if (!show || company.isLoading) return null;
  const legalName = company.data?.legalName || BRAND.legalName;
  const later = () => {
    try {
      sessionStorage.setItem(LATER_KEY, a.version);
    } catch {
      /* private mode: it shows again next time */
    }
    setClosed(true);
  };
  return (
    <Suspense fallback={null}>
      <AgreementDialog
        open
        onClose={later}
        laterLabel="Later"
        onAccepted={() => setClosed(true)}
        intro={`${legalName} writes a self-billing invoice for you each pay week. Please read this once and accept it: you need it to accept your invoices.`}
      />
    </Suspense>
  );
}
