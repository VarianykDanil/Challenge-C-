import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import clsx from 'clsx';

export interface DropdownItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Secondary text on the right, e.g. a shortcut. */
  shortcut?: string;
  /** Render a tick when true (for choice menus). */
  checked?: boolean;
  /** Visual separator above this item. */
  separatorBefore?: boolean;
}

export interface DropdownProps {
  /** The element that opens the menu. It receives aria attributes and a click/keyboard handler. */
  trigger: ReactNode;
  items: DropdownItem[];
  /** Optional block rendered above the items (e.g. the signed-in user). */
  header?: ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  /** Width of the menu in px or a CSS width. */
  width?: number | string;
  className?: string;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Accessible dropdown menu: click/Enter/Space/ArrowDown opens, arrows move, Enter selects,
 * Escape and outside clicks close, focus returns to the trigger. Rendered in a portal so it
 * escapes `overflow` containers and sticky bars.
 */
export function Dropdown({ trigger, items, header, align = 'end', side = 'bottom', width = 224, className, open: openProp, onOpenChange }: DropdownProps) {
  const id = useId();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => { setOpenState(v); onOpenChange?.(v); };

  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState<number>(-1);
  const enabledIdx = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const place = () => {
    const t = triggerRef.current?.firstElementChild as HTMLElement | null;
    const m = menuRef.current;
    if (!t || !m) return;
    const r = t.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    const gap = 6;
    let left = align === 'end' ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    let top = side === 'bottom' ? r.bottom + gap : r.top - mh - gap;
    if (side === 'bottom' && top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - gap);
    if (side === 'top' && top < 8) top = r.bottom + gap;
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setActive(enabledIdx[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => place();
    document.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) (triggerRef.current?.firstElementChild as HTMLElement | null)?.focus();
  };

  const select = (it: DropdownItem) => {
    if (it.disabled) return;
    close();
    it.onSelect?.();
  };

  const move = (dir: 1 | -1) => {
    if (enabledIdx.length === 0) return;
    const cur = enabledIdx.indexOf(active);
    const next = cur < 0 ? 0 : (cur + dir + enabledIdx.length) % enabledIdx.length;
    setActive(enabledIdx[next]!);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); setActive(enabledIdx[0] ?? -1); break;
      case 'End': e.preventDefault(); setActive(enabledIdx[enabledIdx.length - 1] ?? -1); break;
      case 'Escape': e.preventDefault(); close(); break;
      case 'Tab': close(false); break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const it = items[active];
        if (it) select(it);
        break;
      }
    }
  };

  return (
    <>
      <div
        ref={triggerRef}
        className={clsx('inline-flex', className)}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
      >
        {trigger}
      </div>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-orientation="vertical"
          onKeyDown={onMenuKey}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed z-[70] animate-scale-in overflow-hidden rounded-xl border border-border bg-surface p-1 text-sm shadow-pop outline-none"
        >
          {header && <div className="border-b border-border px-3 py-2.5">{header}</div>}
          {items.map((it, i) => (
            <div key={i}>
              {it.separatorBefore && <div role="separator" className="my-1 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                data-index={i}
                tabIndex={-1}
                disabled={it.disabled}
                aria-disabled={it.disabled || undefined}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => select(it)}
                className={clsx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-100 disabled:opacity-40',
                  it.tone === 'danger' ? 'text-danger' : 'text-fg',
                  active === i && (it.tone === 'danger' ? 'bg-danger-soft' : 'bg-surface-2'),
                )}
              >
                {it.icon && <span className={clsx('inline-flex shrink-0 [&_svg]:h-4 [&_svg]:w-4', it.tone === 'danger' ? 'text-danger' : 'text-muted')} aria-hidden>{it.icon}</span>}
                <span className="flex-1 truncate">{it.label}</span>
                {it.shortcut && <kbd className="ml-2 font-sans text-[11px] text-subtle">{it.shortcut}</kbd>}
                {it.checked && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Alias so teammates can import either name. */
export const Menu = Dropdown;
export type MenuProps = DropdownProps;
export type MenuItem = DropdownItem;
