// Release 1.4 — F payments-foundation: Bank details, always masked. Two places:
//  - Settings (every staff role, their own; after Settings → Invoices): add or change them;
//  - Team → person (admin; id "bank-details", the Needs-attention link lands here): see whether the person can be paid
//    from Linear Hub, confirm changed details after checking them, or type them in for someone.
// The numbers are never sent back by the server: after saving, only "••-••-34" and "••••5678" show. A change needs a
// code from the authenticator app when the person saving has two-step verification on (always for someone else's).
// Nobody confirms their own change (MON-3): details the person changed wait for an administrator; details an
// administrator typed in wait for the person ("Yes, these are mine") or a different administrator, and the person sees
// "Your bank details were changed by … Confirm or report it". Confirming takes a fresh code.
import { useId, useState, type FormEvent } from 'react';
import { CheckCircle2, Flag, Landmark, Pencil, ShieldAlert } from 'lucide-react';
import { payDayLabel, validateBankDetails, type BankDetailsView } from '@lm/shared';
import { ApiError } from '@/api/client';
import { useBankDetails, useConfirmBankDetails, useReportBankDetails, useSaveBankDetails } from '@/api/payments';
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
          : `Where ${first}’s pay goes. Only the last digits are shown. Payments to changed details wait until they are confirmed.`}
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
  const by = d.changedByName && d.changedBy !== d.userId ? ` by ${d.changedByName}` : '';
  // what the hold says, and who may lift it here
  let hold: string | null = null;
  if (d.needsConfirmation) {
    if (own) {
      hold = d.reportedAt
        ? `You said these are not your details on ${dayOf(d.reportedAt)}. Nothing is paid to them. Press Change and type in your own, or ask the office.`
        : view.changedBySomeoneElse
          ? `Your bank details were changed${by} on ${dayOf(d.changedAt)}. Confirm or report it: until you say yes (or another administrator confirms them), nothing is paid to them.`
          : `Changed on ${dayOf(d.changedAt)}. The office checks new details with you before the next payment goes there.`;
    } else if (d.reportedAt) {
      hold = `${first} said these are not their details on ${dayOf(d.reportedAt)}. Nothing is paid to them. Type in the right ones with ${first} (Change).`;
    } else if (d.waitingFor === 'person_or_other_admin') {
      hold = view.canConfirm
        ? `${d.changedByName ?? 'An administrator'} typed these in for ${first} on ${dayOf(d.changedAt)}. Check them with ${first} (in person or by phone), then confirm. Until ${first} or you confirm them, payments to them wait.`
        : `You typed these in on ${dayOf(d.changedAt)}. They wait until ${first} confirms them in Settings, or another administrator confirms them here.`;
    } else {
      hold = `${first} changed these on ${dayOf(d.changedAt)}${by}. Check them with ${first} (in person or by phone), then confirm. Until then, payments to them wait.`;
    }
  }
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 @xl:grid-cols-3">
        <div className="flex flex-col border-b border-border pb-2"><dt className="text-xs font-medium text-muted">Name on the account</dt><dd className="break-words text-sm text-fg">{d.holderName}</dd></div>
        <div className="flex flex-col border-b border-border pb-2"><dt className="text-xs font-medium text-muted">Sort code</dt><dd className="whitespace-nowrap font-mono text-sm tabular-nums text-fg">{d.sortCodeMasked}</dd></div>
        <div className="flex flex-col border-b border-border pb-2"><dt className="text-xs font-medium text-muted">Account number</dt><dd className="whitespace-nowrap font-mono text-sm tabular-nums text-fg">{d.accountNumberMasked}</dd></div>
      </dl>
      {hold ? (
        <div
          className={`space-y-3 rounded-xl border p-3 ${own && (view.changedBySomeoneElse || d.reportedAt) ? 'border-danger/30 bg-danger-soft' : 'border-warning/30 bg-warning-soft'}`}
          data-bank-hold=""
          role={own && view.changedBySomeoneElse ? 'alert' : undefined}
        >
          <p className="flex items-start gap-2 text-sm text-fg">
            <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${own && view.changedBySomeoneElse ? 'text-danger' : 'text-warning'}`} aria-hidden />
            <span>{hold}</span>
          </p>
          {view.canConfirm && <ConfirmDetails view={view} userId={userId} own={own} first={first} />}
          {own && view.canReport && <ReportDetails />}
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

/** "Confirm details" (an administrator: always with a fresh code) or "Yes, these are mine" (the person). */
function ConfirmDetails({ view, userId, own, first }: { view: BankDetailsView; userId: number | null; own: boolean; first: string }) {
  const uid = useId();
  const d = view.details!;
  const confirm = useConfirmBankDetails(userId);
  const toast = useToast();
  const [code, setCode] = useState('');
  const needsCode = !own || view.codeRequired;
  const errs = fieldErrors(confirm.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    confirm.mutate({ changedAt: d.changedAt, ...(needsCode ? { code: code.replace(/\s+/g, '') } : {}) }, {
      onSuccess: () => {
        setCode('');
        toast.success(own ? 'Thank you: your bank details are confirmed' : 'Bank details confirmed', own ? 'Your pay goes there from now on.' : `Payments to ${first} can use them now.`);
      },
      onError: (err) => { if (!Object.keys(fieldErrors(err)).length) toast.error('Could not confirm them', errorMessage(err)); },
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 @lg:flex-row @lg:items-end" noValidate>
      {needsCode && (
        <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} error={errs.code} className="@lg:w-56">
          <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" invalid={!!errs.code} className="font-mono" />
        </Field>
      )}
      <Button type="submit" size="sm" className="h-10 shrink-0 self-start @lg:self-auto" loading={confirm.isPending} leftIcon={<CheckCircle2 aria-hidden />}>
        {own ? 'Yes, these are mine' : 'Confirm details'}
      </Button>
    </form>
  );
}

/** "These are not mine": payments to them stop until the right ones are typed in; the office is told. */
function ReportDetails() {
  const report = useReportBankDetails();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const uid = useId();
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" className="h-10" leftIcon={<Flag aria-hidden />} onClick={() => setOpen(true)}>
        These are not mine
      </Button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        report.mutate({ note: note.trim() || undefined }, {
          onSuccess: () => toast.success('Reported to the office', 'Nothing is paid to these details. Type in your own with Change.'),
          onError: (err) => toast.error('Could not report them', errorMessage(err)),
        });
      }}
    >
      <Field label="Anything the office should know (optional)" htmlFor={`${uid}-note`}>
        <Input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" className="h-10" loading={report.isPending}>Report: not my details</Button>
        <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setOpen(false)}>Back</Button>
      </div>
    </form>
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
    save.mutate({ ...local.value, ...(view.codeRequired || !own ? { code: code.replace(/\s+/g, '') } : {}) }, {
      onSuccess: (v) => {
        toast.success('Bank details saved', own
          ? v.details?.needsConfirmation ? 'The office checks them with you before the next payment goes there.' : 'Payments use them from now on.'
          : 'They wait until the person confirms them, or another administrator does.');
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
      {(view.codeRequired || !own) && (
        <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} error={errs.code} hint="Bank details are only changed with your two-step code." required>
          <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" invalid={!!errs.code} className="font-mono @md:w-40" />
        </Field>
      )}
      <p className="text-xs text-muted">
        {own
          ? 'Type the full numbers each time you change them: Linear Hub never shows them again. The office checks new details with you before paying.'
          : 'Details you type in for someone wait until they confirm them in their own account, or a different administrator confirms them. They are told the details changed.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending} className="h-10">Save bank details</Button>
        <Button type="button" variant="ghost" className="h-10" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
