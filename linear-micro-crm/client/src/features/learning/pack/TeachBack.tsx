// Release 1.2 — L1: "Teach it back": the person writes the theory in their own words, saved for their leader, who signs
// it off ("taught"). Only the person, their team leader and admins ever read it. Written after the self-check passes.
import { useEffect, useState } from 'react';
import { CheckCheck, Lock, MessageSquareQuote, Pencil, Send } from 'lucide-react';
import { LEARNING_LIMITS, type LessonProgress } from '@lm/shared';
import { useSubmitTeachback } from '@/api/learning';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, Field, Textarea, useToast } from '@/components/ui';
import { apiMessage } from '@/features/common';
import type { Lesson } from '@/content/learning';
import { formatDate } from '@/lib/format';
import { reviewerWord } from './reviewer';

export interface TeachBackProps {
  lesson: Lesson;
  progress: LessonProgress | undefined;
}

export function TeachBack({ lesson, progress }: TeachBackProps) {
  const toast = useToast();
  const submit = useSubmitTeachback();
  const who = reviewerWord(useCurrentUser());
  const learned = Boolean(progress?.learnedAt);
  const sent = Boolean(progress?.teachbackAt);
  const signed = Boolean(progress?.taughtSignedOffAt);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(progress?.teachbackText ?? '');
  useEffect(() => {
    if (!editing) setText(progress?.teachbackText ?? '');
  }, [progress?.teachbackText, editing]);

  const trimmed = text.trim();
  const tooShort = trimmed.length < LEARNING_LIMITS.teachbackMinLength;
  const save = () =>
    submit.mutate(
      { lessonKey: lesson.key, text: trimmed },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success(`Sent to ${who}`, 'They sign it off from the Progress page.');
        },
        onError: (e) => toast.error('Could not send it', apiMessage(e, 'Try again in a moment.')),
      },
    );

  const title = lesson.task ? `Tell ${who} how it went` : 'Teach it back';
  return (
    <Card>
      <CardHeader icon={<MessageSquareQuote />} title={title} description={lesson.teachPrompt} />
      {!learned ? (
        <p className="flex items-start gap-2 rounded-lg bg-surface-2/70 p-3 text-sm text-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {lesson.task ? 'Tick it as done first, then write how it went.' : 'Pass the self-check first, then put it in your own words.'}
        </p>
      ) : sent && !editing ? (
        <div className="space-y-3">
          <blockquote className="whitespace-pre-line rounded-lg border-l-[3px] border-primary/60 bg-surface-2/60 px-3 py-2 text-sm leading-relaxed text-fg">{progress?.teachbackText}</blockquote>
          {signed ? (
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCheck className="h-4 w-4 shrink-0" aria-hidden />
              Signed off{progress?.taughtSignedOffByName ? ` by ${progress.taughtSignedOffByName}` : ''} on {formatDate(progress?.taughtSignedOffAt)}
            </p>
          ) : (
            <p className="text-sm text-muted">Sent {formatDate(progress?.teachbackAt)}. Waiting for {who} to sign it off.</p>
          )}
          <Button variant="outline" size="sm" leftIcon={<Pencil />} onClick={() => setEditing(true)}>
            Rewrite it
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {signed && !sent && (
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCheck className="h-4 w-4 shrink-0" aria-hidden />
              Already signed off in person{progress?.taughtSignedOffByName ? ` by ${progress.taughtSignedOffByName}` : ''}. You can still write it down.
            </p>
          )}
          <Field label="In your own words" hint={tooShort && trimmed.length > 0 ? `At least ${LEARNING_LIMITS.teachbackMinLength} characters.` : 'Your team leader and the office can read this; nobody else.'}>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={LEARNING_LIMITS.teachbackMaxLength}
              showCount
              placeholder={lesson.task ? 'What did you do, and how did it go?' : 'Explain it as if you were teaching a new starter…'}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button leftIcon={<Send />} onClick={save} disabled={tooShort} loading={submit.isPending}>
              {who === 'your leader' ? 'Send to my leader' : 'Send to the office'}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">Prefer to teach it at the whiteboard? It can be signed off in person too.</p>
        </div>
      )}
    </Card>
  );
}
