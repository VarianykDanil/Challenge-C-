// Release 1.3 — P5 learning-videos: Learning → Videos → Add video. Upload a file (MP4, WebM or MOV up to 2 GB,
// streamed to the server with a progress bar and Cancel upload) or paste a YouTube, Vimeo or Google Drive link (the
// player is recognised as you type). Either way: title, what it covers, topic, who it is for, required. After adding,
// the video's page opens (an upload's still and length are taken there, from the server's copy).
// While a video uploads, nothing cancels it without asking: Escape and Back ask "Stop the upload?" (Keep uploading /
// Stop the upload), closing or reloading the tab gets the browser's "Leave site?", Ctrl+K / ⌘K (the search, whose
// pages would close the form) waits until it has finished, and only Cancel upload stops it at once (useUploadGuard).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, FileVideo, Link2, Upload } from 'lucide-react';
import {
  VIDEO_FILE_EXTENSIONS,
  VIDEO_LIMITS,
  VIDEO_MAX_BYTES,
  VIDEO_MIME_TYPES,
  VIDEO_PROVIDER_LABELS,
  parseVideoLength,
  parseVideoLink,
} from '@lm/shared';
import { useAddVideoLink, useUploadVideo, useVideoAccess, type UploadProgress } from '@/api/videos';
import { Button, Field, Input, Modal, ProgressBar, SegmentedControl, useToast } from '@/components/ui';
import { errorMessage } from '@/features/common';
import { VideoFields, emptyVideoFields, validateVideoFields, type VideoFieldErrors, type VideoFieldValues } from './VideoFields';
import { useUploadGuard } from './useUploadGuard';
import { VIDEO_COPY, formatBytes } from './videoCopy';

type Mode = 'upload' | 'link';

const ACCEPT = [...VIDEO_MIME_TYPES, ...Object.keys(VIDEO_FILE_EXTENSIONS).map((e) => `.${e}`)].join(',');

/** "IMG_0042 team talk.mov" → "IMG 0042 team talk". */
const titleFromFile = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VIDEO_LIMITS.titleMax);

/** What is wrong with a chosen file, or null. `room`: the bytes the server's disk has for an upload (unknown: null). */
function fileProblem(file: File, room: number | null | undefined): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!(ext in VIDEO_FILE_EXTENSIONS) && !(VIDEO_MIME_TYPES as readonly string[]).includes(file.type)) return 'Choose an MP4, WebM or MOV video';
  if (file.size === 0) return 'That file is empty';
  if (file.size > VIDEO_MAX_BYTES) return `That file is ${formatBytes(file.size)}: videos can be up to 2 GB`;
  if (typeof room === 'number' && file.size > room) return VIDEO_COPY.add.noRoom(formatBytes(room), formatBytes(file.size));
  return null;
}

export function AddVideoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  // Escape while a video uploads asks first (closing would cancel the upload); the backdrop and the X do nothing then
  const [askStop, setAskStop] = useState<'close' | 'back' | null>(null);
  const close = useCallback(() => (busy ? setAskStop((a) => a ?? 'close') : onClose()), [busy, onClose]);
  const onBusy = useCallback((b: boolean) => {
    setBusy(b);
    if (!b) setAskStop(null);
  }, []);
  return (
    <Modal open={open} onClose={close} title={VIDEO_COPY.add.title} description={VIDEO_COPY.add.description} size="lg" persistent={busy} hideClose={busy}>
      {open && <AddVideoForm onClose={onClose} onBusy={onBusy} askStop={askStop} onAskStop={setAskStop} />}
    </Modal>
  );
}

interface AddVideoFormProps {
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  /** "Stop the upload?" is showing: after Escape ('close') or Back ('back'). */
  askStop: 'close' | 'back' | null;
  onAskStop: (ask: 'close' | 'back' | null) => void;
}

function AddVideoForm({ onClose, onBusy, askStop, onAskStop }: AddVideoFormProps) {
  const t = VIDEO_COPY.add;
  const uid = useId();
  const toast = useToast();
  const navigate = useNavigate();
  const addLink = useAddVideoLink();
  const upload = useUploadVideo();
  const room = useVideoAccess().data?.uploadRoomBytes;
  const [mode, setMode] = useState<Mode>('upload');
  const [fields, setFields] = useState<VideoFieldValues>(emptyVideoFields);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [length, setLength] = useState('');
  const [errors, setErrors] = useState<VideoFieldErrors>({});
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** After "Stop the upload": close the form, or go back past the page (the Back that was asked about). */
  const afterStop = useRef<'close' | 'back' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const uploading = upload.isPending;
  const guard = useUploadGuard(uploading, () => onAskStop('back'));

  useEffect(() => onBusy(uploading), [uploading, onBusy]);
  // re-review fix: while it uploads, Ctrl+K / ⌘K does not open the search over the form (a page chosen there would
  // close the form and cancel the upload): the key is caught before the top bar's own listener hears it
  useEffect(() => {
    if (!uploading) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        toast.info(t.searchWaits);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [uploading, toast, t.searchWaits]);
  // the form going away some other way cancels the upload too
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (askStop) keepRef.current?.focus();
  }, [askStop]);

  const stopUpload = () => {
    afterStop.current = askStop;
    onAskStop(null);
    abortRef.current?.abort();
  };

  const link = url.trim() ? parseVideoLink(url) : null;

  const pickFile = (f: File | null) => {
    setFile(f);
    setErrors((e) => ({ ...e, file: f ? (fileProblem(f, room) ?? undefined) : undefined }));
    if (f && !fields.title.trim()) setFields((v) => ({ ...v, title: titleFromFile(f.name) }));
  };

  const submit = async () => {
    const e: VideoFieldErrors = validateVideoFields(fields);
    if (mode === 'upload') {
      if (!file) e.file = 'Choose a video file';
      else {
        const problem = fileProblem(file, room);
        if (problem) e.file = problem;
      }
    } else {
      if (!url.trim()) e.url = 'Paste the link';
      else if (!link) e.url = t.linkBad;
      const parsed = parseVideoLength(length);
      if (parsed !== null && Number.isNaN(parsed)) e.length = t.lengthBad;
    }
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    try {
      const base = { title: fields.title.trim(), description: fields.description.trim(), topic: fields.topic, audience: fields.audience, required: fields.required };
      let id: number;
      if (mode === 'upload' && file) {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setProgress({ loaded: 0, total: file.size });
        const v = await upload.mutateAsync({ input: { ...base, file, durationS: null, poster: null }, onProgress: setProgress, signal: ctrl.signal });
        id = v.id;
      } else {
        const v = await addLink.mutateAsync({ ...base, url: url.trim(), durationS: parseVideoLength(length) });
        id = v.id;
      }
      toast.success(t.added, base.title);
      // over the upload's copy of this page (useUploadGuard), so Back from the video goes to where you were
      const replace = guard.replaceNext();
      onClose();
      navigate(`/learning/videos/${id}`, { replace });
    } catch (err) {
      setProgress(null);
      const then = afterStop.current;
      afterStop.current = null;
      if (then === 'back') guard.leave();
      else guard.drop();
      if (err instanceof DOMException && err.name === 'AbortError') {
        toast.info(t.cancelled);
        if (then === 'close') onClose();
        return;
      }
      toast.error('Could not add the video', errorMessage(err));
    }
  };

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-5" noValidate>
      <SegmentedControl<Mode>
        aria-label="How to add it"
        fullWidth
        value={mode}
        onChange={(m) => {
          setMode(m);
          setErrors({});
        }}
        options={[
          { value: 'upload', label: t.upload, icon: <Upload />, disabled: uploading },
          { value: 'link', label: t.link, icon: <Link2 />, disabled: uploading },
        ]}
      />

      {mode === 'upload' ? (
        <Field label="Video file" required as="div" error={errors.file} hint={file ? undefined : t.fileHint}>
          <div
            className="flex flex-col gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2/40 p-4 sm:flex-row sm:items-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!uploading) pickFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
              <FileVideo className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1 text-sm">
              {file ? (
                <>
                  <span className="block truncate font-medium text-fg" data-testid="video-file-name">{file.name}</span>
                  <span className="block text-xs text-muted">{formatBytes(file.size)}</span>
                </>
              ) : (
                <span className="text-muted">No file chosen yet. You can also drop one here.</span>
              )}
            </span>
            <input
              ref={fileInput}
              id={`${uid}-file`}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
            />
            <Button type="button" variant="outline" className="shrink-0" onClick={() => fileInput.current?.click()} disabled={uploading} leftIcon={<Upload aria-hidden />}>
              {file ? t.chooseAgain : t.choose}
            </Button>
          </div>
        </Field>
      ) : (
        <Field label={t.linkLabel} required htmlFor={`${uid}-url`} error={errors.url} hint={link ? undefined : t.linkHint}>
          <Input
            id={`${uid}-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            value={url}
            maxLength={VIDEO_LIMITS.urlMax}
            onChange={(e) => {
              setUrl(e.target.value);
              if (errors.url) setErrors((x) => ({ ...x, url: undefined }));
            }}
            placeholder={t.linkPlaceholder}
            invalid={!!errors.url}
            rightIcon={link ? <CheckCircle2 className="text-success" /> : undefined}
          />
          {link && (
            <span className="mt-1.5 block text-xs font-medium text-success" data-testid="video-link-provider">
              {VIDEO_PROVIDER_LABELS[link.provider]} video{link.provider === 'drive' ? ': progress is ticked by hand (Mark as watched)' : ''}
            </span>
          )}
        </Field>
      )}

      <VideoFields
        value={fields}
        onChange={setFields}
        errors={errors}
        disabled={uploading}
        extra={
          mode === 'link' ? (
            <Field label={t.lengthLabel} optional htmlFor={`${uid}-len`} error={errors.length} hint={t.lengthHint} className="sm:col-span-2">
              <Input id={`${uid}-len`} value={length} inputMode="numeric" placeholder="9:58" onChange={(e) => setLength(e.target.value)} invalid={!!errors.length} className="max-w-40" />
            </Field>
          ) : null
        }
      />

      {uploading && progress && (
        <div className="rounded-xl border border-primary/20 bg-primary-soft p-3" aria-live="polite">
          <ProgressBar value={pct} max={100} showValue label={t.uploading} formatValue={() => `${pct}% · ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`} />
          <p className="mt-2 text-xs text-muted">Keep this page open until it finishes. Over a phone hotspot a big file takes a while.</p>
        </div>
      )}

      {uploading && askStop ? (
        <div role="alertdialog" aria-labelledby={`${uid}-stop`} aria-describedby={`${uid}-stop-body`} className="rounded-xl border border-warning/30 bg-warning-soft p-3" data-testid="video-stop-upload">
          <p id={`${uid}-stop`} className="text-sm font-semibold text-fg">{t.stopTitle}</p>
          <p id={`${uid}-stop-body`} className="mt-1 text-sm text-muted">
            {t.stopBody(progress ? formatBytes(progress.loaded) : '0 KB', progress ? formatBytes(progress.total) : formatBytes(file?.size ?? 0))}
          </p>
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="danger" onClick={stopUpload}>
              {t.stopUpload}
            </Button>
            <Button ref={keepRef} type="button" onClick={() => onAskStop(null)}>
              {t.keepUploading}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {uploading ? (
            <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
              {t.cancelUpload}
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={uploading || addLink.isPending} leftIcon={mode === 'upload' ? <Upload aria-hidden /> : <Link2 aria-hidden />}>
            {mode === 'upload' ? t.submitUpload : t.submitLink}
          </Button>
        </div>
      )}
    </form>
  );
}
