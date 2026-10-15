# Linear Hub — Design System

Owned by the Product Designer. This is the reference for anyone writing UI in `client/`: tokens, type,
spacing, the component kit and the rules that keep every page looking like one product.

Source of truth:

| What | Where |
|---|---|
| Tokens (colours, shadows, radii, fonts, animations) | `client/src/index.css` |
| Brand config (logo files, palette mirror, inline/file switch) | `client/src/content/brand.ts` — **start here to rebrand** |
| Brand mark + wordmark | `client/src/components/brand/Logo.tsx` (inline default), `client/public/brand/{logo,logo-dark,mark}.svg`, `client/public/favicon.svg` |
| Public landing page (`/` signed out, `/welcome` always) | `client/src/pages/Landing.tsx`, copy in `client/src/content/landing.ts` |
| UI kit | `client/src/components/ui/**` (barrel: `@/components/ui`) |
| App shell, theme | `client/src/components/layout/**` (barrel: `@/components/layout`) |
| Microcopy | `client/src/content/copy.ts` (Marketing) — import `COPY`, never inline strings for shared copy |

---

## 1. Principles

1. **Field-first.** Reps log gauges on a phone between stops. Primary actions are thumb-sized (≥ 44px),
   forms tolerate fat fingers (`Stepper`, large inputs) and nothing important hides behind hover.
2. **Numbers are the product.** KPI values use the display face with tabular figures so columns line up
   and deltas read at a glance. Colour reinforces direction; an arrow or sign always carries it too.
3. **Calm surfaces, one accent.** Neutral surfaces, one brand violet, one warm accent for highlights.
   Status colours mean status — never decoration.
4. **Both themes, always.** Every component is built on semantic tokens and reviewed in light and dark.
5. **Accessible by default.** 4.5:1 text contrast, visible focus rings, labelled controls, keyboard paths
   for every interaction, `prefers-reduced-motion` respected.

---

## 2. Brand

**Linear MCR** is the company; **Linear Hub** is the product. The mark is three parallel lines of
increasing length, leaning forward (skew −14°) on a rounded tile: *linear*, *momentum*, *stops stacking
into sales*. It reads at 16px (favicon) and scales to hero size (login backdrop).

```tsx
import { Logo, LogoMark, Wordmark } from '@/components/brand/Logo';

<Logo />                               // mark + "Linear Hub" wordmark, 28px
<Logo variant="mark" size={32} />      // tile only
<Logo variant="wordmark" size={24} />  // text only
<Logo tone="inverse" />                // white tile for saturated/dark panels (login)
<Logo text="Linear MCR" />             // company lockup
```

- `tone="brand"` (default) uses `--primary` / `--primary-fg`, so it adapts to the theme.
- `tone="mono"` uses `currentColor` for the tile.
- The wordmark sets the first word in `currentColor` (bold) and the rest in `--primary` (semibold).
- Never recolour the mark with arbitrary hex, stretch it, or place it on busy imagery without the wash.
- `source="file"` renders the SVGs in `client/public/brand/` instead of the inline mark (light/dark pair for
  the lockup, `mark.svg` for the mark). The default comes from `BRAND_LOGO_SOURCE` in `content/brand.ts`.
- `<BrandBackdrop />` (`components/brand`) is the decorative parallel-line field used behind ink panels
  (login, landing hero). Always decorative, always `aria-hidden`.

### Rebranding (real logo and colours)

The placeholder identity is routed through one config, `client/src/content/brand.ts`:

1. **Logo** — replace `client/public/brand/logo.svg`, `logo-dark.svg`, `mark.svg` and `client/public/favicon.svg`
   with the real artwork (same file names), then set `BRAND_LOGO_SOURCE = 'file'`.
2. **Colours** — the only brand hexes in `index.css` are the `--brand-primary`, `--brand-primary-hover`,
   `--brand-accent` and `--brand-ink` properties at the top of `:root` (light) and `.dark`. `--primary`,
   `--primary-hover`, `--accent`, `--ink`, `--ring`, `--chart-1` (light) and both soft tints are derived from
   them with `var()` / `color-mix()`. Edit those eight values and the matching `BRAND_PALETTE` mirror in
   `brand.ts`; nothing else needs touching. Re-check `--primary-fg` / `--accent-fg` and the contrast table
   below if the new hues are much lighter or darker.
3. Names, legal name, address and website stay in `shared/src/constants.ts` → `BRAND` (Logic Builder's file).

---

## 3. Colour

All colours are CSS variables on `:root` / `.dark`, mapped to Tailwind utilities via `@theme inline`.
Use the utilities (`bg-surface`, `text-muted`, `border-border`…) — **never hex in pages**.

### Core palette

| Token | Light | Dark | Utility | Use |
|---|---|---|---|---|
| `--bg` | `#F5F6FA` | `#0B1020` | `bg-bg` | Page background |
| `--surface` | `#FFFFFF` | `#111729` | `bg-surface` | Cards, inputs, tables |
| `--surface-2` | `#EEF0F6` | `#182038` | `bg-surface-2` | Table heads, hover rows, chips |
| `--surface-3` | `#E4E7F0` | `#1F2946` | `bg-surface-3` | Pressed states, progress tracks |
| `--border` | `#E2E5EE` | `#243050` | `border-border` | Hairlines |
| `--border-strong` | `#CDD2DF` | `#324066` | `border-border-strong` | Hover borders, scrollbars (decorative) |
| `--control-border` | `#7A8398` | `#586889` | `border-control-border` | Form-control boundaries — Input, Select, Textarea, Stepper, search (3.8:1 / 3.2:1 vs `--surface`, WCAG 1.4.11 ≥ 3:1) |
| `--fg` | `#0F1526` | `#EDEFF7` | `text-fg` | Primary text (18.2:1 / 15.5:1) |
| `--muted` | `#5C657A` | `#9AA3B8` | `text-muted` | Secondary text (5.8:1 / 7.0:1) |
| `--subtle` | `#6B7489` | `#8089A3` | `text-subtle` | Placeholders, tertiary icons (4.7:1 / 5.1:1 on `--surface`; 4.3:1 on light `--bg`) — still **not** for body copy, use `text-muted` |
| `--primary` | `#4B3FD9` | `#9D99FF` | `bg-primary` `text-primary` | "Linear Violet" — actions, active nav, links (7.0:1 / 7.2:1) |
| `--primary-hover` | `#4034C4` | `#AEABFF` | `bg-primary-hover` | Button hover |
| `--primary-fg` | `#FFFFFF` | `#0B1020` | `text-primary-fg` | Text on primary (7.0:1 / 7.6:1) |
| `--primary-soft` | `#ECEAFC` | `rgb(157 153 255 / .14)` | `bg-primary-soft` | Tints: active nav, badges, icon chips |
| `--accent` | `#B83C0B` | `#FFA059` | `bg-accent` `text-accent` | "Ember" — highlights, notification dot, leader role (5.7:1 / 8.9:1; 4.9:1 as text on `--accent-soft`) |
| `--accent-fg` | `#FFFFFF` | `#0B1020` | `text-accent-fg` | Text on accent |
| `--accent-soft` | `#FDEBE1` | `rgb(255 160 89 / .14)` | `bg-accent-soft` | Accent tint |
| `--ink` / `--ink-fg` | `#0B1020` / `#EDEFF7` | `#080C19` / `#EDEFF7` | `bg-ink` `text-ink-fg` | Always-dark brand navy (login panel, hero blocks) |

### Status

| Token | Light (on surface · on its soft tint) | Dark (on surface) | Soft tint | Meaning |
|---|---|---|---|---|
| `--success` | `#137537` (5.8:1 · 5.1:1) | `#4ADE80` (10.2:1) | `bg-success-soft` | On track, paid, hired |
| `--warning` | `#A64A08` (5.8:1 · 5.2:1) | `#FBBF24` (10.7:1) | `bg-warning-soft` | Pending, below benchmark, late check-in |
| `--danger` | `#D11A2A` (5.4:1 · 4.5:1) | `#FB7185` (6.6:1) | `bg-danger-soft` | Failed, overdue, destructive |
| `--info` | `#0E7490` (5.4:1 · 4.7:1) | `#38BDF8` (8.3:1) | `bg-info-soft` | Neutral notices, recruiter role |
| `--status-fg` | `#FFFFFF` | `#0B1020` | `text-status-fg` | Text/icon **on a solid status colour** (`bg-success` etc.). Never `text-white` — dark-mode status colours are light, so white drops to 1.7:1 |

Contrast figures are text-on-`--surface` and, for light, text-on-its-own-soft-tint (both WCAG AA ≥ 4.5:1,
so `Badge`/`RatioCell`-style "status text on status tint" passes). Dark soft tints pass at 5.4–8.0:1.
Status colours are also distinguishable from each other for common colour-vision deficiencies (red/green
pairs always ship with an icon or label — see `StatDelta`, `Badge`, `Toast`).

### Charts

`--chart-1…6` are mapped to `--color-chart-n` for the Logic Builder's charts.

| n | Light | Dark (vs `--surface`) | Hue |
|---|---|---|---|
| 1 | `#4B3FD9` | `#8983E7` (4.9:1) | violet (primary) |
| 2 | `#C2410C` | `#D3782C` (6.1:1) | ember |
| 3 | `#0F766E` | `#00A997` (6.3:1) | teal |
| 4 | `#BE185D` | `#B4367D` (3.8:1) | magenta |
| 5 | `#0369A1` | `#059FD7` (5.9:1) | sky |
| 6 | `#4D7C0F` | `#70A500` (6.0:1) | olive |

The dark set is **selected, not the UI tints**: steps at OKLCH L 0.54–0.66 (the UI's `--primary`/`--accent`
dark tints are L 0.73–0.85 and too light for marks), every one ≥ 3:1 on `--surface`, adjacent pairs ≥ ΔE 11
under protan/deutan simulation (dataviz validator, `--mode dark --surface #111729`). Keep charts to ≤ 3–4
series; beyond that fold into "Other".

Use chart-1 for "the" series; add the others in order. Entity colours (team, campaign, avatar) come
from the data (`color` fields) and are the **only** place inline `style={{ color }}` is acceptable.

### Elevation

| Utility | Use |
|---|---|
| `shadow-card` | Cards, inputs, tiles (default resting state) |
| `shadow-card-hover` | Via `card-hover`; lifted cards |
| `shadow-pop` | Dropdowns, tooltips, toasts |
| `shadow-modal` | Dialogs, drawers |

Shadows are tokens too and are darker/tighter in dark mode. Don't use Tailwind's default `shadow-*`.

---

## 4. Typography

Loaded in `client/index.html` from Google Fonts with system fallbacks.

| Role | Face | Utility |
|---|---|---|
| UI / body | Inter 400–700 | `font-sans` (default on `body`) |
| Display (headings, KPI numbers) | Inter Tight 600–800 | `font-display` (applied to `h1–h4` globally), `kpi-number` |
| Codes (employee IDs, references) | system monospace | `font-mono` |

Base size is **15px**; line-height 1.5. `h1–h4` get `tracking-tight` and `text-wrap: balance`.

| Level | Classes | Where |
|---|---|---|
| Page title | `text-2xl sm:text-[28px] font-bold tracking-tight` | `PageHeader` |
| Section / card title | `text-sm font-semibold` | `CardHeader` |
| KPI value | `kpi-number text-[28px]` (sm `text-xl`, lg `text-4xl`) | `KpiTile` |
| Body | `text-sm` | Tables, forms, copy |
| Secondary | `text-xs text-muted` | Hints, meta |
| Eyebrow | `eyebrow` (11px, 600, uppercase, 0.08em) | Section labels, KPI labels |

Always put numbers that sit in columns in `tabular` (or `kpi-number`).

---

## 5. Spacing, radius, motion

- **Grid**: 4px base. Card padding `p-5` (20px). Page gutters `px-4 sm:px-6 lg:px-8`; content max-width
  1440px (`AppShell`), pass `fluid` for boards/wide tables.
- **Radius** (overridden Tailwind scale): `rounded-md` 8px (small chips), `rounded-lg` 10px (buttons,
  inputs, nav items), `rounded-xl` 14px (cards, tiles, tables, menus), `rounded-2xl` 20px (modals,
  hero chips), `rounded-full` (badges, avatars).
- **Control heights**: `sm` 32px, `md` 40px, `lg` 48px. Icon buttons are square at the same heights.
- **Motion**: 150–250ms, ease-out (`cubic-bezier(0.16,1,0.3,1)`). Utilities: `animate-fade-in`,
  `animate-scale-in`, `animate-slide-up`, `animate-slide-in-right/left`. Everything collapses under
  `prefers-reduced-motion`. No bouncing, no parallax.
- **Focus**: use the `focus-ring` utility (2px bg gap + 2px ring) on anything interactive. A global
  `:focus-visible` outline covers anything you forget.

---

## 6. Theme

`.dark` on `<html>` switches every token. `index.html` applies the stored choice before first paint.

```tsx
import { useTheme, ThemeToggle } from '@/components/layout';
const { theme, resolved, setTheme, toggle } = useTheme(); // theme: 'light'|'dark'|'system'
<ThemeToggle />                      // icon button, flips light/dark
<ThemeToggle variant="segmented" />  // Light / Dark / Auto — use on Settings
```

Persisted as `lm-theme`. Sidebar collapse state is `lm-sidebar`.

---

## 7. Public landing page

`client/src/pages/Landing.tsx` (copy: `client/src/content/landing.ts`) is the outward-facing first page: sticky
translucent top bar (logo, section anchors, `ThemeToggle`, **Sign in**), ink hero with `<BrandBackdrop />` and
an *illustrative* dashboard preview built from the real kit (`KpiTile`, `FunnelChart`, `TrendChart`), then
What we do · How we work (six gauges + law of averages) · Careers (ladder stepper) · Linear Hub · CTA band ·
footer. Routing: `/` shows it when signed out and the dashboard when signed in; `/welcome` always shows it.
Semantic tokens only, both themes, landmarks + skip link, heading order h1 → h2 (sections) → h3/h4 (cards).
Facts about the company are limited to what the business publishes; no statistics are quoted.

## 8. App shell

```tsx
<AppShell user={user} onLogout={logout} title={<CustomCrumb/>} fluid>{children}</AppShell>
```

- Fixed sidebar (264px, collapsible to 76px with tooltips), nav grouped by `section` from `nav.ts`
  (`main` → Workspace, `manage` → Manage, `me` → Account). Icons come from `NAV_ICONS` in
  `Sidebar.tsx` keyed by the `icon` string — add an entry when you add a nav item.
- Topbar: breadcrumb (auto from the route), search (visual for now), `ThemeToggle`, notifications bell,
  user menu (`Dropdown`) with position, team, appearance and **Sign out**.
- Mobile (< `lg`): hamburger opens a drawer; closes on navigation and Escape.
- Pages start with `<PageHeader title description actions />`.

---

## 9. Component inventory

All from `@/components/ui`. Prop names in the skeleton files are stable; everything listed as *added* is optional.

| Component | Key props | Added | Notes |
|---|---|---|---|
| `Button` | `variant` primary·secondary·outline·ghost·soft·accent·danger·link, `size` xs·sm·md·lg·icon·icon-sm·icon-xs, `loading`, `leftIcon`, `rightIcon` | `fullWidth`, `label` (a11y for icon-only), `type` defaults to `button` | Spinner replaces the left icon while loading. `ButtonGroup` joins buttons. |
| `Card` / `CardHeader` / `CardFooter` | `padded` · `title description actions` | `hoverable`, `flat`, `tone`; header `icon` | Use `hoverable` only when the whole card is clickable. |
| `KpiTile` | `label value delta deltaLabel invertDelta icon hint tone sparkline` | `loading`, `size`, `onClick`, `suffix` | Tone draws a coloured left edge and icon chip. Values scale with `clamp()` and never truncate; hints wrap to two lines. Pass `<Sparkline/>` to `sparkline`. |
| `StatDelta` | `value` (fraction), `invert`, `label`, `size`, `format`, `plain` | new | Arrow + sign always present; `null` → neutral "—". |
| `Badge` | `tone`, `dot`, `color` | `size`, `variant` soft·solid·outline | `color` = entity colour dot. Status badges stay `soft`. A leading `<svg>` in `children` is kept inline and sized to the pill (icon before text). |
| `Avatar` / `AvatarStack` | `name color size` | `ring`, `status`, `shape`, `src` | Text colour auto-picks for the entity colour. |
| `Field` / `Input` / `Textarea` | `label hint error required` · `invalid leftIcon` | `optional`, `trailing`, `as`; input `rightIcon`, `suffix`, `size`; textarea `showCount` | `Field` renders a `<label>`; pass `htmlFor` or let it wrap a single control (`required` also sets `aria-required` on that control). Borders use `--control-border` (≥ 3:1). |
| `Select` | `options placeholder invalid` | `groups`, `size`, option `disabled` | Custom chevron; shares input chrome. |
| `SegmentedControl` | `options value onChange size` | new; `fullWidth` | Sliding indicator; arrow keys. Use for 2–5 mutually exclusive views (e.g. week/month/quarter). On narrow screens it scrolls inside itself (never widens the page). |
| `Stepper` | `value onChange min max step label size` | new; `hint`, `invalid`, `fullWidth` | Phone-first +/−: press-and-hold repeats, typing allowed, arrow keys. Use for gauges. |
| `Switch` | `checked onChange label` | new; `description`, `size`, `labelPosition` | `role="switch"`. |
| `Tabs` | `items value onChange variant` underline·pills | `size`, `fullWidth`, item `icon`/`disabled` | Animated indicator, roving tabindex. |
| `DataTable` | `columns rows rowKey onRowClick emptyMessage loading dense initialSort footer stickyHeader` | `empty`, `loadingRows`, `sort`/`onSortChange` (controlled), `maxHeight`, `selectedKey`, `rowClassName`, `caption`, `bare`; column `hideBelow` | Sorts client-side when a column has `sortValue`. Headers never truncate (they set the column width); wide tables scroll inside the card with an edge fade and a "Swipe to see more" hint — keep `hideBelow` for genuinely optional columns only. Clicks/keys inside nested controls or portaled dialogs never trigger `onRowClick`. `footer` is `<tr>` content inside `<tfoot>`. Right-aligned cells are tabular. |
| `Modal` | `open onClose title description footer size` | `hideClose`, `persistent`, `icon`, `tone`, `initialFocusRef`, size `full` | Portal, focus trap, Escape, scroll lock, full-width bottom-sheet on phones (pinned to the visual viewport). Initial focus: `initialFocusRef` → first form control → first focusable that isn't Close; an `autoFocus` field wins. Events inside never bubble to a clickable row behind it. |
| `Dropdown` (= `Menu`) | `trigger items` (`label icon onSelect tone disabled shortcut checked separatorBefore`) | new; `header`, `align`, `side`, `width` | Full keyboard menu; portal-positioned. Menu-button ARIA (`aria-haspopup/expanded/controls`) is injected on the trigger element itself; Tab closes the menu and moves on from the trigger. |
| `Tooltip` | `content children` | new; `side`, `delay`, `disabled` | CSS hover/focus; no deps. Child gets `aria-describedby`. |
| `EmptyState` | `icon title description action` | `size`, `tone` | Default inbox icon and subtle brand-line backdrop. |
| `ProgressBar` | `value max tone color label showValue size` | `marker` (benchmark line), `auto` (colour by progress), `formatValue` | Use `marker` for law-of-averages targets. |
| `Skeleton` / `SkeletonKpi` / `SkeletonCard` | `className` | `circle`, `lines` | Shimmer, not pulse. |
| `PageHeader` | `title description actions breadcrumbs` | `eyebrow`, `icon`, `tabs` | One per page, at the top. |
| `Toast` (`ToastProvider`, `useToast`) | `success/error/info(title, description)` | `warning`, `dismiss`, `duration`, `action` | Icons per tone, slide-in, dismiss button; `aria-live="polite"` region; auto-dismiss pauses on hover **and** while any control inside has keyboard focus. |
| `Divider` | — | new; `label`, `orientation`, `spacing` | "or" separators, toolbar dividers. |

Custom CSS utilities: `focus-ring`, `focus-ring-inset`, `card-hover`, `kpi-number`, `tabular`,
`eyebrow`, `skeleton`, `scrollbar-thin`, `scrollbar-none`, `brand-lines`, `brand-wash`.

---

## 10. Do / Don't

**Do**
- Compose pages from the kit: `PageHeader` → KPI row (`KpiTile` ×3–4) → `Card`s with `CardHeader` → `DataTable`.
- Use `tone` props for meaning (`success` = on track) and entity `color` props for identity (team, campaign).
- Pair every colour signal with text or an icon (`StatDelta`, `Badge` labels, toast icons).
- Put money through `formatGBP()` and numbers in `tabular` cells.
- Use `Stepper` for gauge entry and `SegmentedControl` for range/view switches.
- Give icon-only buttons a `label`.

**Don't**
- Hard-code hex, `bg-white`, `text-gray-*`, `bg-blue-*` or `shadow-lg`. Use tokens.
- Use `text-subtle` for anything that must be read (it's for placeholders and decorative icons); use `text-white` on a status colour (use `text-status-fg`).
- Nest cards with shadows — use `flat` for inner cards.
- Add a new primary-looking button next to another; one primary per view.
- Create one-off spinners, modals or menus — extend the kit and tell the Designer.
- Use `eyebrow` text for anything longer than three words.

---

## 11. Checklist before you ship a page

- [ ] Looks right in light **and** dark (`ThemeToggle` in the topbar).
- [ ] Phone width (375px): no horizontal page scroll (`documentElement.scrollWidth <= innerWidth`), actions reachable; wide tables scroll inside their card (DataTable shows the fade + hint), `hideBelow` only for optional columns; grids are `grid-cols-1 lg:grid-cols-N` with `min-w-0` children.
- [ ] Tab through it: every control focusable with a visible ring, Escape closes overlays.
- [ ] Loading (`loading` props / skeletons), empty (`EmptyState`) and error (`Toast`/inline) states exist.
- [ ] No console warnings; no hex outside entity colours.
