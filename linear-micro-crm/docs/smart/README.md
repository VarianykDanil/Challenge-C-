# Smart release 1.1 — documentation fragments

Each package writes **one** file here, `docs/smart/<package>.md`, with exactly three sections:

```
## API          endpoints, query params, response fields, status codes, role rules
## Logic        formulas, thresholds, edge cases, copy rules
## User guide   what each role sees, in plain words (buttons and fields named as on screen, in **bold**)
```

Do not edit `docs/LOGIC.md`, `docs/API.md`, `docs/USER_GUIDE.md`, `docs/ROADMAP.md` or `README.md` directly: a final
pass merges every fragment into the skeleton sections p1 laid down. Write in British English and follow the copy style
guide in LOGIC.md §14.0.

| Package | LOGIC.md | API.md (`## Smart endpoints`) | USER_GUIDE.md (`## What's new in 1.1`) |
|---|---|---|---|
| p1-foundation-contracts | §14.0, §14.1 (written) | overview table, optional fields (written) | links that open the right screen; if a card hits a problem (written) |
| p2-personal-pace-streaks | §14.2 | Pace and streaks | Your pace and streaks |
| p3-money-forecast-payroll-checks | §14.3 | Pay forecast and payroll checks | This week's pay estimate and payroll checks |
| p4-leader-check-ins-coaching | §14.4 | Check-ins | Check in with… |
| p5-needs-attention-feed | §14.5 | Needs attention | Needs attention |
| p6-event-forecasts-roster | §14.6 | Event forecasts | Event forecasts and who has not logged yet |
| p7-signal-proof-logging | §14.7 | Logging when the signal drops | If the signal drops |
| p8-recruitment-slas | §14.8 | Recruitment SLAs | Recruitment deadlines |
| p9-week-in-review-digest | §14.9 | Week in review | Your week in review (+ the section intro) |
| p10-backups-autostart | — (README) | Backups and health | Backups and running in the background |

## Bundle: what loads when (lead decision)

The smart release grew the main JS chunk from 445 kB to 511 kB (gzip 137 → 158 kB) and Vite warned about it. Measured
with `npm run build` (minified, before gzip):

| | main chunk | gzip | Vite warning |
|---|---|---|---|
| 1.0 (before the smart release) | 445.3 kB | 137.6 kB | no |
| after p2–p8 and p10 were merged | 510.8 kB | 158.3 kB | yes (> 500 kB) |
| now | 432.7 kB | 134.4 kB | no |

- **Global, in the main chunk** (needed on every screen): the bell (`NotificationsBell` and the item pieces it shares
  with the dashboard card, `features/smart/AttentionRow.tsx`), the gauge outbox (`OutboxBanner`, `outbox.ts`) and the
  offline banner. `OutboxBanner` formats its few dates itself, so it no longer pulls date-fns and `lib/format` (27 kB)
  into the main chunk; its text is unchanged ("14 Oct", "saved Sun 18 Oct, 14:02").
- **Dashboard-only smart components load on demand** (`React.lazy` + `Suspense`), all six in one small chunk
  (`features/smart/dashboardSlots.ts`, 10.7 kB) fetched after the dashboard page: `AttentionCard`, `BaselineNote`,
  `WeekPayStrip`, `TeamCoaching`, `CheckInList` and `WeekInReview`. Pages use the wrappers in
  `features/smart/lazy.tsx` (`LazyAttentionCard`, …). While the chunk arrives each slot shows a quiet placeholder
  shaped like what it will render (the card's own h-14 loading line, a strip-sized block), or nothing when the slot
  would render nothing anyway (no data yet, `LM_SMART=0`). Every slot keeps its own ErrorBoundary, so a chunk that
  cannot be fetched blanks only those slots (checked by aborting the request: the KPI tiles and the rest of the page
  stay).
- **Finance-only**: the sticky bulk-pay bar (`features/finance/BulkPayBar.tsx`) loads the first time an admin selects a
  run, through `LazyBulkPayBar` (`bulkPay.tsx` keeps `useBulkMarkPaid`, the helpers and `FlaggedRunsList`); a rep on
  **My pay** never downloads it.
- **The tally**: the full-screen counter (`features/gauges/TallyMode.tsx`) loads the first time it opens, through
  `LazyTallyMode`; the light entry points (`TallyButton`, `TodayTallyLink`) live in `TallyLinks.tsx`.
- `EventForecastChip` is 2.3 kB and renders inside every event row, so it stays where it is.
- Lazy-loading the smart components alone brought the main chunk to 481.6 kB, still over the 460 kB target, so the
  **sign-in page** and **About** are split too (they were in the main chunk since 1.0): someone already signed in, the
  usual case on a phone, never downloads the sign-in page (15 kB), and About (8 kB) is rarely opened. The sign-in page
  loads behind the same full-page spinner as the session check.
- Rule for later work: import a dashboard- or finance-only component through its `Lazy…` wrapper, never directly and
  never through a barrel that re-exports it, or it moves back into that page's chunk (or the main one). Measure with
  `npx vite build --sourcemap` and a source-map breakdown of `dist/assets/index-*.js`.
