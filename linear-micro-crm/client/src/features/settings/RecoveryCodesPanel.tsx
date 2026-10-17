// The one-time reveal of recovery codes: shown after enabling two-step verification and after regenerating.
import { useId, useState } from 'react';
import { Check, Copy, Download, TriangleAlert } from 'lucide-react';
import { BRAND } from '@lm/shared';
import { Button, useToast } from '@/components/ui';
import { COPY } from '@/content/copy';
import { copyToClipboard, downloadTextFile } from '@/lib/files';
import { formatDateTime } from '@/lib/format';

export const RECOVERY_CODES_FILENAME = 'linear-hub-recovery-codes.txt';

/** Plain-text file body: a header people will recognise months later, then one code per line. */
export function recoveryCodesText(codes: string[], email?: string): string {
  const lines = [
    `${BRAND.product} — two-step verification recovery codes`,
    email ? `Account: ${email}` : null,
    `Generated: ${formatDateTime(new Date().toISOString())}`,
    '',
    ...codes,
    '',
    COPY.security.recovery.warning,
  ];
  return `${lines.filter((l) => l !== null).join('\n')}\n`;
}

export interface RecoveryCodesPanelProps {
  codes: string[];
  /** Printed in the downloaded file so the owner knows which account it belongs to. */
  email?: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}

export function RecoveryCodesPanel({ codes, email, saved, onSavedChange }: RecoveryCodesPanelProps) {
  const toast = useToast();
  const uid = useId();
  const [copied, setCopied] = useState(false);
  const t = COPY.security.recovery;

  async function copyAll() {
    const ok = await copyToClipboard(codes.join('\n'));
    if (ok) {
      setCopied(true);
      toast.success(t.copied);
      window.setTimeout(() => setCopied(false), 2_000);
    } else {
      toast.error('Could not copy', 'Select the codes and copy them yourself, or download the file.');
    }
  }

  return (
    <div className="space-y-4" data-testid="recovery-codes">
      <div role="note" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <p className="text-fg">{t.warning}</p>
      </div>

      <ol className="grid grid-cols-2 gap-2" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code} className="select-all rounded-lg border border-border bg-surface-2 px-3 py-2 text-center font-mono text-sm tracking-[0.12em] text-fg tabular">
            {code}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copyAll()} leftIcon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}>
          {copied ? 'Copied' : t.copyAll}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => downloadTextFile(RECOVERY_CODES_FILENAME, recoveryCodesText(codes, email))} leftIcon={<Download aria-hidden />}>
          {t.download}
        </Button>
      </div>

      <label htmlFor={`${uid}-saved`} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm transition-colors hover:bg-surface-2">
        <input
          id={`${uid}-saved`}
          type="checkbox"
          className="focus-ring mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded accent-primary"
          checked={saved}
          onChange={(e) => onSavedChange(e.target.checked)}
        />
        <span className="font-medium text-fg">{t.saved}</span>
      </label>
    </div>
  );
}
