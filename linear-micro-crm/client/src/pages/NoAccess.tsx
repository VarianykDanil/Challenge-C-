import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import type { Role } from '@lm/shared';
import { ROLE_LABELS } from '@lm/shared';
import { EmptyState } from '@/components/ui';
import { usePageTitle } from '@/lib/usePageTitle';

export function NoAccessPage({ roles }: { roles?: Role[] }) {
  usePageTitle('No access');
  const who = roles?.length ? roles.map((r) => ROLE_LABELS[r].toLowerCase()).join(', ') : null;
  return (
    <div className="mx-auto max-w-lg py-16">
      <EmptyState
        icon={<ShieldOff className="h-10 w-10" aria-hidden />}
        title="This area isn't available on your account"
        description={who ? `It is open to ${who} accounts. If you think you should have access, speak to your crew leader or the office.` : 'If you think you should have access, speak to your crew leader or the office.'}
        action={<Link to="/" className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">Back to dashboard</Link>}
      />
    </div>
  );
}
