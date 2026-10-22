// Release 1.3 — P5 learning-videos: Edit video (title, what it covers, topic, who it is for, required, a link's length)
// and Delete video (confirmed; an upload's file goes with it). Shown to whoever may change it (LearningVideo.canEdit).
import { useId, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { formatVideoLength, parseVideoLength, type LearningVideo } from '@lm/shared';
import { useDeleteVideo, useUpdateVideo } from '@/api/videos';
import { Button, Field, Input, Modal, useToast } from '@/components/ui';
import { ConfirmDialog, errorMessage } from '@/features/common';
import { VideoFields, validateVideoFields, type VideoFieldErrors, type VideoFieldValues } from './VideoFields';
import { VIDEO_COPY } from './videoCopy';

export function EditVideoModal({ video, open, onClose, onDeleted }: { video: LearningVideo; open: boolean; onClose: () => void; onDeleted: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={VIDEO_COPY.edit.title} size="lg">
      {open && <EditVideoForm video={video} onClose={onClose} onDeleted={onDeleted} />}
    </Modal>
  );
}

function EditVideoForm({ video, onClose, onDeleted }: { video: LearningVideo; onClose: () => void; onDeleted: () => void }) {
  const t = VIDEO_COPY.edit;
  const uid = useId();
  const toast = useToast();
  const update = useUpdateVideo();
  const remove = useDeleteVideo();
  const [fields, setFields] = useState<VideoFieldValues>({
    title: video.title,
    description: video.description,
    topic: video.topic,
    audience: video.audience,
    required: video.required,
  });
  const [length, setLength] = useState(video.durationS ? formatVideoLength(video.durationS) : '');
  // a link's length is typed in; an upload's comes from the file, so it is asked for only while it is not known
  const askLength = video.kind === 'link' || !video.durationS;
  const [errors, setErrors] = useState<VideoFieldErrors>({});
  const [confirm, setConfirm] = useState(false);

  const submit = async () => {
    const e = validateVideoFields(fields);
    const parsed = askLength ? parseVideoLength(length) : undefined;
    if (parsed !== undefined && parsed !== null && Number.isNaN(parsed)) e.length = VIDEO_COPY.add.lengthBad;
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    try {
      await update.mutateAsync({
        id: video.id,
        title: fields.title.trim(),
        description: fields.description.trim(),
        topic: fields.topic,
        audience: fields.audience,
        required: fields.required,
        ...(parsed !== undefined ? { durationS: parsed } : {}),
      });
      toast.success(t.saved, fields.title.trim());
      onClose();
    } catch (err) {
      toast.error('Could not save the video', errorMessage(err));
    }
  };

  const onDelete = async () => {
    try {
      await remove.mutateAsync(video.id);
      toast.success(t.deleted, video.title);
      setConfirm(false);
      onClose();
      onDeleted();
    } catch (err) {
      toast.error('Could not delete the video', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-5" noValidate>
      <VideoFields
        value={fields}
        onChange={setFields}
        errors={errors}
        extra={
          askLength ? (
            <Field
              label={VIDEO_COPY.add.lengthLabel}
              optional
              htmlFor={`${uid}-len`}
              error={errors.length}
              hint={video.kind === 'link' ? VIDEO_COPY.add.lengthHint : VIDEO_COPY.edit.uploadLengthHint}
              className="sm:col-span-2"
            >
              <Input id={`${uid}-len`} value={length} inputMode="numeric" placeholder="9:58" onChange={(e) => setLength(e.target.value)} invalid={!!errors.length} className="max-w-40" />
            </Field>
          ) : null
        }
      />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" className="text-danger! hover:bg-danger-soft" onClick={() => setConfirm(true)} leftIcon={<Trash2 aria-hidden />}>
          {t.delete}
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={update.isPending}>
            {t.save}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void onDelete()}
        title={t.deleteTitle(video.title)}
        description={t.deleteBody}
        confirmLabel={t.delete}
        tone="danger"
        loading={remove.isPending}
      />
    </form>
  );
}
