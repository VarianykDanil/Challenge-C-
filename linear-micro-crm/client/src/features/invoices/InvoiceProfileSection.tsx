// Release 1.3 slot — OWNED BY P2 invoices. Team → person (admin): the person's supplier details for invoices (editable)
// and whether they accepted the self-billing agreement. Mounted in pages/UserDetail.tsx in the left column after the
// Pay plan card, administrators only, in an ErrorBoundary with fallback={null}. A whole Card, or nothing for a person
// who is not invoiced (office roles). Id "invoice-details": the "Check … VAT number" bell item lands here.
// A VAT number waiting for the office shows "Confirm VAT number": the administrator checks it on HMRC's service and
// confirms with a fresh code. Nobody confirms a number they typed in themselves (the server answers why).
import { useId, useState, type FormEvent } from 'react';
import { CheckCircle2, ExternalLink, FileText } from 'lucide-react';
import type { InvoiceProfile, UserWithTeam } from '@lm/shared';
import { formatVatNumber, isInvoicedRole } from '@lm/shared';
import { ApiError } from '@/api/client';
import { Badge, Button, Card, CardHeader, Field, Input, Skeleton, useToast } from '@/components/ui';
import { useConfirmInvoiceVat, useInvoiceProfile } from '@/api/invoices';
import { ErrorState, errorMessage } from '@/features/common';
import { formatDate } from '@/lib/format';
import { useScrollToHash } from '@/lib/useScrollToHash';
import { InvoiceProfileForm } from './InvoiceProfileForm';

/** HMRC's free service that says whether a UK VAT number is registered, and to whom. */
const HMRC_CHECK_VAT_URL = 'https://www.tax.service.gov.uk/check-vat-number/enter-vat-details';

const codeError = (err: unknown): string | undefined => {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return undefined;
  const d = (err.details as { path?: unknown; message?: unknown }[]).find((x) => x?.path === 'code');
  return typeof d?.message === 'string' ? d.message : undefined;
};

/** "Check it on HMRC's service, then confirm": the office's step before VAT is added to someone's pay. */
function ConfirmVat({ profile, first }: { profile: InvoiceProfile; first: string }) {
  const uid = useId();
  const confirm = useConfirmInvoiceVat(profile.userId);
  const toast = useToast();
  const [checked, setChecked] = useState(false);
  const [code, setCode] = useState('');
  const v = profile.vat;
  if (!profile.vatNumber || v?.status !== 'waiting') return null;
  const n = formatVatNumber(profile.vatNumber);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!checked) return;
    confirm.mutate({ vatNumber: profile.vatNumber!, code: code.replace(/\s+/g, '') }, {
      onSuccess: () => {
        setCode('');
        toast.success('VAT number confirmed', `VAT at 20% is added to ${first}'s invoices from now on. Invoices not accepted yet are issued again for ${first} to check.`);
      },
      onError: (err) => { if (!codeError(err)) toast.error('Could not confirm it', errorMessage(err)); },
    });
  };
  return (
    <form onSubmit={submit} noValidate className="mb-4 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3" data-testid="vat-confirm">
      <p className="text-sm font-medium text-fg">Check {first}'s VAT number</p>
      <p className="text-xs text-muted">
        {v.changedByName ? `${v.changedByName} typed in ${n}` : `${n} is on ${first}'s details`}{v.changedAt ? ` on ${formatDate(v.changedAt)}` : ''}.
        {' '}No VAT is added to {first}'s pay until an administrator checks it. Look it up on HMRC's service: it must show {first}'s name or business.
      </p>
      <a href={HMRC_CHECK_VAT_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline">
        Check a UK VAT number (HMRC) <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="h-5 w-5 rounded border-border" />
        HMRC shows {n} belongs to {first}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} error={codeError(confirm.error)} className="sm:w-56">
          <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" invalid={!!codeError(confirm.error)} className="font-mono" />
        </Field>
        <Button type="submit" size="sm" className="h-10 shrink-0 self-start sm:self-auto" disabled={!checked} loading={confirm.isPending} leftIcon={<CheckCircle2 aria-hidden />}>
          Confirm VAT number
        </Button>
      </div>
    </form>
  );
}

export interface InvoiceProfileSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function InvoiceProfileSection({ user, className }: InvoiceProfileSectionProps) {
  const invoiced = isInvoicedRole(user.role);
  const q = useInvoiceProfile(user.id, { enabled: invoiced });
  useScrollToHash('invoice-details', invoiced && !q.isLoading);
  if (!invoiced) return null;
  const p = q.data;
  const accepted = p?.agreement?.acceptedAt ?? null;
  return (
    <Card id="invoice-details" className={`scroll-mt-20 ${className ?? ''}`} data-testid="invoice-profile">
      <CardHeader
        title="Invoice details"
        description={`Printed as the supplier on ${user.firstName}'s self-billing invoices.`}
        icon={<FileText aria-hidden />}
      />
      {p && (
        <div className="-mt-1 mb-4 space-y-1.5">
          <Badge tone={accepted ? 'success' : 'warning'} dot={!!accepted}>{accepted ? 'Agreement accepted' : 'Agreement not accepted'}</Badge>
          <p className="text-xs text-muted">
            {accepted
              ? `Accepted the self-billing agreement (version ${p.agreement?.version}) on ${formatDate(accepted)}.`
              : `${user.firstName} has not accepted the self-billing agreement yet: their invoices still count as accepted at the deadline (12:00 the day before payday, or 24 hours after a late one) unless disputed, but they cannot accept one themselves until they do.`}
          </p>
        </div>
      )}
      {q.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} className="p-4" />
      ) : p ? (
        <>
          <ConfirmVat profile={p} first={user.firstName} />
          <InvoiceProfileForm profile={p} userId={user.id} self={false} />
        </>
      ) : null}
    </Card>
  );
}
