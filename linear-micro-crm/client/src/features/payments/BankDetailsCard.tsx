// Release 1.4 — F payments-foundation: Bank details, always masked. Two places:
//  - Settings (every staff role, their own; after Settings → Invoices): add or change them;
//  - Team → person (admin; id "bank-details", the Needs-attention link lands here): see whether the person can be paid
//    from Linear Hub, confirm changed details after checking them, or type them in for someone.
// The numbers are never sent back by the server: after saving, only "••-••-34" and "••••5678" show. A change needs a
// code from the authenticator app when the person saving has two-step verification on.
import { useId, useState, type FormEvent } from 'react';
import { CheckCircle2, Landmark, Pencil, ShieldAlert } from 'lucide-react';
import { payDayLabel, validateBankDetails, type BankDetailsView } from '@lm/shared';
import { ApiError } from '@/api/client';
import { useBankDetails, useConfirmBankDetails, useSaveBankDetails } from '@/api/payments';
import { Badge, Button, Card, CardHeader, Field, Input, Skeleton, useToast } from '@/components/ui';
import { ErrorState, errorMessage } from '@/features/common';
import { useScrollToHash } from '@/lib/useScrollToHash';

type FieldKey = 'holderName' | 'sortCode' | 'accountNumber' | 'code';

function fieldErrors(err: unknown): Partial<Record<FieldKey, string>> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Partial<Record<FieldKey, string>> = {};
  for (const d of err.details as { path?: unknown; message?: unknown }[]) {
    if (typeof d?.path === 'string' && typeof d.message === 'string' && !out[d.path as FieldKey]) out[d.path as FieldKey] = d.message;
  }
  return out;
}

const dayOf = (iso: string | null) => (iso ? payDayLabel(iso.slice(0, 10)) : '');

export interface BankDetailsCardProps {
  /** Someone else's (admin, Team → person); omitted: the signed-in person's own. */
  user?: { id: number; firstName: string };
  className?: string;
}

export function BankDetailsCard({ user, className }: BankDetailsCardProps) {
  const q = useBankDetails(user?.id ?? null);
  const [editing, setEditing] = useState(false);
  // the Needs-attention link (Team → person#bank-details) lands here once the details have loaded
  useScrollToHash('bank-details', !q.isLoading);
  const own = !user;
  const first = user?.firstName ?? '';
  return (
    // a container: the card sits in Settings' wide column and in Team → person's narrow side column
    <Card id="bank-details" className={`@container scroll-mt-20 ${className ?? ''}`} data-testid="bank-details">
      <CardHeader
        title="Bank details"
        icon={<Landmark aria-hidden />}
        description={own
          ? 'Where your pay goes. Only you and the office’s administrator can see them, and only the last digits are ever shown.'
          : `Where ${first}’s pay goes. Only the last digits are shown. Payments to changed details wait until you confirm them.`}
        actions={q.data?.details && !editing ? (
          <Button size="sm" variant="outline" className="h-10 sm:h-8" leftIcon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>Change</Button>
        ) : undefined}
      />
      {q.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} className="p-4" />
      ) : editing || !q.data?.details ? (
        editing ? (
          <BankDetailsForm view={q.data!} userId={user?.id ?? null} own={own} onDone={() => setEditing(false)} />
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4 @lg:flex-row @lg:items-center @lg:justify-between">
            <p className="text-sm text-muted">
              {own ? 'No bank details yet. Add them so the office can pay you from Linear Hub.' : `No bank details for ${first} yet, so Linear Hub cannot pay them. Ask them to add theirs in Settings, or type them in here.`}
            </p>
            <Button size="sm" className="h-10 shrink-0 self-start @lg:self-auto" onClick={() => setEditing(true)}>Add bank details</Button>
          </div>
        )
      ) : (
        <Summary view={q.data} userId={user?.id ?? null} own={own} first={first} />
      )}
    </Card>
  );
}

function Summary({ view, userId, own, first }: { view: BankDetailsView; userId: number | null; own: boolean; first: string }) {
  const d = view.details!;
  const confirm = useConfirmBankDetails(userId ?? 0);
  const toast = useToast();
  const by = d.changedByName && d.changedBy !== d.userId ? ` by ${d.changedByName}` : '';
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 @xl:grid-cols-3">
        <div className="flex flex-col border-b border-border pb-2"><dt className="text-xs font-medium text-muted">Name on the account</dt><dd className="break-words text-sm text-fg">{d.holderName}</dd></div>
        <div className="flex flex-col border-b border-border pb-2"><dt className="text-xs font-medium text-muted">Sort code</dt><dd className="whitespace-nowrap font-mono text-sm tabular-nums text-fg">{d.sortCodeMasked}</dd></div>
        <div className="flex flex-col border-b border-border pb-2"><dt className="text-xs font-medium text-muted">Account number</dt><dd className="whitespace-nowrap font-mono text-sm tabular-nums text-fg">{d.accountNumberMasked}</dd></div>
      </dl>
      {d.needsConfirmation ? (
        <div className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft p-3 @xl:flex-row @xl:items-center @xl:justify-between" data-bank-hold="">
          <p className="flex items-start gap-2 text-sm text-fg">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>
              {own
                ? `Changed on ${dayOf(d.changedAt)}. The office checks new details with you before the next payment goes there.`
                : `${first} changed these on ${dayOf(d.changedAt)}${by}. Check them with ${first} (in person or by phone), then confirm. Until then, payments to them wait.`}
            </span>
          </p>
          {!own && (
            <Button
              size="sm"
              className="h-10 shrink-0 self-start @xl:self-auto"
              loading={confirm.isPending}
              leftIcon={<CheckCircle2 aria-hidden />}
              onClick={() => confirm.mutate(undefined, {
                onSuccess: () => toast.success('Bank details confirmed', `Payments to ${first} can use them now.`),
                onError: (e) => toast.error('Could not confirm them', errorMessage(e)),
              })}
            >
              Confirm details
            </Button>
          )}
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Badge tone="success" dot>Ready for payments</Badge>
          <span>Changed {dayOf(d.changedAt)}{by}{d.confirmedByName ? ` · confirmed by ${d.confirmedByName}` : ''}</span>
        </p>
      )}
    </div>
  );
}

function BankDetailsForm({ view, userId, own, onDone }: { view: BankDetailsView; userId: number | null; own: boolean; onDone: () => void }) {
  const uid = useId();
  const save = useSaveBankDetails(userId);
  const toast = useToast();
  const [holderName, setHolder] = useState(view.details?.holderName ?? '');
  const [sortCode, setSort] = useState('');
  const [accountNumber, setAccount] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const local = validateBankDetails({ holderName, sortCode, accountNumber });
  const localErrs: Partial<Record<FieldKey, string>> = touched && !local.ok ? Object.fromEntries(local.errors.map((e) => [e.path, e.message])) : {};
  const serverErrs = fieldErrors(save.error);
  const errs = { ...serverErrs, ...localErrs };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!local.ok) return;
    save.mutate({ ...local.value, ...(view.codeRequired ? { code: code.replace(/\s+/g, '') } : {}) }, {
      onSuccess: (v) => {
        toast.success('Bank details saved', own
          ? v.details?.needsConfirmation ? 'The office checks them with you before the next payment goes there.' : 'Payments use them from now on.'
          : 'Payments use them from now on.');
        onDone();
      },
      onError: (err) => { if (!Object.keys(fieldErrors(err)).length) toast.error('Could not save them', errorMessage(err)); },
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Name on the account" htmlFor={`${uid}-name`} error={errs.holderName} required>
        <Input id={`${uid}-name`} value={holderName} onChange={(e) => setHolder(e.target.value)} autoComplete="off" maxLength={70} invalid={!!errs.holderName} />
      </Field>
      <div className="grid gap-4 @md:grid-cols-2">
        <Field label="Sort code" htmlFor={`${uid}-sort`} error={errs.sortCode} hint="6 digits, like 12-34-56" required>
          <Input id={`${uid}-sort`} value={sortCode} onChange={(e) => setSort(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={8} placeholder="12-34-56" invalid={!!errs.sortCode} className="font-mono" />
        </Field>
        <Field label="Account number" htmlFor={`${uid}-acc`} error={errs.accountNumber} hint="8 digits" required>
          <Input id={`${uid}-acc`} value={accountNumber} onChange={(e) => setAccount(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="12345678" invalid={!!errs.accountNumber} className="font-mono" />
        </Field>
      </div>
      {view.codeRequired && (
        <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} error={errs.code} hint="Bank details are only changed with your two-step code." required>
          <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" invalid={!!errs.code} className="font-mono @md:w-40" />
        </Field>
      )}
      <p className="text-xs text-muted">
        {own
          ? 'Type the full numbers each time you change them: Linear Hub never shows them again. The office checks new details with you before paying.'
          : 'Details you type in count as checked by you, so payments use them at once.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending} className="h-10">Save bank details</Button>
        <Button type="button" variant="ghost" className="h-10" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
