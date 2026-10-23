// Release 1.4 — OWNED BY P bank payment file. The pieces of the bank file's screens:
//  - OptionPicker: a connection form's choice whose options carry a logo (the bank file's "File format": the general
//    Faster Payments file, Starling Bank, Revolut Business), drawn as a list of radio choices with the bank's logo and
//    a one-line hint. Used by PaymentsSettingsSection's ConfigInput in place of a plain select.
//  - BankFileHelp: on a bank file payment (pages/PaymentBatch.tsx), which file it is and where to upload it, in the
//    bank's own words, plus what could not be checked against the bank's template.
// Both sit in the lazy payment chunks only (Settings → Payments and the payment page).
import { useId } from 'react';
import clsx from 'clsx';
import { Info } from 'lucide-react';
import { bankFileFormat, type PaymentConfigField } from '@lm/shared';
import { usePaymentConnections } from '@/api/payments';
import { ProviderLogo } from './ProviderLogo';

export function hasOptionLogos(f: PaymentConfigField): boolean {
  return f.type === 'select' && (f.options ?? []).some((o) => !!o.iconKey);
}

export function OptionPicker({ field: f, value, error, onChange }: { field: PaymentConfigField; value: string; error?: string; onChange: (v: string) => void }) {
  const uid = useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  return (
    <fieldset className="min-w-0 text-sm" aria-describedby={error ? errorId : f.help ? hintId : undefined} data-option-picker={f.name}>
      <legend className="mb-1.5 font-medium text-fg">
        {f.label}
        {f.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </legend>
      <div className="grid gap-2">
        {(f.options ?? []).map((o) => {
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              className={clsx(
                'flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                checked ? 'border-primary/60 bg-primary-soft' : 'border-border bg-surface hover:bg-surface-2',
                error && !checked && 'border-danger/50',
              )}
              data-option={o.value}
            >
              <input
                type="radio"
                name={`${uid}-${f.name}`}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="focus-ring mt-1.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-primary)]"
              />
              {o.iconKey && <ProviderLogo iconKey={o.iconKey} size="sm" />}
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg">{o.label}</span>
                {o.hint && <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <span id={errorId} className="mt-1.5 block text-xs font-medium text-danger" role="alert">{error}</span>
      ) : f.help ? (
        <span id={hintId} className="mt-1.5 block text-xs text-muted">{f.help}</span>
      ) : null}
    </fieldset>
  );
}

/** "Starling Bank bulk payments (CSV)" for a bank file connection's settings (null for anything else). */
export function bankFileFormatLabel(settings: Record<string, string> | undefined): string | null {
  return bankFileFormat(settings?.format)?.label ?? null;
}

/** On a bank file payment: which file, where to upload it, what to check first. */
export function BankFileHelp({ connectionId, className }: { connectionId: number; className?: string }) {
  const connections = usePaymentConnections();
  const conn = connections.data?.find((c) => c.id === connectionId);
  const format = bankFileFormat(conn?.settings.format);
  if (!format) return null;
  return (
    <div className={clsx('flex items-start gap-3 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5 text-sm', className)} data-bank-file-help={format.id}>
      <ProviderLogo iconKey={format.iconKey} size="sm" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-fg">{format.label}</p>
        <p className="text-muted">{format.uploadSteps}</p>
        {format.checkFirst && (
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{format.checkFirst}</span>
          </p>
        )}
      </div>
    </div>
  );
}
