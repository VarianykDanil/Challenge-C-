// Release 1.3 — /client/security (client accounts) — OWNED BY P6 client-portal (laid down by r3-foundation as a stub page).
import { ShieldCheck } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function ClientSecurityPage() {
  usePageTitle(COPY.nav.clientSecurity.title);
  return (
    <>
      <PageHeader
        title={COPY.nav.clientSecurity.title}
        description={COPY.nav.clientSecurity.description}
      />
      <EmptyState icon={<ShieldCheck aria-hidden />} title="Coming soon" description="Your sign-in PIN will be managed here." />
    </>
  );
}
