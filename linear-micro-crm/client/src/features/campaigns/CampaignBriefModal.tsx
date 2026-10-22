// Release 1.3 — OWNED BY P6 client-portal. "Edit brief" on the campaign page (admin): the full description, the brief
// for the field team, and the client's contact. PATCH /campaigns/:id with these fields only; an emptied field is cleared.
import { useId, useState } from 'react';
import type { CampaignBrief } from '@lm/shared';
import { useSaveCampaignBrief } from '@/api/clientPortal';
import { Button, Field, Input, Modal, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/features/common/QueryStates';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CampaignBriefModal({ campaignId, campaignName, brief, onClose }: { campaignId: number; campaignName: string; brief: CampaignBrief; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const save = useSaveCampaignBrief(campaignId);
  const [f, setF] = useState({
    longDescription: brief.longDescription ?? '',
    brief: brief.brief ?? '',
    contactName: brief.contactName ?? '',
    contactEmail: brief.contactEmail ?? '',
    contactPhone: brief.contactPhone ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const emailError = submitted && f.contactEmail.trim() && !EMAIL_RE.test(f.contactEmail.trim()) ? 'Enter a valid email, or leave it empty' : undefined;

  async function submit() {
    setSubmitted(true);
    if (f.contactEmail.trim() && !EMAIL_RE.test(f.contactEmail.trim())) return;
    try {
      await save.mutateAsync({
        longDescription: f.longDescription.trim() || null,
        brief: f.brief.trim() || null,
        contactName: f.contactName.trim() || null,
        contactEmail: f.contactEmail.trim() || null,
        contactPhone: f.contactPhone.trim() || null,
      });
      toast.success('Brief saved', campaignName);
      onClose();
    } catch (err) {
      toast.error('Could not save the brief', errorMessage(err));
    }
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit brief"
      description={`What everyone sees on the ${campaignName} page. Reps see it too, without any money.`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form={formId} loading={save.isPending}>Save brief</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" noValidate>
        <Field label="About the client" optional htmlFor={`${uid}-long`} hint="Who they are and what the campaign does.">
          <Textarea id={`${uid}-long`} rows={4} maxLength={5000} value={f.longDescription} onChange={(e) => setF({ ...f, longDescription: e.target.value })} />
        </Field>
        <Field label="Brief for the field team" optional htmlFor={`${uid}-brief`} hint="One point per line: the pitch, minimum gifts, who can sign up, rules on site.">
          <Textarea id={`${uid}-brief`} rows={6} maxLength={5000} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Contact name" optional htmlFor={`${uid}-cname`}>
            <Input id={`${uid}-cname`} maxLength={120} value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
          </Field>
          <Field label="Contact email" optional htmlFor={`${uid}-cemail`} error={emailError}>
            <Input id={`${uid}-cemail`} type="email" inputMode="email" maxLength={200} value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} invalid={!!emailError} />
          </Field>
          <Field label="Contact phone" optional htmlFor={`${uid}-cphone`}>
            <Input id={`${uid}-cphone`} type="tel" inputMode="tel" maxLength={40} value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
