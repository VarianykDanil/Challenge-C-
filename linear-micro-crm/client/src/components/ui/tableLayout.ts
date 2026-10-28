// DataTable's column type and how a row is laid out as a card on a phone. Pure (no React rendering), so the rules are
// tested in Node (tableLayout.test.ts).
//
// On a screen narrower than CARD_BREAKPOINT_PX a wide table cannot show its columns side by side without sideways
// scrolling, so DataTable shows each row as a card instead: the title (who or what) and the aside (the amount or
// status that matters most) on the first line, then every other column as a labelled field, then the row's buttons.
// Nothing is cut off and nothing needs a swipe.
import type { ReactNode } from 'react';

/** Below this width (CSS pixels) DataTable shows cards; from it up, the table. */
export const CARD_BREAKPOINT_PX = 640;

/**
 * Where a column goes in the phone card:
 * - 'lead': before the title (a selection box);
 * - 'title': the card's heading (the first column, unless another is chosen); several stack;
 * - 'aside': the right of the first line (the amount or the status to see at a glance);
 * - 'field': a labelled value in the grid under the title (the default);
 * - 'wide': a labelled value across the whole card (badges, long text);
 * - 'actions': the row's buttons, at the bottom;
 * - 'hidden': left out of the card (already shown elsewhere in it).
 */
export type CardRole = 'lead' | 'title' | 'aside' | 'field' | 'wide' | 'actions' | 'hidden';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** value accessor used for client-side sorting; omit to disable sorting on this column */
  sortValue?: (row: T) => string | number | null;
  className?: string;
  /** Hide below the given breakpoint in the table (adds `hidden md:table-cell` etc.). The phone card still shows it. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  /** Header cell class. */
  headerClassName?: string;
  /** Where the column goes in the phone card (see CardRole). */
  card?: CardRole;
  /** The column's name in the card and in the phone's "Sort by" list, when the header is not plain text. */
  cardLabel?: string;
  /** Words for the two sort directions on a phone, e.g. ['oldest first', 'newest first']. */
  sortWords?: [string, string];
}

export interface CardLayout<T> {
  lead: Column<T>[];
  title: Column<T>[];
  aside: Column<T>[];
  fields: Column<T>[];
  wide: Column<T>[];
  actions: Column<T>[];
}

/** The role a column takes when it does not say: selection boxes lead, row buttons go last, the rest are fields. */
function defaultRole<T>(c: Column<T>): CardRole {
  if (c.key === 'select') return 'lead';
  if (c.key === 'actions') return 'actions';
  return 'field';
}

export function cardLayout<T>(columns: Column<T>[]): CardLayout<T> {
  const out: CardLayout<T> = { lead: [], title: [], aside: [], fields: [], wide: [], actions: [] };
  const anyTitle = columns.some((c) => c.card === 'title');
  let titled = anyTitle;
  for (const c of columns) {
    let role = c.card ?? defaultRole(c);
    // with no column chosen as the title, the first ordinary column is
    if (!titled && !c.card && role === 'field') {
      role = 'title';
      titled = true;
    }
    if (role === 'hidden') continue;
    if (role === 'field') out.fields.push(c);
    else if (role === 'title') out.title.push(c);
    else out[role].push(c);
  }
  return out;
}

/** A column's name in words: its card label, else its header when that is plain text, else its key. */
export function columnLabel<T>(c: Column<T>): string {
  if (c.cardLabel) return c.cardLabel;
  if (typeof c.header === 'string' && c.header.trim()) return c.header;
  return c.key.charAt(0).toUpperCase() + c.key.slice(1);
}

export interface SortChoice {
  value: string;
  label: string;
  key: string;
  dir: 'asc' | 'desc';
}

/** The phone's "Sort by" list: each sortable column, both ways ("Gross (highest first)"). */
export function sortChoices<T>(columns: Column<T>[]): SortChoice[] {
  const out: SortChoice[] = [];
  for (const c of columns) {
    if (!c.sortValue) continue;
    const [up, down] = c.sortWords ?? ['lowest first', 'highest first'];
    const name = columnLabel(c);
    out.push({ value: `${c.key}:asc`, label: `${name} (${up})`, key: c.key, dir: 'asc' });
    out.push({ value: `${c.key}:desc`, label: `${name} (${down})`, key: c.key, dir: 'desc' });
  }
  return out;
}

/** On a phone a long list shows this many cards first, then "Show all" (a card is several lines tall). */
export const PHONE_CARD_LIMIT = 10;
/** A list at most this many cards over the limit is shown whole: "Show 2 more" is not worth a tap. */
const PHONE_CARD_SLACK = 3;

/**
 * How many cards a phone shows: the first `limit`, then a "Show all" button, so a page of long lists stays short.
 * The open (selected) row is never hidden. (DataTable shows every card as soon as a select-all box is used, so nothing
 * ticked is out of sight.) `limit` null: every card.
 */
export function cardsShown(o: { total: number; limit: number | null; expanded: boolean; selectedIndex: number }): { shown: number; hidden: number } {
  const { total, limit } = o;
  if (limit === null || o.expanded || total <= limit + PHONE_CARD_SLACK) return { shown: total, hidden: 0 };
  const shown = Math.min(total, Math.max(limit, o.selectedIndex + 1));
  return { shown, hidden: total - shown };
}
