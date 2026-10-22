// Release 1.3 — OWNED BY P2 invoices. The three invoice dialogs:
//  - DisputeDialog ("Something's wrong", the supplier): pick the lines, say why (e.g. "I made 18 sales, not 16");
//  - ResolveDialog (admin): "Fix and reissue" (a note, an optional correction to the week) or "Keep as it is" (a note);
//  - MarkPaidAnywayDialog (admin): pay an invoice that is not accepted yet, with a reason (kept with the invoice and
//    in the audit trail).
import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, MessageSquareWarning, Wallet, Wrench } from 'lucide-react';
import clsx from 'clsx';
import type { Invoice, InvoiceLine } from '@lm/shared';
import { Button, Field, Input, Modal, Textarea, useToast } from '@/components/ui';
import { useDisputeInvoice, useMarkPaidWithReason, useResolveInvoice } from '@/api/invoices';
import { errorMessage } from '@/features/common';
import { deadlineShort, money, signedMoney } from './invoiceText';

const firstName = (name: string) => name.split(' ')[0] ?? name;

function LinePick({ line, index, checked, note, onToggle, onNote }: { line: InvoiceLine; index: number; checked: boolean; note: string; onToggle: (v: boolean) => void; onNote: (v: string) => void }) {
  const id = useId();
  return (
    <li className={clsx('rounded-lg border p-2.5', checked ? 'border-danger/40 bg-danger/5' : 'border-border')}>
      <label htmlFor={`${id}-box`} className="flex min-h-10 cursor-pointer items-start gap-3">
        <input
          id={`${id}-box`}
          type="checkbox"
          className="focus-ring mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-control-border accent-[var(--color-primary)]"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          data-dispute-line={index}
        />
        <span className="min-w-0 flex-1 text-sm">
          <span className="block break-words text-fg">{line.description}</span>
          <span className="text-xs text-muted">{line.paid ? signedMoney(line.amount) : `${money(line.amount)}, not paid`}</span>
        </span>
      </label>
      {checked && (
        <div className="mt-2 pl-7">
          <label htmlFor={`${id}-note`} className="sr-only">What it should be</label>
          <Input id={`${id}-note`} value={note} onChange={(e) => onNote(e.target.value)} maxLength={300} placeholder="What it should be, e.g. 18 sales" />
        </div>
      )}
    </li>
  );
}

/** "Something's wrong": the supplier picks the lines and says why. The invoice is then held for the office. */
export function DisputeDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const [picked, setPicked] = useState<Map<number, string>>(() => new Map());
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const dispute = useDisputeInvoice();
  const toast = useToast();
  useEffect(() => {
    if (open) { setPicked(new Map()); setReason(''); setTouched(false); }
  }, [open]);
  const problem = reason.trim().length < 3 ? 'Say what is wrong (at least 3 characters)' : null;
  const send = () => {
    setTouched(true);
    if (problem) return;
    dispute.mutate(
      { id: invoice.id, reason: reason.trim(), lines: [...picked].map(([line, note]) => (note.trim() ? { line, note: note.trim() } : { line })) },
      {
        onSuccess: () => {
          toast.success('Sent to the office', 'They will check it and either fix it or explain why it stands.');
          onClose();
        },
        onError: (e) => toast.error('Could not send it', errorMessage(e)),
      },
    );
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Something's wrong"
      description={`Invoice ${invoice.number} · ${money(invoice.total)}. Send it before ${deadlineShort(invoice.deemedAcceptedAt)}.`}
      icon={<MessageSquareWarning aria-hidden />}
      tone="warning"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={dispute.isPending}>Cancel</Button>
          <Button onClick={send} loading={dispute.isPending}>Send to the office</Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-fg">Which lines are wrong? <span className="font-normal text-muted">Optional</span></legend>
          <ul className="space-y-2">
            {invoice.lines.map((l, i) => (
              <LinePick
                key={i}
                line={l}
                index={i}
                checked={picked.has(i)}
                note={picked.get(i) ?? ''}
                onToggle={(v) => setPicked((prev) => { const next = new Map(prev); if (v) next.set(i, ''); else next.delete(i); return next; })}
                onNote={(v) => setPicked((prev) => new Map(prev).set(i, v))}
              />
            ))}
          </ul>
        </fieldset>
        <Field label="What's wrong?" required error={touched && problem ? problem : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} showCount placeholder="e.g. I made 18 sales, not 16. Two sign-ups on Saturday are missing." />
        </Field>
        <p className="text-xs text-muted">A disputed invoice is held until the office has checked it. You will see their answer here and in your notifications.</p>
      </div>
    </Modal>
  );
}

/** Admin: "Fix and reissue" or "Keep as it is" for a disputed invoice. */
export function ResolveDialog({ invoice, mode, open, onClose, runTotal, figuresChanged }: {
  invoice: Pick<Invoice, 'id' | 'number' | 'total'> & { supplierName: string; reason: string };
  mode: 'reissue' | 'keep';
  open: boolean;
  onClose: () => void;
  /** The run's gross as it stands now (what a reissue issues before any correction). */
  runTotal?: number;
  figuresChanged?: boolean;
}) {
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [touched, setTouched] = useState(false);
  const resolve = useResolveInvoice();
  const toast = useToast();
  useEffect(() => {
    if (open) { setNote(''); setAmount(''); setWhat(''); setTouched(false); }
  }, [open]);
  const name = firstName(invoice.supplierName);
  const parsed = amount.trim() === '' ? null : Number(amount.replace(/[£,\s]/g, ''));
  const amountProblem = parsed !== null && (!Number.isFinite(parsed) || parsed === 0) ? 'Enter pounds, e.g. 20 or -12.50' : null;
  const noteProblem = note.trim().length < 3 ? `Write a note for ${name} (at least 3 characters)` : null;
  const submit = () => {
    setTouched(true);
    if (noteProblem || amountProblem) return;
    resolve.mutate(
      { id: invoice.id, action: mode, note: note.trim(), ...(mode === 'reissue' && parsed !== null ? { adjustment: { amount: parsed, ...(what.trim() ? { note: what.trim() } : {}) } } : {}) },
      {
        onSuccess: (res) => {
          toast.success(mode === 'keep' ? 'Kept as it is' : `Reissued as version ${res.version}`, mode === 'keep' ? `${name} sees your note.` : `${name} is asked to accept ${money(res.total)}.`);
          onClose();
        },
        onError: (e) => toast.error('Could not resolve the dispute', errorMessage(e)),
      },
    );
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'keep' ? 'Keep as it is' : 'Fix and reissue'}
      description={`${invoice.supplierName} · invoice ${invoice.number} · ${money(invoice.total)}`}
      icon={mode === 'keep' ? <CheckCircle2 aria-hidden /> : <Wrench aria-hidden />}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={resolve.isPending}>Cancel</Button>
          <Button onClick={submit} loading={resolve.isPending}>{mode === 'keep' ? 'Keep as it is' : 'Fix and reissue'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <blockquote className="rounded-lg border border-border bg-surface-2/60 p-3 text-sm text-fg">“{invoice.reason}”</blockquote>
        {mode === 'reissue' ? (
          <>
            <p className="text-sm text-muted">
              The new version is the week as it stands now{runTotal !== undefined ? `: ${money(runTotal)}` : ''}
              {figuresChanged ? ' (the figures have changed since the dispute)' : ''}. Correct the gauges first, or add a correction here. {name} then accepts the new version.
            </p>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <Field label="Correction" optional hint="£ added (or −£ taken off)" error={touched && amountProblem ? amountProblem : undefined}>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 20" leftIcon={<span className="text-sm">£</span>} />
              </Field>
              <Field label="What it is for" optional>
                <Input value={what} onChange={(e) => setWhat(e.target.value)} maxLength={300} placeholder="e.g. 2 sales missing from Saturday" />
              </Field>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">The invoice stands as issued and can be paid. {name} sees your note.</p>
        )}
        <Field label={`Note for ${name}`} required error={touched && noteProblem ? noteProblem : undefined}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} showCount placeholder={mode === 'keep' ? 'e.g. We checked the gauges with your leader: 16 sales were logged.' : 'e.g. Added your two missing sales.'} />
        </Field>
      </div>
    </Modal>
  );
}

/** Admin: Mark paid although the invoice is not accepted yet, with a reason (never a disputed one: it is held until resolved). */
export function MarkPaidAnywayDialog({ runId, invoice, open, onClose }: { runId: number; invoice: Invoice; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const pay = useMarkPaidWithReason();
  const toast = useToast();
  useEffect(() => {
    if (open) { setReason(''); setTouched(false); }
  }, [open]);
  const problem = reason.trim().length < 3 ? 'Give a reason (at least 3 characters)' : null;
  const submit = () => {
    setTouched(true);
    if (problem) return;
    pay.mutate({ runId, overrideReason: reason.trim() }, {
      onSuccess: (r) => {
        toast.success(r.status === 'late' ? 'Marked paid (late)' : 'Marked paid', `${r.userName} · ${money(r.gross)}`);
        onClose();
      },
      onError: (e) => toast.error('Could not mark as paid', errorMessage(e)),
    });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark paid anyway"
      description={`${invoice.supplier.name} · ${money(invoice.total)} · invoice ${invoice.number}`}
      icon={<Wallet aria-hidden />}
      tone="warning"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pay.isPending}>Cancel</Button>
          <Button onClick={submit} loading={pay.isPending}>Mark paid anyway</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>{`${firstName(invoice.supplier.name)} has not accepted this invoice yet. It counts as accepted at ${deadlineShort(invoice.deemedAcceptedAt)} unless disputed.`}</span>
        </p>
        <Field label="Reason" required hint="Kept with the invoice and in the audit trail." error={touched && problem ? problem : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} showCount placeholder="e.g. Paying early: they asked for it before a holiday." />
        </Field>
      </div>
    </Modal>
  );
}
