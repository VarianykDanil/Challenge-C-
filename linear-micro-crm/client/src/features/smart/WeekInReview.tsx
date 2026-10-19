// "Your week in review" dashboard card — OWNED BY p9-week-in-review-digest.
// Mounted for every role after the team / events / announcements row, inside an ErrorBoundary, and loaded on demand
// (LazyWeekInReview in ./lazy.tsx). Reads useDigest(week) itself and keeps the week in local state: the default is the
// last completed week; ‹ goes back a week, › forward, and › is disabled on the latest finished week (a week that has not
// finished yet has no review). Private lines (pay, payroll, the check-in count) carry a lock and are never copied.
// 'Copy as text' puts the shareable plain text (the server's `text`) on the clipboard for WhatsApp: the Clipboard API
// where the page is a secure context, otherwise (plain http over the hotspot) a hidden textarea + execCommand('copy');
// if both fail, the text is shown selected so it can be copied by hand. Renders nothing with LM_SMART=0 (no bullets).
import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Lock, RotateCw, ScrollText, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import { addDays, type WeekDigest } from '@lm/shared';
import { useDigest } from '@/api/hooks';
import { Button, Card, Skeleton, useToast } from '@/components/ui';

export interface WeekInReviewProps {
  className?: string;
}

/** The server refuses weeks before 2020 (MIN_RANGE_DATE), so ‹ stops at the first Monday of 2020. */
const FIRST_MONDAY = '2020-01-06';
const COPIED_TOAST = 'Copied — paste it into WhatsApp';

/** Copy through a hidden textarea and execCommand('copy'): works on plain http, where navigator.clipboard is missing. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // no keyboard on phones
  ta.setAttribute('aria-hidden', 'true');
  // 16 px stops iOS zooming in; off-screen but still selectable
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '-9999px', width: '1px', height: '1px', opacity: '0', fontSize: '16px', border: '0', padding: '0' });
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    if (saved && selection) {
      selection.removeAllRanges();
      selection.addRange(saved);
    }
    active?.focus?.({ preventScroll: true });
  }
  return ok;
}

/** navigator.clipboard.writeText when available (secure contexts), else the textarea fallback. True when copied. */
async function copyText(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip && typeof clip.writeText === 'function' && (typeof window === 'undefined' || window.isSecureContext !== false)) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // permission denied or not focused: fall through to the textarea
    }
  }
  return legacyCopy(text);
}

export function WeekInReview({ className }: WeekInReviewProps) {
  const headingId = useId();
  const toast = useToast();
  // undefined = the default (last completed) week, so the first request is the plain cached GET /me/digest
  const [week, setWeek] = useState<string | undefined>(undefined);
  const latestQ = useDigest();
  const q = useDigest(week);
  const latest = latestQ.data?.weekStart;
  // keep the last digest on screen (dimmed) while another week loads, so the card does not jump
  const lastShown = useRef<WeekDigest | undefined>(undefined);
  if (q.data) lastShown.current = q.data;
  const d = q.data ?? lastShown.current;
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    if (manual !== null) manualRef.current?.select();
  }, [manual]);

  if (!d) {
    if (q.isError) {
      return (
        <div role="alert" className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface px-4 py-2 text-sm text-muted shadow-card', className)}>
          <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">Could not load your week in review.</span>
          <button type="button" onClick={() => void q.refetch()} className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 font-semibold text-primary hover:bg-surface-2">
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
        </div>
      );
    }
    return (
      <Card className={className} aria-hidden>
        <Skeleton className="h-5 w-64 max-w-full" />
        <Skeleton className="mt-5" lines={5} />
      </Card>
    );
  }

  // LM_SMART=0: the server answers the title with no bullets — the card stays away
  if (d.bullets.length === 0) return null;

  const loading = q.isFetching && !q.data;
  const prevWeek = addDays(d.weekStart, -7);
  const nextWeek = addDays(d.weekStart, 7);
  const canPrev = prevWeek >= FIRST_MONDAY && !loading;
  const canNext = latest !== undefined && d.weekStart < latest && !loading;
  const goTo = (monday: string) => {
    setManual(null);
    setCopied(false);
    setWeek(latest !== undefined && monday >= latest ? undefined : monday);
  };
  const [lead, weekLabel] = splitTitle(d.title);
  const hasPrivate = d.bullets.some((b) => b.private);

  const onCopy = async () => {
    if (!d.text) return;
    if (await copyText(d.text)) {
      setManual(null);
      setCopied(true);
      toast.success(COPIED_TOAST);
    } else {
      setManual(d.text);
      toast.error('Could not copy', 'The text is selected below — copy it from there.');
    }
  };

  return (
    <Card className={clsx('min-w-0', className)} data-testid="week-in-review">
      <section aria-labelledby={headingId} aria-busy={loading || undefined}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
              <ScrollText className="h-4 w-4" />
            </span>
            <h3 id={headingId} className="min-w-0 pt-1.5 font-sans text-sm font-semibold leading-snug tracking-normal text-fg">
              {lead}
              {weekLabel && (
                <>
                  <span className="hidden sm:inline"> · </span>
                  <span className="sr-only sm:hidden"> · </span>
                  <span className="block font-medium text-muted sm:inline sm:font-semibold sm:text-fg">{weekLabel}</span>
                </>
              )}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Choose the week">
            <Button variant="ghost" size="icon" label="Previous week" onClick={() => goTo(prevWeek)} disabled={!canPrev}>
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              label={canNext ? 'Next week' : 'Next week (not finished yet)'}
              onClick={() => goTo(nextWeek)}
              disabled={!canNext}
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>

        <ul className={clsx('max-w-3xl space-y-2.5 transition-opacity', loading && 'opacity-60')}>
          {d.bullets.map((b, i) => (
            <li key={`${d.weekStart}-${i}`} className={clsx('flex items-start gap-2.5 text-sm leading-relaxed', b.private ? 'text-muted' : 'text-fg')}>
              {b.private ? (
                <Lock className="mt-[5px] h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
              ) : (
                <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              )}
              <span className="min-w-0">
                {b.private && <span className="sr-only">Private: </span>}
                {b.text}
              </span>
            </li>
          ))}
        </ul>

        {manual !== null && (
          <label className="mt-4 block max-w-3xl">
            <span className="mb-1 block text-xs text-muted">Copy this text and paste it into WhatsApp</span>
            <textarea
              ref={manualRef}
              readOnly
              value={manual}
              rows={Math.min(9, manual.split('\n').length)}
              onFocus={(e) => e.currentTarget.select()}
              className="focus-ring w-full resize-none rounded-lg border border-border bg-surface-2 p-3 font-sans text-[16px] leading-relaxed text-fg sm:text-sm"
            />
          </label>
        )}

        <div className="-mx-5 -mb-5 mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-b-xl border-t border-border bg-surface-2/60 px-5 py-3">
          <p className="flex min-w-0 items-start gap-1.5 text-xs leading-relaxed text-muted">
            {hasPrivate ? (
              <>
                <Lock className="mt-[3px] h-3 w-3 shrink-0" aria-hidden />
                <span>Lines with a lock are private to you and are never copied.</span>
              </>
            ) : (
              <span>Plain text, ready for the team chat.</span>
            )}
          </p>
          <Button
            variant="outline"
            onClick={() => void onCopy()}
            disabled={!d.text || loading}
            leftIcon={copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
            className="w-full sm:w-auto"
          >
            {copied ? 'Copied' : 'Copy as text'}
          </Button>
        </div>
      </section>
    </Card>
  );
}

/** "Your week in review · w/c 12 Oct" → ["Your week in review", "w/c 12 Oct"] (the week wraps under it on phones). */
function splitTitle(title: string): [string, string | null] {
  const i = title.lastIndexOf(' · ');
  return i < 0 ? [title, null] : [title.slice(0, i), title.slice(i + 3)];
}
