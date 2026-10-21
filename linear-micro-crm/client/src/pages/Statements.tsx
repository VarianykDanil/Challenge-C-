// Release 1.3 — /finance/statements (admin) — OWNED BY P3 statements (laid down by r3-foundation as a stub page).
import { Link } from 'react-router-dom';
import { ArrowLeft, FileSpreadsheet } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

export function StatementsPage() {
  usePageTitle(COPY.nav.statements.title);
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/finance" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Finance</Link>}
        title={COPY.nav.statements.title}
        description={COPY.nav.statements.description}
      />
      <EmptyState icon={<FileSpreadsheet aria-hidden />} title="Coming soon" description="Commission statements from the clients will be listed here, with what each one changes in pay." />
    </>
  );
}
