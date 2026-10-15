// "New announcement" for admins and leaders — posts to every dashboard (USER_GUIDE › Announcements).
import { useId, useState } from 'react';
import { Button, Field, Input, Modal, Switch, Textarea, useToast } from '@/components/ui';
import { useCreateAnnouncement } from '@/api/hooks';
import { errorMessage } from '@/features/common';

export function NewAnnouncementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="New announcement" description="Everyone sees it on their dashboard. Pin it to keep it at the top." size="md">
      <AnnouncementForm onClose={onClose} />
    </Modal>
  );
}

function AnnouncementForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const uid = useId();
  const create = useCreateAnnouncement();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});

  const submit = async () => {
    const e: { title?: string; body?: string } = {};
    if (!title.trim()) e.title = 'Give the announcement a title';
    if (!body.trim()) e.body = 'Write the message';
    setErrors(e);
    if (e.title || e.body) return;
    try {
      await create.mutateAsync({ title: title.trim(), body: body.trim(), pinned });
      toast.success('Announcement posted', pinned ? 'Pinned to the top of every dashboard' : title.trim());
      onClose();
    } catch (err) {
      toast.error('Could not post announcement', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <Field label="Title" required htmlFor={`${uid}-title`} error={errors.title}>
        <Input id={`${uid}-title`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} invalid={!!errors.title} placeholder="e.g. Saturday incentive: £50 for the top closer" autoFocus />
      </Field>
      <Field label="Message" required htmlFor={`${uid}-body`} error={errors.body}>
        <Textarea id={`${uid}-body`} rows={4} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} invalid={!!errors.body} placeholder="What does the team need to know?" />
      </Field>
      <Switch checked={pinned} onChange={setPinned} label="Pinned" description="Keep it at the top until it is unpinned" labelPosition="end" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending}>Post announcement</Button>
      </div>
    </form>
  );
}
