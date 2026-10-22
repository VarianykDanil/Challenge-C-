// Release 1.3 slot — OWNED BY P3 statements. Team → person → "Client IDs" (admin): the person's fundraiser ID at each
// client, exactly as the client's commission statements write it, so statement rows match them (before trying the
// exact full name). Mounted in pages/UserDetail.tsx in the left column after the invoice details, administrators only,
// in an ErrorBoundary with fallback={null}. Renders a whole Card.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { IdCard } from 'lucide-react';
import type { ClientRef, UserWithTeam } from '@lm/shared';
import { useCampaigns } from '@/api/hooks';
import { useClientRefs, useSaveClientRefs } from '@/api/statements';
import { Badge, Button, Card, CardHeader, Input, Skeleton, useToast } from '@/components/ui';
import { apiMessage } from '@/features/common/QueryStates';

export interface ClientRefsSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function ClientRefsSection({ user, className }: ClientRefsSectionProps) {
  const campaigns = useCampaigns();
  const refs = useClientRefs(user.id);
  const save = useSaveClientRefs(user.id);
  const toast = useToast();
  const saved = useMemo(() => new Map((refs.data ?? []).map((r) => [r.campaignId, r.ref])), [refs.data]);
  const [values, setValues] = useState<Record<number, string>>({});
  useEffect(() => setValues(Object.fromEntries(saved)), [saved]);
  if (user.role === 'client') return null;

  const shown = (campaigns.data ?? []).filter((c) => c.active || saved.has(c.id));
  const dirty = shown.some((c) => (values[c.id] ?? '').trim() !== (saved.get(c.id) ?? ''));
  const onSave = (e: FormEvent) => {
    e.preventDefault();
    const next: ClientRef[] = shown
      .map((c) => ({ userId: user.id, campaignId: c.id, ref: (values[c.id] ?? '').trim() }))
      .filter((r) => r.ref);
    save.mutate(next, {
      onSuccess: () => toast.success('Client IDs saved', 'Statement rows with these IDs match this person from now on.'),
      onError: (err) => toast.error('Could not save the client IDs', apiMessage(err, 'Try again.')),
    });
  };

  return (
    <Card className={className} data-testid="client-refs">
      <CardHeader
        icon={<IdCard />}
        title="Client IDs"
        description={`${user.firstName}'s fundraiser ID at each client, as it appears on the client's commission statements. Rows with it match ${user.firstName}; without one, the exact full name is used.`}
      />
      {campaigns.isLoading || refs.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <form onSubmit={onSave} className="space-y-3">
          {shown.map((c) => (
            // the campaign above its input at every width: the card sits in UserDetail's narrow left column on laptops,
            // where a label beside the input left the input 26 px wide
            <label key={c.id} className="flex min-w-0 flex-col gap-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <Badge tone="neutral" dot color={c.color}>{c.code}</Badge>
                <span className="min-w-0 truncate text-sm text-fg">{c.name}</span>
              </span>
              <Input
                value={values[c.id] ?? ''}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                placeholder="Not set"
                aria-label={`${user.firstName}'s fundraiser ID at ${c.name}`}
                onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value }))}
              />
            </label>
          ))}
          {!shown.length && <p className="text-sm text-muted">No active campaigns.</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="outline" disabled={!dirty} loading={save.isPending}>Save client IDs</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
