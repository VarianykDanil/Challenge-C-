import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';
import clsx from 'clsx';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { CARD_BREAKPOINT_PX, PHONE_CARD_LIMIT, cardLayout, cardsShown, sortChoices, type CardLayout, type Column } from './tableLayout';

export type { CardRole, Column } from './tableLayout';

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  emptyMessage?: ReactNode;
  /** Richer empty state (title/description/action) rendered when there are no rows. */
  empty?: ReactNode;
  loading?: boolean;
  /** Number of skeleton rows to show while loading. */
  loadingRows?: number;
  dense?: boolean;
  /** key of the column to sort by initially */
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** Controlled sort; when provided, the table calls onSortChange instead of sorting itself. */
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  onSortChange?: (sort: { key: string; dir: 'asc' | 'desc' } | null) => void;
  footer?: ReactNode;
  className?: string;
  stickyHeader?: boolean;
  /** Max height; enables vertical scroll with the sticky header. */
  maxHeight?: number | string;
  /** Highlight the row whose key matches. */
  selectedKey?: string | number | null;
  /** Classes applied per row (e.g. to dim inactive items). */
  rowClassName?: (row: T) => string | undefined;
  /** Caption for screen readers. */
  caption?: string;
  /** Render without the outer border/background (for inside a Card with padded={false}). */
  bare?: boolean;
  /**
   * On a phone (narrower than 640 px): 'cards' (the default) shows each row as a card, so every column can be read
   * without sideways scrolling (columns choose their place with `card`); 'scroll' keeps the table and its swipe hint.
   */
  phone?: 'cards' | 'scroll';
  /** Cards: how many a phone shows before "Show all" (default PHONE_CARD_LIMIT; null shows every card). */
  phoneRows?: number | null;
}

/** Descendants that own their own interaction — a click or key inside them must not activate the row. */
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-stop-row]';

/**
 * True when an event on a clickable row should count as activating the row. Ignores events whose
 * target lives in a nested control, and events that only reach the row through React's tree (a
 * portaled Modal or Dropdown opened from inside the row bubbles synthetic events to the <tr>).
 */
function isRowActivation(e: SyntheticEvent<HTMLElement>): boolean {
  const row = e.currentTarget;
  const target = e.target as HTMLElement | null;
  if (!target || !row.contains(target)) return false;
  const hit = target.closest(INTERACTIVE);
  return !hit || !row.contains(hit) || hit === row;
}

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' } as const;

function compare(a: string | number | null, b: string | number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, emptyMessage = 'Nothing to show', empty, loading, loadingRows = 5, dense,
  initialSort, sort: sortProp, onSortChange, footer, className, stickyHeader = true, maxHeight, selectedKey, rowClassName, caption, bare,
  phone = 'cards', phoneRows = PHONE_CARD_LIMIT,
}: DataTableProps<T>) {
  const narrow = useMediaQuery(`(max-width: ${CARD_BREAKPOINT_PX - 0.02}px)`);
  const asCards = narrow && phone === 'cards';
  const [sortState, setSortState] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const sort = sortProp !== undefined ? sortProp : sortState;

  const setSort = (next: { key: string; dir: 'asc' | 'desc' } | null) => {
    if (sortProp === undefined) setSortState(next);
    onSortChange?.(next);
  };

  const toggle = (c: Column<T>) => {
    if (!c.sortValue) return;
    if (sort?.key !== c.key) setSort({ key: c.key, dir: 'asc' });
    else if (sort.dir === 'asc') setSort({ key: c.key, dir: 'desc' });
    else setSort(null);
  };

  const sorted = useMemo(() => {
    if (!sort || onSortChange) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows
      .map((r, i) => ({ r, i, v: sv(r) }))
      .sort((a, b) => compare(a.v, b.v) * dir || a.i - b.i)
      .map((x) => x.r);
  }, [rows, sort, columns, onSortChange]);

  // Horizontal overflow affordance: edge fades + a one-off "swipe" hint instead of silently clipping columns.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const next = { left: el.scrollLeft > 1, right: max - el.scrollLeft > 1 };
      setEdge((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
    // again when the table comes back (a phone turned sideways past 640 px swaps the cards for the table)
  }, [asCards]);
  const scrollable = edge.left || edge.right;

  const isEmpty = !loading && rows.length === 0;
  if (asCards) {
    return (
      <div className={clsx('relative w-full', !bare && 'rounded-xl border border-border bg-surface shadow-card', className)}>
        <CardRows
          columns={columns}
          rows={sorted}
          rowKey={rowKey}
          onRowClick={onRowClick}
          loading={loading}
          loadingRows={loadingRows}
          selectedKey={selectedKey}
          rowClassName={rowClassName}
          caption={caption}
          sort={sort}
          onSort={setSort}
          limit={phoneRows}
        />
        {isEmpty && <EmptyRows empty={empty} emptyMessage={emptyMessage} />}
        {footer && !isEmpty && (
          <div className="scrollbar-thin overflow-x-auto border-t border-border">
            <table className="w-full text-sm"><tfoot className="[&_td]:bg-surface-2/95 [&_td]:px-4 [&_td]:py-2.5 [&_td]:font-semibold [&_td]:tabular">{footer}</tfoot></table>
          </div>
        )}
      </div>
    );
  }

  const cellPad = dense ? 'px-3 py-1.5' : 'px-4 py-3';
  const alignClass = (a?: Column<T>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

  return (
    <div className={clsx('relative w-full', !bare && 'rounded-xl border border-border bg-surface shadow-card', className)}>
      {/* the scroller and its edge fades; the empty state and the hint sit below it, outside the fades */}
      <div className="relative rounded-[inherit]">
      <div
        ref={scrollRef}
        className="scrollbar-thin relative w-full overflow-auto rounded-[inherit]"
        style={maxHeight ? { maxHeight } : undefined}
        // A scrollable region must be reachable by keyboard; it gets a name from the caption.
        tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? 'region' : undefined}
        aria-label={scrollable ? (caption ?? 'Scrollable table') : undefined}
      >
      <table className={clsx('w-full border-separate border-spacing-0 text-sm', dense && 'text-[13px]')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={clsx(stickyHeader && 'sticky top-0 z-10')}>
          <tr>
            {columns.map((c) => {
              const sortable = !!c.sortValue;
              const active = sort?.key === c.key;
              const Icon = active ? (sort!.dir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
                  className={clsx(
                    'whitespace-nowrap border-b border-border bg-surface-2/95 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted backdrop-blur',
                    dense ? 'px-3 py-2' : 'px-4 py-2.5',
                    alignClass(c.align),
                    c.hideBelow && HIDE[c.hideBelow],
                    c.headerClassName,
                  )}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggle(c)}
                      className={clsx(
                        // No truncation: the header sets the column's minimum width so titles always read in full.
                        'focus-ring -mx-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 transition-colors hover:text-fg',
                        // 40 px to tap on a phone, reaching into the cell's padding so the header row keeps its height
                        dense ? 'max-sm:-my-2 max-sm:py-3' : 'max-sm:-my-2.5 max-sm:py-3',
                        c.align === 'right' && 'flex-row-reverse',
                        active && 'text-fg',
                      )}
                    >
                      <span>{c.header}</span>
                      <Icon className={clsx('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-subtle')} aria-hidden />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: loadingRows }).map((_, i) => (
              <tr key={`sk-${i}`} aria-hidden>
                {columns.map((c, j) => (
                  <td key={c.key} className={clsx(cellPad, 'border-b border-border', c.hideBelow && HIDE[c.hideBelow])}>
                    <div className={clsx('skeleton h-3.5 rounded', j === 0 ? 'w-3/4' : 'w-1/2', c.align === 'right' && 'ml-auto')} style={{ animationDelay: `${i * 60}ms` }} />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            sorted.map((r) => {
              const key = rowKey(r);
              const selected = selectedKey != null && selectedKey === key;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? (e) => { if (isRowActivation(e)) onRowClick(r); } : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    if (!isRowActivation(e)) return; // let nested controls (select, buttons, dialogs) handle their own keys
                    e.preventDefault();
                    onRowClick(r);
                  } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-selected={selected || undefined}
                  className={clsx(
                    'group/row transition-colors duration-100',
                    onRowClick && 'focus-ring-inset cursor-pointer outline-none hover:bg-surface-2/70',
                    !onRowClick && 'hover:bg-surface-2/40',
                    selected && 'bg-primary-soft/60 hover:bg-primary-soft',
                    rowClassName?.(r),
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={clsx(
                        cellPad,
                        'border-b border-border align-middle text-fg group-last/row:border-b-0',
                        alignClass(c.align),
                        c.align === 'right' && 'tabular',
                        c.hideBelow && HIDE[c.hideBelow],
                        c.className,
                      )}
                    >
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
        {footer && (
          <tfoot
            className={clsx(
              stickyHeader && 'sticky bottom-0 z-10',
              '[&_td]:border-t [&_td]:border-border [&_td]:bg-surface-2/95 [&_td]:text-sm [&_td]:font-semibold [&_td]:text-fg [&_td]:backdrop-blur [&_td]:tabular',
              dense ? '[&_td]:px-3 [&_td]:py-2' : '[&_td]:px-4 [&_td]:py-2.5',
            )}
          >
            {footer}
          </tfoot>
        )}
      </table>
      </div>
      {edge.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-20 w-12 rounded-r-[inherit] bg-gradient-to-l from-surface to-transparent" />}
      {edge.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-20 w-8 rounded-l-[inherit] bg-gradient-to-r from-surface to-transparent" />}
      </div>
      {/* 1.3.1 UI review: the empty state sits under the header row at the table's visible width, not centred across the
          scrolling columns (on a phone it was cut off: "…appear once a we") */}
      {isEmpty && <EmptyRows empty={empty} emptyMessage={emptyMessage} />}
      {/* The hint is a line under the table (it covered the last row's figures as a floating chip), kept while the table
          scrolls so the rows do not jump when it fades; never on an empty table. */}
      {scrollable && !isEmpty && (
        <div aria-hidden className="flex justify-end px-3 py-1.5">
          <span className={clsx('rounded-full bg-fg/85 px-2 py-0.5 text-[11px] font-medium text-bg shadow-pop transition-opacity', edge.right && !edge.left ? 'opacity-100' : 'opacity-0')}>
            <span className="pointer-coarse:hidden">Scroll</span><span className="hidden pointer-coarse:inline">Swipe</span> to see more →
          </span>
        </div>
      )}
    </div>
  );
}

function EmptyRows({ empty, emptyMessage }: { empty?: ReactNode; emptyMessage: ReactNode }) {
  return (
    <div className="px-4 py-12">
      {empty ?? (
        <div className="flex flex-col items-center gap-2 text-center text-muted">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-subtle" aria-hidden><Inbox className="h-5 w-5" /></span>
          <span className="text-sm">{emptyMessage}</span>
        </div>
      )}
    </div>
  );
}

interface CardRowsProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  loadingRows: number;
  selectedKey?: string | number | null;
  rowClassName?: (row: T) => string | undefined;
  caption?: string;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  onSort: (sort: { key: string; dir: 'asc' | 'desc' } | null) => void;
  limit: number | null;
}

/** A field's label in the card: its card label, else the column header (plain text or the header's own element). */
function FieldLabel<T>({ c }: { c: Column<T> }) {
  return <>{c.cardLabel ?? c.header}</>;
}

/**
 * The phone layout: one card per row (title and the key figure first, then every other column as a labelled field,
 * then the row's buttons) and a "Sort by" list in place of the column headers. Nothing scrolls sideways.
 */
function CardRows<T>({ columns, rows, rowKey, onRowClick, loading, loadingRows, selectedKey, rowClassName, caption, sort, onSort, limit }: CardRowsProps<T>) {
  const layout: CardLayout<T> = useMemo(() => cardLayout(columns), [columns]);
  const baseId = useId();
  const [expanded, setExpanded] = useState(false);
  const choices = useMemo(() => sortChoices(columns), [columns]);
  // a column header that is itself a control (the "select all" box) stays reachable above the cards
  const toolbarLead = layout.lead.filter((c) => typeof c.header !== 'string');
  const showSort = choices.length > 0 && rows.length > 1;
  const selectedIndex = selectedKey == null ? -1 : rows.findIndex((r) => rowKey(r) === selectedKey);
  const { shown, hidden } = cardsShown({ total: rows.length, limit, expanded, selectedIndex });
  return (
    <>
      {(showSort || toolbarLead.length > 0) && !loading && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
          {toolbarLead.map((c) => (
            // using a select-all box shows every card first, so nothing ticked is out of sight
            <span key={c.key} className="inline-flex items-center gap-1 text-sm text-muted" onClickCapture={() => setExpanded(true)}>
              {c.header}
              {c.cardLabel && <span aria-hidden>{c.cardLabel}</span>}
            </span>
          ))}
          {showSort && (
            <label className="ml-auto inline-flex min-w-0 items-center gap-2 text-xs font-medium text-muted">
              Sort by
              <select
                className="focus-ring h-10 min-w-0 max-w-[14rem] cursor-pointer truncate rounded-lg border border-control-border bg-surface px-2 text-sm text-fg"
                value={sort ? `${sort.key}:${sort.dir}` : ''}
                onChange={(e) => {
                  const pick = choices.find((x) => x.value === e.target.value);
                  onSort(pick ? { key: pick.key, dir: pick.dir } : null);
                }}
              >
                {!sort && <option value="">As listed</option>}
                {choices.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      <ul className="divide-y divide-border" aria-label={caption} aria-busy={loading || undefined}>
        {loading &&
          Array.from({ length: Math.min(loadingRows, 4) }).map((_, i) => (
            <li key={`sk-${i}`} aria-hidden className="space-y-2 px-4 py-3">
              <div className="skeleton h-4 w-2/3 rounded" style={{ animationDelay: `${i * 60}ms` }} />
              <div className="skeleton h-3 w-1/2 rounded" style={{ animationDelay: `${i * 60}ms` }} />
            </li>
          ))}
        {!loading &&
          rows.slice(0, shown).map((r, i) => {
            const key = rowKey(r);
            const selected = selectedKey != null && selectedKey === key;
            const id = `${baseId}-${i}`;
            // A tap anywhere on the card opens it. For the keyboard and screen readers the card stays a list item (so
            // links and buttons inside it stay reachable) and gets a real "Open …" button, named from its title, out of
            // sight; the card shows the focus ring while that button has focus.
            return (
              <li
                key={key}
                onClick={onRowClick ? (e) => { if (isRowActivation(e)) onRowClick(r); } : undefined}
                data-card-row=""
                data-selected={selected || undefined}
                className={clsx(
                  'px-4 py-3 transition-colors duration-100',
                  onRowClick && 'cursor-pointer active:bg-surface-2/70 has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-inset has-[[data-card-open]:focus-visible]:ring-primary',
                  selected && 'bg-primary-soft/60',
                  rowClassName?.(r),
                )}
              >
                {onRowClick && (
                  <button
                    type="button"
                    data-card-open=""
                    className="sr-only"
                    aria-labelledby={`${id}-open ${id}-title`}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onRowClick(r)}
                  >
                    <span id={`${id}-open`} hidden>Open</span>
                  </button>
                )}
                <div className="flex items-start gap-3">
                  {layout.lead.map((c) => <div key={c.key} className="-my-1 shrink-0">{c.render(r)}</div>)}
                  <div id={`${id}-title`} className="min-w-0 flex-1 space-y-0.5 text-sm font-medium text-fg [overflow-wrap:anywhere]">
                    {layout.title.map((c) => <div key={c.key}>{c.render(r)}</div>)}
                  </div>
                  {layout.aside.length > 0 && (
                    <div className="flex max-w-[50%] shrink-0 flex-col items-end gap-1 text-right text-sm tabular">
                      {layout.aside.map((c) => (
                        <div key={c.key} className="leading-tight">
                          <div className="font-semibold text-fg">{c.render(r)}</div>
                          <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"><FieldLabel c={c} /></div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {(layout.fields.length > 0 || layout.wide.length > 0) && (
                  <dl className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-x-3 gap-y-2">
                    {layout.fields.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"><FieldLabel c={c} /></dt>
                        <dd className="mt-0.5 text-sm text-fg tabular [overflow-wrap:anywhere]">{c.render(r)}</dd>
                      </div>
                    ))}
                    {layout.wide.map((c) => (
                      <div key={c.key} className="col-span-full min-w-0">
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"><FieldLabel c={c} /></dt>
                        <dd className="mt-1 text-sm text-fg [overflow-wrap:anywhere]">{c.render(r)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {layout.actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    {layout.actions.map((c) => <Fragment key={c.key}>{c.render(r)}</Fragment>)}
                  </div>
                )}
              </li>
            );
          })}
      </ul>
      {!loading && hidden > 0 && (
        <div className="border-t border-border px-4 py-2">
          <button
            type="button"
            className="focus-ring h-11 w-full rounded-lg text-sm font-semibold text-primary hover:bg-primary-soft/60"
            onClick={() => setExpanded(true)}
            data-cards-show-all=""
          >
            Show all {rows.length}
          </button>
        </div>
      )}
    </>
  );
}
