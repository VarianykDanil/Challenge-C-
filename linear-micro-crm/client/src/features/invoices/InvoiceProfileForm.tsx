// Release 1.3 — OWNED BY P2 invoices. The supplier details printed on a person's self-billing invoices: address,
// postcode, UTR (optional) and VAT number (optional; none → "Not VAT registered"). Used by Settings → Invoices (the
// person) and Team → person (admin). The server checks the formats again and refreshes the invoices still open.
import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { normalisePostcode, normaliseUtr, normaliseVatNumber, type InvoiceProfile, type InvoiceProfileInput } from '@lm/shared';
import { Button, Field, Input, useToast } from '@/components/ui';
import { useSaveInvoiceProfile } from '@/api/invoices';
import { errorMessage } from '@/features/common';

interface Draft {
  addressLine1: string;
  addressLine2: string;
  addressTown: string;
  postcode: string;
  utr: string;
  vatNumber: string;
}

const draftOf = (p: InvoiceProfile): Draft => ({
  addressLine1: p.addressLine1 ?? '',
  addressLine2: p.addressLine2 ?? '',
  addressTown: p.addressTown ?? '',
  postcode: p.postcode ?? '',
  utr: p.utr ?? '',
  vatNumber: p.vatNumber ?? '',
});

function problems(d: Draft): Partial<Record<keyof Draft, string>> {
  const out: Partial<Record<keyof Draft, string>> = {};
  if (d.postcode.trim() && !normalisePostcode(d.postcode)) out.postcode = 'Enter a UK postcode, e.g. M14 5QT';
  if (d.utr.trim() && !normaliseUtr(d.utr)) out.utr = 'A UTR is 10 digits';
  if (d.vatNumber.trim() && !normaliseVatNumber(d.vatNumber)) out.vatNumber = 'GB followed by 9 digits, e.g. GB123456789';
  return out;
}

export function InvoiceProfileForm({ profile, userId, self }: { profile: InvoiceProfile; userId?: number; self: boolean }) {
  const uid = useId();
  const [d, setD] = useState<Draft>(() => draftOf(profile));
  const [touched, setTouched] = useState(false);
  const save = useSaveInvoiceProfile(userId);
  const toast = useToast();
  useEffect(() => setD(draftOf(profile)), [profile]);
  const errs = touched ? problems(d) : {};
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(profile));
  const set = (k: keyof Draft) => (e: ChangeEvent<HTMLInputElement>) => setD((prev) => ({ ...prev, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(problems(d)).length) return;
    const input: InvoiceProfileInput = {
      addressLine1: d.addressLine1.trim() || null,
      addressLine2: d.addressLine2.trim() || null,
      addressTown: d.addressTown.trim() || null,
      postcode: d.postcode.trim() || null,
      utr: d.utr.trim() || null,
      vatNumber: d.vatNumber.trim() || null,
    };
    save.mutate(input, {
      onSuccess: () => toast.success('Invoice details saved', self ? 'They are printed on your invoices from now on.' : `Printed on ${profile.name.split(' ')[0]}'s invoices from now on.`),
      onError: (err) => toast.error('Could not save the details', errorMessage(err)),
    });
  };
  return (
    <form onSubmit={submit} noValidate className="@container space-y-3" aria-label="Invoice details">
      <div className="grid gap-3 @md:grid-cols-2">
        <Field label="Address line 1" htmlFor={`${uid}-a1`} className="@md:col-span-2">
          <Input id={`${uid}-a1`} value={d.addressLine1} onChange={set('addressLine1')} autoComplete={self ? 'address-line1' : 'off'} maxLength={100} placeholder="e.g. 12 Oak Road" />
        </Field>
        <Field label="Address line 2" optional htmlFor={`${uid}-a2`} className="@md:col-span-2">
          <Input id={`${uid}-a2`} value={d.addressLine2} onChange={set('addressLine2')} autoComplete={self ? 'address-line2' : 'off'} maxLength={100} />
        </Field>
        <Field label="Town or city" htmlFor={`${uid}-town`}>
          <Input id={`${uid}-town`} value={d.addressTown} onChange={set('addressTown')} autoComplete={self ? 'address-level2' : 'off'} maxLength={60} />
        </Field>
        <Field label="Postcode" htmlFor={`${uid}-pc`} error={errs.postcode}>
          <Input id={`${uid}-pc`} value={d.postcode} onChange={set('postcode')} autoComplete={self ? 'postal-code' : 'off'} maxLength={10} invalid={!!errs.postcode} className="uppercase" />
        </Field>
        <Field label="Unique Taxpayer Reference (UTR)" optional htmlFor={`${uid}-utr`} hint={self ? '10 digits, from HMRC. Leave it empty if you do not have one yet.' : '10 digits, from HMRC.'} error={errs.utr}>
          <Input id={`${uid}-utr`} value={d.utr} onChange={set('utr')} inputMode="numeric" maxLength={14} invalid={!!errs.utr} />
        </Field>
        <Field label="VAT number" optional htmlFor={`${uid}-vat`} hint="Only if VAT registered. Empty: the invoice says Not VAT registered." error={errs.vatNumber}>
          <Input id={`${uid}-vat`} value={d.vatNumber} onChange={set('vatNumber')} maxLength={20} invalid={!!errs.vatNumber} className="uppercase" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending} disabled={!dirty} className="h-10 w-full @md:w-auto">Save details</Button>
      </div>
    </form>
  );
}
