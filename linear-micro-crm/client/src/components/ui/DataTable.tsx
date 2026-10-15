import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';
import clsx from 'clsx';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** value accessor used for client-side sorting; omit to disable sorting on this column */
  sortValue?: (row: T) => string | number | null;
  className?: string;
  /** Hide below the given breakpoint (adds `hidden md:table-cell` etc.). */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  /** Header cell class. */
  headerClassName?: string;
}

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
}: DataTableProps<T>) {
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

  const cellPad = dense ? 'px-3 py-1.5' : 'px-4 py-3';
  const alignClass = (a?: Column<T>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');
  const isEmpty = !loading && rows.length === 0;

  return (
    <div
      className={clsx('relative w-full overflow-auto scrollbar-thin', !bare && 'rounded-xl border border-border bg-surface shadow-card', className)}
      style={maxHeight ? { maxHeight } : undefined}
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
                        'focus-ring -mx-1.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:text-fg',
                        c.align === 'right' && 'flex-row-reverse',
                        active && 'text-fg',
                      )}
                    >
                      <span className="truncate">{c.header}</span>
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
          {isEmpty && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12">
                {empty ?? (
                  <div className="flex flex-col items-center gap-2 text-center text-muted">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-subtle" aria-hidden><Inbox className="h-5 w-5" /></span>
                    <span className="text-sm">{emptyMessage}</span>
                  </div>
                )}
              </td>
            </tr>
          )}
          {!loading &&
            sorted.map((r) => {
              const key = rowKey(r);
              const selected = selectedKey != null && selectedKey === key;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(r); } } : undefined}
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
  );
}
