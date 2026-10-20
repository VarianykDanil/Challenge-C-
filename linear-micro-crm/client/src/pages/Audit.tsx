// Release 1.2 — /audit (admin) — OWNED BY U3 audit-trail (laid down by r2-foundation as a stub).
import { History } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function AuditPage() {
  usePageTitle(COPY.nav.audit.title);
  return (
    <>
      <PageHeader title={COPY.nav.audit.title} description={COPY.nav.audit.description} />
      <EmptyState icon={<History aria-hidden />} title="Coming soon" description="Every change to pay, gauges, people and settings will be listed here." />
    </>
  );
}
