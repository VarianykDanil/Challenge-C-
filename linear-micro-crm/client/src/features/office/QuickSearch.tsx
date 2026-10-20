// Release 1.2 — U5 office-tools. The topbar's ⌘K / Ctrl+K field: go to a page, run an action ("Log gauges",
// "New event", "Mark week paid") or open a person, event, candidate or campaign found by GET /search (role-scoped on
// the server; debounced here, cached for 20 s by TanStack Query). Keyboard: arrows move, Enter opens, Escape clears
// then closes. On phones it lives in the topbar's search popover (Topbar.tsx), with 44 px rows.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, Circle, Loader2, PlusCircle, Search, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { SEARCH_KINDS, SEARCH_KIND_LABELS, SEARCH_MIN_LENGTH, normaliseSearchQuery, type SearchResult, type UserWithTeam } from '@lm/shared';
import { useSearch } from '@/api/search';
import { NAV_ICONS } from '@/components/layout/Sidebar';
import type { NavItem } from '@/components/layout/nav';

const SECTION_LABELS: Record<NonNullable<NavItem['section']>, string> = { main: 'Workspace', manage: 'Manage', me: 'Account' };
const DEBOUNCE_MS = 200;

interface Option {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  to: string;
}

interface PaletteAction {
  label: string;
  to: string;
  icon: ReactNode;
  /** Extra words it answers to. */
  keywords: string;
  allowed: (u: UserWithTeam) => boolean;
}

const ICON = 'h-4 w-4 shrink-0 text-muted';
const ACTIONS: PaletteAction[] = [
  { label: 'Log gauges', to: '/gauges?log=1', icon: <PlusCircle className={ICON} aria-hidden />, keywords: 'record results shift numbers', allowed: (u) => u.role !== 'recruiter' },
  { label: 'New event', to: '/events?new=1', icon: <CalendarPlus className={ICON} aria-hidden />, keywords: 'create add pitch site booking', allowed: (u) => u.role === 'admin' || (u.role === 'leader' && u.teamId != null) },
  { label: 'Mark week paid', to: '/finance?tab=company#runs', icon: <Wallet className={ICON} aria-hidden />, keywords: 'payroll runs pay transfer export xero sage', allowed: (u) => u.role === 'admin' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ResultIcon({ r }: { r: SearchResult }) {
  if (r.color) return <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />;
  const name = r.kind === 'person' ? 'Users' : r.kind === 'event' ? 'CalendarDays' : r.kind === 'candidate' ? 'UserPlus' : 'Megaphone';
  const Icon = NAV_ICONS[name] ?? Circle;
  return <Icon className={ICON} aria-hidden />;
}

export interface QuickSearchProps {
  user: UserWithTeam;
  items: NavItem[];
  className?: string;
  /** Ref to the input so the topbar can focus it on ⌘K. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Focus the input on mount (popover mode). */
  autoFocus?: boolean;
  /** Render the result list in flow (inside a popover) instead of floating under the field. */
  embedded?: boolean;
  /** Called after something was chosen. */
  onNavigate?: () => void;
  /** Called on Escape with an empty query (popover mode closes and refocuses its button). */
  onDismiss?: () => void;
}

export function QuickSearch({ user, items, className, inputRef: inputRefProp, autoFocus, embedded, onNavigate, onDismiss }: QuickSearchProps) {
  const id = useId();
  const navigate = useNavigate();
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = inputRefProp ?? ownRef;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const q = query.trim().toLowerCase();
  const debounced = useDebounced(normaliseSearchQuery(query), DEBOUNCE_MS);
  const searching = normaliseSearchQuery(query).length >= SEARCH_MIN_LENGTH;
  const search = useSearch(debounced, { enabled: open && searching });

  const options = useMemo<Option[]>(() => {
    const words = q.split(/\s+/).filter(Boolean);
    const hit = (...fields: string[]) => words.every((w) => fields.some((f) => f.toLowerCase().includes(w)));
    const out: Option[] = [];
    for (const a of ACTIONS) {
      if (a.allowed(user) && (!q || hit(a.label, a.keywords))) out.push({ key: `action:${a.to}`, group: 'Actions', label: a.label, icon: a.icon, to: a.to });
    }
    for (const i of items) {
      if (q && !(hit(i.label) || i.to.slice(1).startsWith(q))) continue;
      const Icon = NAV_ICONS[i.icon] ?? Circle;
      out.push({ key: `page:${i.to}`, group: 'Pages', label: i.label, hint: i.section ? SECTION_LABELS[i.section] : undefined, icon: <Icon className={ICON} aria-hidden />, to: i.to });
    }
    // Results answer the debounced query; while the user is still typing the previous ones stay (no flicker).
    if (searching && search.data) {
      // The group whose best result answers the query best comes first (ties keep People, Events, … order).
      const best = (kind: string) => Math.min(3, ...search.data.results.filter((x) => x.kind === kind).map((x) => x.rank ?? 2));
      const kinds = [...SEARCH_KINDS].sort((a, b) => best(a) - best(b));
      for (const kind of kinds) {
        for (const r of search.data.results.filter((x) => x.kind === kind)) {
          out.push({ key: `${r.kind}:${r.id}`, group: SEARCH_KIND_LABELS[kind], label: r.title, hint: r.subtitle ?? undefined, icon: <ResultIcon r={r} />, to: r.href });
        }
      }
    }
    return out;
  }, [q, items, user, searching, search.data]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus, inputRef]);
  useEffect(() => { if (active >= options.length) setActive(0); }, [active, options.length]);

  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const pending = searching && (search.isFetching || debounced !== normaliseSearchQuery(query));

  const go = (o: Option | undefined) => {
    if (!o) return;
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
    navigate(o.to);
    onNavigate?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setOpen(true); setActive((a) => (options.length ? (a + 1) % options.length : 0)); break;
      case 'ArrowUp': e.preventDefault(); setOpen(true); setActive((a) => (options.length ? (a - 1 + options.length) % options.length : 0)); break;
      case 'Enter': e.preventDefault(); go(options[active]); break;
      case 'Escape':
        e.preventDefault();
        if (query) setQuery('');
        else if (onDismiss) onDismiss();
        else { setOpen(false); inputRef.current?.blur(); }
        break;
      case 'Tab': setOpen(false); break;
    }
  };

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const placeholder = user.role === 'rep' ? 'Search or go to…' : 'Search people, events…';

  return (
    <div
      className={clsx('relative', className)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <label htmlFor={`${id}-input`} className="sr-only">Search or go to a page</label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={inputRef}
        id={`${id}-input`}
        type="search"
        enterKeyHint="go"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        aria-keyshortcuts="Meta+K Control+K"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="focus-ring h-9 w-full rounded-lg border border-control-border bg-surface pl-9 pr-14 text-sm text-fg shadow-card transition-colors placeholder:text-subtle hover:border-muted focus:border-primary [&::-webkit-search-cancel-button]:hidden"
      />
      {!embedded && (
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted lg:inline-flex" aria-hidden>
          ⌘K
        </kbd>
      )}
      {pending && <Loader2 className={clsx('absolute top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted', embedded ? 'right-3' : 'right-12')} aria-hidden />}
      {open && (
        <div
          className={clsx(
            'scrollbar-thin overflow-y-auto text-sm',
            embedded ? 'mt-1.5 max-h-[min(26rem,60vh)]' : 'absolute left-0 right-0 top-full z-40 mt-1.5 max-h-[min(28rem,70vh)] min-w-[20rem] animate-scale-in rounded-xl border border-border bg-surface p-1 shadow-pop',
          )}
        >
          <ul id={listId} role="listbox" aria-label="Search results">
            {options.length === 0 ? (
              <li role="option" aria-selected={false} aria-disabled className="px-2.5 py-2 text-muted">
                {pending ? 'Searching…' : `Nothing matches “${query.trim()}”`}
              </li>
            ) : (
              options.map((o, i) => (
                <li key={o.key} role="presentation">
                  {(i === 0 || options[i - 1].group !== o.group) && (
                    <div role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{o.group}</div>
                  )}
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()} // keep focus in the input so blur does not close the list first
                    onClick={() => go(o)}
                    className={clsx('flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-fg lg:min-h-9', i === active && 'bg-surface-2')}
                  >
                    {o.icon}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{o.label}</span>
                      {o.hint && o.group !== 'Pages' && <span className="truncate text-xs text-muted">{o.hint}</span>}
                    </span>
                    {o.hint && o.group === 'Pages' && <span className="shrink-0 text-[11px] text-muted">{o.hint}</span>}
                  </div>
                </li>
              ))
            )}
            {searching && search.isError && (
              <li role="presentation" className="px-2.5 py-2 text-xs text-danger">Search is not answering right now; pages and actions still work.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
