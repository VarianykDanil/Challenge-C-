// "Sign-in details" for a one-time setup code an administrator just made: after Give a setup code, a two-step or PIN
// reset, or (client accounts) a reset on the campaign page. The code is shown only here, once: the admin copies it or
// reads it out. It closes only with Done, the X or Escape, never with a stray tap beside it.
import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { ACCESS_MESSAGES, setupCodeExpiryText } from '@lm/shared';
import { Button, Modal } from '@/components/ui';
import { copyText } from '@/lib/clipboard';

export interface SetupCodeDialogProps {
  /** Full name, and the first name for the message. */
  name: string;
  firstName: string;
  email: string;
  /** "Employee ID" (staff) or "Access code" (client accounts), and its value. */
  idLabel: string;
  idValue: string;
  setupCode: string | null;
  expiresAt?: string | null;
  /** The code was made but not shown (insecure connection from another device). */
  withheld?: boolean;
  /** What happened, in one sentence ("Two-step verification is reset."). */
  intro: string;
  /** What they do after the code ("set up two-step verification again"). */
  next: string;
  onClose: () => void;
}

/** The message to send them: email, ID, the code and when it stops working. */
export function setupCodeMessage(p: Pick<SetupCodeDialogProps, 'firstName' | 'email' | 'idLabel' | 'idValue' | 'setupCode' | 'expiresAt' | 'next'>): string {
  const until = p.expiresAt ? setupCodeExpiryText(p.expiresAt).replace(/^Valid until /, '') : '';
  return [
    `Hello ${p.firstName.trim() || 'there'},`,
    '',
    `Sign in to Linear Hub with your email (${p.email}), your ${p.idLabel.toLowerCase()} (${p.idValue}) and this one-time setup code: ${p.setupCode}.`,
    `It works once${until ? `, until ${until}` : ''}. Then ${p.next}.`,
    '',
    'Keep the code to yourself.',
  ].join('\n');
}

export function SetupCodeDialog(p: SetupCodeDialogProps) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const textRef = useRef<HTMLPreElement>(null);
  const message = p.setupCode ? setupCodeMessage(p) : '';

  async function copy() {
    if (await copyText(message)) {
      setCopied('yes');
      return;
    }
    const el = textRef.current;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setCopied('failed');
  }

  return (
    <Modal
      open
      onClose={p.onClose}
      persistent
      title="Sign-in details"
      description={`${p.intro} ${p.setupCode ? 'This is the only time you see this setup code: give it to them in person, by phone or in a private message.' : ''}`.trim()}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={p.onClose}>Done</Button>
          {p.setupCode && (
            <Button onClick={() => void copy()} leftIcon={copied === 'yes' ? <Check aria-hidden /> : <Copy aria-hidden />} className="sm:min-w-[11.5rem]">
              {copied === 'yes' ? 'Copied' : 'Copy message'}
            </Button>
          )}
        </>
      }
    >
      <dl className="grid gap-3 rounded-lg border border-border bg-surface-2 p-3 text-sm sm:grid-cols-2" data-testid="setup-code-details">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Name</dt>
          <dd className="mt-0.5 truncate font-medium text-fg">{p.name}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">{p.idLabel}</dt>
          <dd className="mt-0.5 font-mono font-medium text-fg">{p.idValue}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-muted">Email</dt>
          <dd className="mt-0.5 break-all font-medium text-fg">{p.email}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted">One-time setup code</dt>
          {p.setupCode ? (
            <>
              <dd className="mt-0.5 break-all font-mono text-2xl font-bold tracking-widest text-fg" data-testid="setup-code">{p.setupCode}</dd>
              {p.expiresAt && <dd className="mt-0.5 text-xs text-muted">{setupCodeExpiryText(p.expiresAt)}. It works once.</dd>}
            </>
          ) : (
            <dd className="mt-0.5 text-sm text-warning" data-testid="setup-code-withheld">{ACCESS_MESSAGES.setupCodeWithheld}</dd>
          )}
        </div>
      </dl>
      {message && (
        <pre ref={textRef} className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-sans text-sm text-fg" data-testid="setup-code-message">
          {message}
        </pre>
      )}
      <p role="status" className={copied === 'failed' ? 'mt-2 text-sm text-danger' : 'mt-2 text-sm text-muted'}>
        {copied === 'yes' && `Copied. Send it to ${p.firstName.trim() || 'them'} privately.`}
        {copied === 'failed' && 'Could not copy. The message is selected above: copy it from there.'}
      </p>
    </Modal>
  );
}
