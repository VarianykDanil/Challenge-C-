// Settings on a phone was one very long page (14,000 px for the owner, twelve cards). Each card now sits in a named
// section, and "On this page" at the top lists the ones this person actually has, so one tap takes them there.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

/** One card of the Settings page, named for the "On this page" list. Renders nothing extra when the card is empty. */
export function SettingsSection({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} data-settings-section={title} className={clsx('scroll-mt-28 empty:hidden', className)}>
      {children}
    </section>
  );
}

interface Entry { id: string; title: string }

/** The sections on the page that have something in them, in page order; kept up to date as cards load. */
function useSections(root: React.RefObject<HTMLElement | null>): Entry[] {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    const scope = root.current?.parentElement ?? document.body;
    const read = () => {
      const next = Array.from(scope.querySelectorAll<HTMLElement>('[data-settings-section]'))
        .filter((el) => el.childElementCount > 0)
        .map((el) => ({ id: el.id, title: el.dataset.settingsSection ?? el.id }));
      setEntries((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i]!.id) ? prev : next));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(scope, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [root]);
  return entries;
}

/** "On this page": a tap goes to that card (phones and small tablets; the two-column desktop page shows them all). */
export function SettingsJumpMenu({ className }: { className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const entries = useSections(ref);
  return (
    <nav ref={ref} aria-label="Settings sections" className={clsx('rounded-xl border border-border bg-surface p-3 shadow-card', entries.length < 3 && 'hidden', className)}>
      <p className="px-1 text-xs font-semibold text-muted">On this page</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {entries.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              onClick={(ev) => {
                const el = document.getElementById(e.id);
                if (!el) return;
                ev.preventDefault();
                el.scrollIntoView({ block: 'start', behavior: 'smooth' });
                window.history.replaceState(window.history.state, '', `#${e.id}`);
              }}
              className="focus-ring inline-flex min-h-10 items-center rounded-full border border-border bg-surface-2 px-3 text-sm font-medium text-fg hover:border-primary/40 hover:text-primary"
            >
              {e.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
