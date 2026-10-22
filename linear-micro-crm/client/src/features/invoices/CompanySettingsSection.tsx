// Release 1.3 slot — OWNED BY P2 invoices. Settings → Company (admin): legal name, address, postcode, company number,
// the authorised signatory and an optional signature image, printed as the customer on every self-billing invoice
// (invoices still open pick the change up; accepted ones keep what was accepted). Mounted in pages/Settings.tsx after
// Settings → Pay, administrators only, in an ErrorBoundary with fallback={null}. A whole Card.
// The signature is sent inside the JSON as a PNG data URL (at most 200 KB): a PNG or JPEG photo of a signature is
// scaled to fit 600 × 200 px and turned into a PNG in the browser first.
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Building2, ImagePlus, Trash2 } from 'lucide-react';
import { normalisePostcode, type CompanySettings, type CompanySettingsInput } from '@lm/shared';
import { Button, Card, CardHeader, Field, Input, Skeleton, Textarea, useToast } from '@/components/ui';
import { useCompanySettings, useSaveCompanySettings } from '@/api/invoices';
import { ErrorState, errorMessage } from '@/features/common';
import { AgreementDialog } from './AgreementDialog';

export interface CompanySettingsSectionProps {
  className?: string;
}

const SIGNATURE_MAX_BYTES = 200 * 1024;

interface Draft {
  legalName: string;
  address: string;
  postcode: string;
  companyNumber: string;
  signatoryName: string;
}

const draftOf = (c: CompanySettings): Draft => ({
  legalName: c.legalName,
  address: c.addressLines.join('\n'),
  postcode: c.postcode ?? '',
  companyNumber: c.companyNumber ?? '',
  signatoryName: c.signatoryName,
});

/** A picked image file → a PNG data URL that fits 600 × 200 (null + a message when it cannot be used). */
async function signatureDataUrl(file: File): Promise<{ url: string } | { error: string }> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) return { error: 'Choose a PNG or JPEG image' };
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('unreadable'));
      i.src = src;
    });
    const scale = Math.min(1, 600 / img.naturalWidth, 200 / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/png');
    const bytes = Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);
    if (bytes > SIGNATURE_MAX_BYTES) return { error: 'That image is over 200 KB even after resizing: crop it to the signature and try again' };
    return { url };
  } catch {
    return { error: 'That file could not be read as an image' };
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function CompanySettingsSection({ className }: CompanySettingsSectionProps) {
  const uid = useId();
  const q = useCompanySettings();
  const save = useSaveCompanySettings();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [d, setD] = useState<Draft | null>(null);
  /** undefined: unchanged; null: remove; a data URL: replace. */
  const [signature, setSignature] = useState<string | null | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (q.data) {
      setD(draftOf(q.data));
      setSignature(undefined);
    }
  }, [q.data]);

  if (q.isLoading || (!d && !q.isError)) {
    return (
      <Card className={className}>
        <CardHeader title="Company details on invoices" icon={<Building2 aria-hidden />} />
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-20" /><Skeleton className="h-10 w-1/2" /></div>
      </Card>
    );
  }
  if (q.isError || !q.data || !d) {
    return (
      <Card className={className}>
        <CardHeader title="Company details on invoices" icon={<Building2 aria-hidden />} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} className="p-4" />
      </Card>
    );
  }
  const c = q.data;
  const lines = d.address.split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = {
    legalName: touched && !d.legalName.trim() ? 'Enter the company\'s legal name' : undefined,
    address: touched && lines.length > 4 ? 'Use at most 4 lines' : undefined,
    postcode: touched && d.postcode.trim() && !normalisePostcode(d.postcode) ? 'Enter a UK postcode, e.g. M3 2BB' : undefined,
    companyNumber: touched && d.companyNumber.trim() && !/^(?:\d{8}|[A-Z]{2}\d{6})$/i.test(d.companyNumber.replace(/\s+/g, '')) ? '8 characters, e.g. 12345678 or SC123456' : undefined,
  };
  const dirty = signature !== undefined || JSON.stringify(d) !== JSON.stringify(draftOf(c));
  const shownSignature = signature === undefined ? c.signatureUrl : signature;
  const set = (k: keyof Draft) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD((prev) => (prev ? { ...prev, [k]: e.target.value } : prev));

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const r = await signatureDataUrl(file);
    if ('error' in r) setFileError(r.error);
    else {
      setFileError(null);
      setSignature(r.url);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!d.legalName.trim() || lines.length > 4 || (d.postcode.trim() && !normalisePostcode(d.postcode))) return;
    if (errs.companyNumber) return;
    const input: CompanySettingsInput = {
      legalName: d.legalName.trim(),
      addressLines: lines,
      postcode: d.postcode.trim() || null,
      companyNumber: d.companyNumber.trim() || null,
      signatoryName: d.signatoryName.trim(),
      ...(signature !== undefined ? { signatureImage: signature } : {}),
    };
    save.mutate(input, {
      onSuccess: () => toast.success('Company details saved', 'Invoices still waiting to be accepted show them now.'),
      onError: (err) => toast.error('Could not save the company details', errorMessage(err)),
    });
  };

  return (
    <Card className={className} data-testid="company-settings">
      <CardHeader
        title="Company details on invoices"
        description="Printed as the customer on every self-billing invoice, with the authorised signatory."
        icon={<Building2 aria-hidden />}
        actions={<Button size="sm" variant="ghost" onClick={() => setPreview(true)} className="h-10 sm:h-8">Agreement text</Button>}
      />
      {(!c.postcode || !c.companyNumber) && (
        <p className="mb-4 rounded-lg bg-info-soft p-3 text-sm text-info">Add the company's postcode and company number so every invoice carries them.</p>
      )}
      <form onSubmit={submit} noValidate className="space-y-3" aria-label="Company details on invoices">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Legal name" required htmlFor={`${uid}-name`} className="sm:col-span-2" error={errs.legalName}>
            <Input id={`${uid}-name`} value={d.legalName} onChange={set('legalName')} maxLength={120} invalid={!!errs.legalName} />
          </Field>
          <Field label="Address" htmlFor={`${uid}-address`} hint="One line per row, up to 4." className="sm:col-span-2" error={errs.address}>
            <Textarea id={`${uid}-address`} value={d.address} onChange={set('address')} rows={3} className="min-h-[80px]" invalid={!!errs.address} />
          </Field>
          <Field label="Postcode" htmlFor={`${uid}-pc`} error={errs.postcode}>
            <Input id={`${uid}-pc`} value={d.postcode} onChange={set('postcode')} maxLength={10} className="uppercase" invalid={!!errs.postcode} />
          </Field>
          <Field label="Company number" optional htmlFor={`${uid}-cn`} error={errs.companyNumber}>
            <Input id={`${uid}-cn`} value={d.companyNumber} onChange={set('companyNumber')} maxLength={12} className="uppercase" invalid={!!errs.companyNumber} />
          </Field>
          <Field label="Authorised signatory" htmlFor={`${uid}-sig`} hint="The person who signs the invoices for the company." className="sm:col-span-2">
            <Input id={`${uid}-sig`} value={d.signatoryName} onChange={set('signatoryName')} maxLength={80} />
          </Field>
        </div>
        <Field label="Signature" optional as="div" hint="A PNG or JPEG of the signature, on a plain background. Printed above the signatory's name." error={fileError ?? undefined}>
          <div className="flex flex-wrap items-center gap-3">
            {shownSignature ? (
              <img src={shownSignature} alt="The signature printed on invoices" className="h-14 max-w-[220px] rounded border border-border bg-white object-contain p-1" />
            ) : (
              <span className="text-sm text-muted">No signature: invoices show the name only.</span>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="sr-only" id={`${uid}-file`} onChange={(e) => void pick(e)} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} leftIcon={<ImagePlus aria-hidden />} className="h-10 sm:h-8">
              {shownSignature ? 'Replace' : 'Add a signature'}
            </Button>
            {shownSignature && (
              <Button variant="ghost" size="sm" onClick={() => setSignature(null)} leftIcon={<Trash2 aria-hidden />} className="h-10 sm:h-8">Remove</Button>
            )}
          </div>
        </Field>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending} disabled={!dirty} className="h-10 w-full sm:w-auto">Save company details</Button>
        </div>
      </form>
      <AgreementDialog open={preview} onClose={() => setPreview(false)} canAccept={false} />
    </Card>
  );
}
