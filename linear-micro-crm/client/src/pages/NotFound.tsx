import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { usePageTitle } from '@/lib/usePageTitle';

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="mx-auto max-w-lg py-16">
      <EmptyState
        icon={<Compass className="h-10 w-10" aria-hidden />}
        title="We can't find that page"
        description="The link may be out of date, or the page may have moved. Head back to your dashboard."
        action={<Link to="/" className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">Go to dashboard</Link>}
      />
    </div>
  );
}
