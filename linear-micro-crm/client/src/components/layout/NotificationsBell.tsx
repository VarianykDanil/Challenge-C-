// The topbar bell — OWNED BY p5-needs-attention-feed.
// It polls the role-scoped Needs-attention feed (useAttention({ poll: true }): every 60 s while the tab is visible,
// plus on focus and reconnect) and drives four things from it:
//  - the unread count on the bell: items whose token is not in this device's seen set (lib/attentionSeen);
//  - the panel: items grouped by kind, each a link with its action label; opening it marks what it shows as seen;
//  - toasts for new items: at most 1 from the first fetch after a page load, at most 3 from each later one, never
//    for info items except "you've been paid", never while a dialog is open (those wait in the bell), and never
//    twice for the same item on this device (the toasted set survives reloads);
//  - the tab title badge, "(2) Dashboard · Linear Hub".
// No Notification API or Web Push: both need HTTPS and the hotspot serves plain http.
// Contract kept from p1: the export name and the props (Topbar passes them through); the trigger stays a 40 px button.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Bell, CircleCheck, Info, RotateCw, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { AttentionItem, AttentionKind } from '@lm/shared';
import { useAttention } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { AttentionRow, attentionCheckedAt } from '@/features/smart/AttentionRow';
import {
  ATTENTION_TOASTS_FIRST,
  ATTENTION_TOASTS_LATER,
  addToAttentionSet,
  attentionStoreKey,
  attentionToken,
  isDialogOpen,
  pickAttentionToasts,
  readAttentionSet,
  touchAttentionSet,
  unreadAttention,
} from '@/lib/attentionSeen';
import { setTitleBadge } from '@/lib/usePageTitle';

export interface NotificationsBellProps {
  /** Force the unread dot on (the bell already shows its own unread count). */
  hasNotifications?: boolean;
  /** Called when the panel opens. */
  onNotifications?: () => void;
}

const KIND_LABELS: Record<AttentionKind, string> = {
  pay: 'Your pay',
  gauges: 'Gauges',
  events: 'Events',
  payroll: 'Payroll',
  recruitment: 'Recruitment',
  security: 'Security',
  // Release 1.3 (r3-foundation): the kinds the packages' attention providers add (P2, P3, P6).
  invoices: 'Invoices',
  statements: 'Statements',
  client: 'Client updates',
  // Release 1.4 (F)
  payments: 'Payments',
  system: 'System health',
};

/** Groups in the order their first (most severe, newest) item appears in the sorted feed. */
function groupByKind(items: ReadonlyArray<AttentionItem>): { kind: AttentionKind; items: AttentionItem[] }[] {
  const groups = new Map<AttentionKind, AttentionItem[]>();
  for (const item of items) {
    const list = groups.get(item.kind);
    if (list) list.push(item);
    else groups.set(item.kind, [item]);
  }
  return [...groups].map(([kind, list]) => ({ kind, items: list }));
}

/** Users whose first feed after this page load has already been considered for toasts (module scope = page load). */
const firstFetchDone = new Set<number>();

const TOAST_MS = 9000;

export function NotificationsBell({ hasNotifications = false, onNotifications }: NotificationsBellProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const toaster = useToast();
  const q = useAttention({ poll: true });
  const feed = q.data;
  const disabled = Boolean(feed?.disabled);
  const items = useMemo(() => (feed && !feed.disabled ? feed.items : []), [feed]);

  // the seen set (per device and person); re-read when the person changes or another tab marks items seen
  const [seen, setSeen] = useState<Set<string>>(() => (userId === null ? new Set() : readAttentionSet('seen', userId)));
  useEffect(() => {
    if (userId === null) return;
    setSeen(readAttentionSet('seen', userId));
    const key = attentionStoreKey('seen', userId);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setSeen(readAttentionSet('seen', userId));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  const markSeen = useCallback(
    (list: ReadonlyArray<AttentionItem>) => {
      if (userId === null || !list.length) return;
      setSeen(addToAttentionSet('seen', userId, list));
    },
    [userId],
  );

  const unread = useMemo(() => unreadAttention(items, seen), [items, seen]);
  const unreadDanger = unread.some((i) => i.severity === 'danger');

  // tab title badge: the same number as the bell
  useEffect(() => {
    setTitleBadge(unread.length);
  }, [unread.length]);
  useEffect(() => () => setTitleBadge(0), []);

  // ── toasts: once per fetch (dataUpdatedAt moves on every successful fetch, even when nothing changed)
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const markSeenRef = useRef(markSeen);
  markSeenRef.current = markSeen;
  useEffect(() => {
    if (userId === null || !feed || feed.disabled) return;
    // keep what is still in the feed at the newest end of both sets, so a long-lived item is never evicted and re-shown
    touchAttentionSet('seen', userId, feed.items);
    touchAttentionSet('toasted', userId, feed.items);
    const first = !firstFetchDone.has(userId);
    firstFetchDone.add(userId);
    const { show, fresh } = pickAttentionToasts(feed.items, {
      seen: readAttentionSet('seen', userId),
      toasted: readAttentionSet('toasted', userId),
      limit: first ? ATTENTION_TOASTS_FIRST : ATTENTION_TOASTS_LATER,
      blocked: isDialogOpen(),
    });
    if (!fresh.length) return;
    addToAttentionSet('toasted', userId, fresh);
    for (const item of show) {
      toaster.toast({
        title: item.title,
        description: item.body,
        tone: item.key.startsWith('pay:paid:') ? 'success' : item.severity === 'danger' ? 'error' : item.severity === 'warning' ? 'warning' : 'info',
        duration: TOAST_MS,
        action: {
          label: item.actionLabel ?? 'Open',
          onClick: () => {
            markSeenRef.current([item]);
            navigateRef.current(item.href);
          },
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per fetch, keyed on the fetch time
  }, [q.dataUpdatedAt, userId]);

  // ── the panel
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const t = triggerRef.current;
    const p = panelRef.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    const w = p.offsetWidth;
    const gutter = 16;
    const left = Math.max(gutter, Math.min(r.right - w, window.innerWidth - w - gutter));
    setPos({ top: r.bottom + 6, left });
  }, []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setFresh(new Set());
    if (refocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    panelRef.current?.focus({ preventScroll: true });
  }, [open, place]);

  // whatever the open panel shows is seen; items that arrive while it is open are shown, so they are seen too
  useEffect(() => {
    if (!open) return;
    const newOnes = unreadAttention(items, seen);
    if (!newOnes.length) return;
    setFresh((prev) => new Set([...prev, ...newOnes.map(attentionToken)]));
    markSeen(newOnes);
  }, [open, items, seen, markSeen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, close, place]);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    setOpen(true);
    onNotifications?.();
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    }
  };

  const count = unread.length;
  const showDot = count > 0 || hasNotifications;
  const label = count > 0 ? `Notifications, ${count} new` : 'Notifications';
  const checked = attentionCheckedAt(feed?.generatedAt);
  const groups = useMemo(() => groupByKind(items), [items]);

  let status: string;
  if (disabled) status = 'Smart notices are switched off on this server.';
  else if (!feed) status = q.isError ? 'Could not check just now. It tries again every minute.' : 'Checking…';
  else if (!items.length) status = 'You’re all caught up.';
  else status = `${items.length} ${items.length === 1 ? 'thing' : 'things'} to look at${checked ? ` · checked ${checked}` : ''}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-attention-bell
        data-unread={count}
        className="focus-ring relative inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Bell className="h-[18px] w-[18px]" aria-hidden />
        {showDot && count === 0 && (
          <span className="absolute right-2.5 top-2.5 flex h-2 w-2" aria-hidden>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent ring-2 ring-topbar" />
          </span>
        )}
        {count > 0 && (
          <span className="absolute right-0.5 top-0.5 flex" aria-hidden>
            <span className={clsx('absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden', unreadDanger ? 'bg-danger' : 'bg-accent')} />
            <span
              className={clsx(
                'relative inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none tabular-nums ring-2 ring-topbar',
                unreadDanger ? 'bg-danger text-status-fg' : 'bg-accent text-accent-fg',
              )}
            >
              {count > 9 ? '9+' : count}
            </span>
          </span>
        )}
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Needs attention"
            tabIndex={-1}
            onKeyDown={onPanelKey}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next && !e.currentTarget.contains(next) && !triggerRef.current?.contains(next)) close(false);
            }}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="fixed z-[70] flex max-h-[min(70dvh,560px)] w-[min(380px,calc(100vw-32px))] animate-scale-in flex-col overflow-hidden rounded-xl border border-border bg-surface text-sm shadow-pop outline-none"
            data-attention-panel
          >
            <div className="border-b border-border px-4 py-3">
              <div className="text-sm font-semibold text-fg">Needs attention</div>
              <div className="mt-0.5 text-xs text-muted" aria-live="polite">{status}</div>
            </div>
            {items.length > 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin">
                {groups.map((g) => (
                  <section key={g.kind} aria-label={KIND_LABELS[g.kind]} className="py-1">
                    <h4 className="eyebrow px-2.5 pb-1 pt-1.5 text-muted">{KIND_LABELS[g.kind]}</h4>
                    <ul>
                      {g.items.map((item) => (
                        <li key={item.key}>
                          <AttentionRow item={item} isNew={fresh.has(attentionToken(item))} onNavigate={() => close(false)} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : disabled ? (
              <div className="flex items-center gap-3 px-4 py-5 text-muted">
                <Info className="h-5 w-5 shrink-0" aria-hidden />
                <span>Nothing is checked while they are off.</span>
              </div>
            ) : !feed ? (
              // no answer yet: never the all-clear, which would be falsely reassuring
              q.isError ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-4 text-muted" data-attention-error>
                  <TriangleAlert className="h-5 w-5 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">Your list shows here once Linear Hub answers.</span>
                  {/* a retry with no data goes back to "pending", so the panel shows the placeholder while it runs */}
                  <button
                    type="button"
                    onClick={() => void q.refetch()}
                    className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 font-semibold text-primary hover:bg-surface-2"
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden />
                    Try again
                  </button>
                </div>
              ) : (
                <Skeleton lines={2} className="px-4 py-4" />
              )
            ) : (
              <div className="flex items-center gap-3 px-4 py-5 text-muted">
                <CircleCheck className="h-5 w-5 shrink-0 text-success" aria-hidden />
                <span>Nothing needs your attention right now.</span>
              </div>
            )}
            <div className="border-t border-border bg-surface-2/60 px-4 py-2 text-xs text-muted">Updates every minute while Linear Hub is open.</div>
          </div>,
          document.body,
        )}
    </>
  );
}
