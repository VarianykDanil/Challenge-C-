// Release 1.3 — OWNED BY P7 recruitment-plus. The gentle check under a question being written (the question bank and
// the sheet's own questions): a protected topic is named (shared questionTopicWarning), the question is never blocked.
import { AlertTriangle } from 'lucide-react';
import { questionTopicWarning } from '@lm/shared';

export function QuestionTopicHint({ text }: { text: string }) {
  const topic = text.trim().length >= 5 ? questionTopicWarning(text) : null;
  if (!topic) return null;
  return (
    <p className="-mt-1.5 flex items-start gap-1.5 text-xs text-warning" role="status">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>This looks like a question about {topic}. Interview questions must be about the job (Equality Act 2010), for example which days someone can work.</span>
    </p>
  );
}

