// Release 1.3 — P5 learning-videos: the fields every video has (title, what it covers, topic, who it is for, required),
// shared by Add video and Edit video. Validation lives in validateVideoFields so both forms say the same.
import { useId } from 'react';
import {
  VIDEO_AUDIENCES,
  VIDEO_AUDIENCE_HINTS,
  VIDEO_AUDIENCE_LABELS,
  VIDEO_LIMITS,
  VIDEO_TOPICS,
  VIDEO_TOPIC_LABELS,
  type VideoAudience,
  type VideoTopic,
} from '@lm/shared';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui';
import clsx from 'clsx';
import { SWITCH_HIT_AREA, VIDEO_COPY } from './videoCopy';

export interface VideoFieldValues {
  title: string;
  description: string;
  topic: VideoTopic;
  audience: VideoAudience;
  required: boolean;
}

export type VideoFieldErrors = Partial<Record<keyof VideoFieldValues | 'url' | 'length' | 'file', string>>;

export const emptyVideoFields = (): VideoFieldValues => ({ title: '', description: '', topic: 'other', audience: 'everyone', required: false });

export function validateVideoFields(v: VideoFieldValues): VideoFieldErrors {
  const e: VideoFieldErrors = {};
  if (!v.title.trim()) e.title = 'Give the video a title';
  else if (v.title.trim().length > VIDEO_LIMITS.titleMax) e.title = `Up to ${VIDEO_LIMITS.titleMax} characters`;
  if (v.description.trim().length > VIDEO_LIMITS.descriptionMax) e.description = `Up to ${VIDEO_LIMITS.descriptionMax} characters`;
  return e;
}

export interface VideoFieldsProps {
  value: VideoFieldValues;
  onChange: (v: VideoFieldValues) => void;
  errors: VideoFieldErrors;
  disabled?: boolean;
  /** Something to show after the topic and audience (the link's length). */
  extra?: React.ReactNode;
}

export function VideoFields({ value, onChange, errors, disabled, extra }: VideoFieldsProps) {
  const uid = useId();
  const t = VIDEO_COPY.fields;
  const set = (patch: Partial<VideoFieldValues>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t.title} required htmlFor={`${uid}-title`} error={errors.title} className="sm:col-span-2">
        <Input id={`${uid}-title`} value={value.title} maxLength={VIDEO_LIMITS.titleMax} onChange={(e) => set({ title: e.target.value })} invalid={!!errors.title} disabled={disabled} autoComplete="off" />
      </Field>
      <Field label={t.description} optional htmlFor={`${uid}-desc`} error={errors.description} className="sm:col-span-2">
        <Textarea
          id={`${uid}-desc`}
          value={value.description}
          maxLength={VIDEO_LIMITS.descriptionMax}
          rows={3}
          placeholder={t.descriptionPlaceholder}
          onChange={(e) => set({ description: e.target.value })}
          invalid={!!errors.description}
          disabled={disabled}
        />
      </Field>
      <Field label={t.topic} htmlFor={`${uid}-topic`}>
        <Select
          id={`${uid}-topic`}
          value={value.topic}
          onChange={(e) => set({ topic: e.target.value as VideoTopic })}
          options={VIDEO_TOPICS.map((k) => ({ value: k, label: VIDEO_TOPIC_LABELS[k] }))}
          disabled={disabled}
        />
      </Field>
      <Field label={t.audience} htmlFor={`${uid}-aud`} hint={VIDEO_AUDIENCE_HINTS[value.audience]}>
        <Select
          id={`${uid}-aud`}
          value={value.audience}
          onChange={(e) => set({ audience: e.target.value as VideoAudience })}
          options={VIDEO_AUDIENCES.map((k) => ({ value: k, label: VIDEO_AUDIENCE_LABELS[k] }))}
          disabled={disabled}
        />
      </Field>
      {extra}
      <div className={clsx('rounded-lg border border-border bg-surface-2/50 p-3 sm:col-span-2', SWITCH_HIT_AREA)}>
        <Switch checked={value.required} onChange={(required) => set({ required })} label={t.required} description={t.requiredHint} disabled={disabled} />
      </div>
    </div>
  );
}
