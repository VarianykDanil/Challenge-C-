# U5 office-tools

## Search palette (⌘K / Ctrl+K)
- The topbar field now searches as well as going to pages. Type two letters or more: people, events, candidates and
  campaigns appear under their own headings, below matching actions and pages.
- Actions: **Log gauges** (reps, leaders, admin), **New event** (admin, and leaders with a team), **Mark week paid**
  (admin: opens Finance → Company → Runs to pay).
- Role scoping is done on the server (`GET /search?q=`), with the same rules as the pages a result opens: everyone
  finds people (only admins also find leavers and match on employee ID); reps find only their own team's events and
  never candidates; recruiters, leaders and admin find candidates; reps and recruiters find active campaigns (opening
  the campaign's pitch), leaders and admin every campaign.
- Answers are cached per user for 20 seconds; the field waits 200 ms after the last key before asking.
- Phones: the magnifier in the topbar opens the same search in a small panel, with 44 px rows.

## Export for payroll (Xero / Sage)
- Finance → Company → Runs to pay → **Export for payroll** (admin only). Choose the week and Xero Payroll or Sage
  Payroll; the file holds that week's unpaid runs (pending and failed transfers).
- Columns: employee name, employee ID, period start, period end, gross, base, commission, bonus, overrides,
  deductions, reference. Dates are UK format (dd/mm/yyyy), money has two decimals.
- Cells that begin with = + - @ (or a tab) get a leading apostrophe so a spreadsheet never runs them as formulas.
- The export only reads: it never changes a run. Each export is written to the audit trail.
- API: `GET /finance/payroll/export?weekStart=YYYY-MM-DD&format=xero|sage[&runs=unpaid|all]` → CSV, `X-Total-Count`.

## Layout fix
- Gauges: the tabs and the date-range presets share a row only when both fit; otherwise the presets wrap onto their
  own line. At 1024 px the admin's Gauges page no longer scrolls sideways.
