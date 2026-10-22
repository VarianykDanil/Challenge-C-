# P4 pdf-everywhere

A PDF wherever a CSV exists today, and for invoices, candidate profiles, venue reports, the audit view, the leaderboard and a person's learning progress.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P4 pdf-everywhere**.

## API

P4 adds no server routes and no tables. Everything runs in the browser; the only server call is the audit report.

### POST /audit/events (P9's route, called by every export)

Each download sends one event (`features/pdf/report.ts` `reportExport(format, filename, rows, what?, ownerId?)`); the
file is already on the device, so a report never blocks or fails it. A report Linear Hub could not take — no signal,
a 5xx, 408, 429 (P9's 60 a minute), or 401 (the session ended) — waits on the device and is sent later (see Logic,
"Exports made without signal"); a 400 or 403 is dropped, since it would be refused again:

| Export | Body |
| --- | --- |
| Export ▾ CSV | `{ kind: 'export', format: 'csv', what, rows, filename }` |
| Export ▾ PDF | `{ kind: 'export', format: 'pdf', what, rows, filename }` (the file name ends in `.pdf`) |
| Audit → Download PDF | `{ kind: 'export', format: 'pdf', what: 'audit-trail', rows: <entries>, filename }` |
| Learning → Progress → Download PDF | `{ kind: 'export', format: 'pdf', what: 'learning-progress', rows: <lessons>, filename }` |

`what` is the page's `auditWhat` prop, else the CSV file name's section (shared `exportWhatFor`): e.g.
`gauges-by-team-deansgate`, `leaderboard-week-sales`, `payslips` — lower case, hyphens, at most 80 characters.
`server/src/test/pdf-export.test.ts` sends exactly these bodies: 204 for admin, leader, recruiter and rep; 403
(`clientPortalOnly`) for a client portal session; 401 anonymous. P9's validation must keep accepting them (checked
against P9's branch: its zod schema accepts them and drops unknown keys, so a replayed report carries no extra field).
Waiting reports also call `GET /auth/me` once before they are sent, to check the session is still that person's.

### Client: `client/src/lib/pdf` (STABLE; additions marked "Release 1.3 (P4)")

- `PDF_EXPORTS_READY = true`.
- `exportTablePdf(TablePdfOptions)` → downloads the file. Options as laid down (`title`, `subtitle?`, `filters?`,
  `columns` = the CSV `CsvColumn`s, `rows`, `totals?`, `filename`, `orientation?` 'auto') plus `generatedBy?` (name after
  "Generated …") and `now?` (the clock, for tests).
- `pdfDocument(PdfDocumentOptions)` → `PdfDoc`. Options: `orientation?`, `title?` (metadata and the running header of
  later pages), `generatedBy?`, `now?`. Chainable blocks, each drawn once:
  - `header({ title, subtitle?, meta?, filters? })` — the brand band, then the title; `meta` pairs on the right
    (`[['Invoice', 'LM-SB-2026-000123'], ['Due', 'Fri 23 Oct 2026']]`), `filters` lines under the subtitle.
  - `addressBlocks(left, right)`, `heading(text)`, `paragraph(text, { muted?, size? })`, `keyValues(rows)`,
    `lineTable(columns, rows)` (`width` relative, `align`, `muted` rows in grey), `table(csvColumns, rows)`,
    `totals(rows)` (`strong` = the bold total with a rule above), `signatureBlock(left, right?)` (`imageDataUrl` a PNG
    or JPEG data URL; an unreadable image leaves the line blank), `footer(text)`.
  - New: `space(mm?)`, `pageBreak()`, `needs(mm)` (start a new page unless that much room is left — keep a heading with
    its table), `bytes()` (the file as `Uint8Array`).
  - `save(filename)` / `blob()` / `bytes()` finish the file once (running headers, "Page x of y"); later calls return
    the same bytes.
- `preloadPdf()` starts loading the PDF chunk (ExportButton calls it when its menu opens).
- `PdfUnavailableError` when the chunk cannot load ("You are offline. Connect and try the PDF again — the CSV works
  offline." or "Could not load the PDF maker … Reload the page and try again.").
- `PdfLineRow` is now `{ [key: string]: string | boolean | undefined; muted?: boolean }` (the laid-down
  `Record<string, string> & { muted?: boolean }` could not be written as a literal with `muted: true`). Cells are
  strings; anything else prints empty.
- `render.ts` (the drawing, `buildTablePdf`, `createPdfDoc`, `prepareTable`, `tableFontSize`, `PDF_COLOURS`) and
  `engine.ts` (jsPDF + jspdf-autotable, the lazy chunk) are internal: import `@/lib/pdf`.

### Client: `client/src/lib/csv.ts`

- `CsvColumn.kind?: PdfCellKind` ('text' | 'number' | 'money' | 'date' | 'datetime' | 'percent') — how the PDF writes
  the column. Without it the formatter says (`csvMoney` → money, `csvDate` → date, `csvDateTime` → datetime,
  `csvPct(n)` → percent, `csvDecimal(n)` → number), else a column of plain numbers without a formatter is 'number',
  else 'text'. CSV output is unchanged (byte for byte).
- New helpers: `csvColumnKind(column, sample?)`, `csvCellText(row, column)` (the exact CSV cell text before quoting),
  `downloadBlob(filename, blob)` (`downloadCsv` uses it).

### Client: `ExportButton` (`features/common/ExportButton.tsx`)

Every call site is unchanged. With `PDF_EXPORTS_READY` and `pdf !== false` it is an **Export ▾** menu: **CSV**
("Spreadsheet · opens in Excel") and **PDF** ("To print or share"). The default label "Export CSV" now reads "Export";
a custom label keeps its words ("Export hired candidates"). `pdfTitle`, `pdfFilters`, `pdfTotals`, `auditWhat` refine
the PDF and the audit name. While nothing is on screen the button is disabled with the old hint.

- Filter lines: without `pdfFilters`, the PDF prints what the file name says (status, team, dates) plus the filters
  set in the button's own filter bar (`report.ts` `screenFiltersNear`): drop-downs with an "all" choice that are set
  ("Team: Northern Lights", "Position: Field Representative", "Source: Indeed", "Owner: Priya Shah") and search boxes
  with words in them ("Search: “Zed”"). That covers Team, Recruitment's list and Gauges with no call-site change. A
  page whose filters are not beside its button (or not drop-downs / search boxes) should pass `pdfFilters`.
- The menu opens above the toast stack (`Dropdown aboveToasts`, see below), so a toast never covers CSV / PDF.
- Each mounted button sends any export reports that waited on this device for its signed-in person.

### Client: `components/ui/Dropdown.tsx` (outside P4's files: one additive prop)

`aboveToasts?: boolean` (default false): the menu panel uses `z-[90]` instead of `z-[70]`, above the toasts
(`z-[80]`). Only ExportButton passes it; every other menu is unchanged. Needed because near the foot of the window
the Export menu opens upwards into the toast corner, where an attention toast ("34 runs to pay · …") or an export
toast covered the items and took the click.

### Client: slots filled

- `features/pdf/AuditPdfButton` `{ entries, filters, total?, query? }` — **Download PDF** in the Audit header (When,
  Who, What happened, Record, Changes) under P9's filter lines. New optional props: `total` (GET /audit `total`) and
  `query` (the view's GET /audit query without `limit` / `offset`). With both, the PDF holds every matching entry,
  newest first, up to 2,000 (read 200 at a time, the server's most), and says "The newest 2,000 of 2,550 matching
  entries" when capped; without them it is the page on screen, as before. **P9 / the lead: wire it in
  `pages/Audit.tsx`:** `total={total}` and `query={{ userId, entity: entity || undefined, entityId, from: from ||
  undefined, to: to || undefined, q: q || undefined, kind: kind || undefined }}` (on the foundation's page:
  `signIns: signIns ? undefined : 0` instead of `kind`).
- `features/pdf/ProgressPdfButton` `{ userId? }` — **Download PDF** on Learning → Progress (own view and a person's):
  the COD pack checklist, the next level's requirements and the required videos (P5's `GET /videos` for oneself,
  `GET /videos/team?userId=` for someone else; left out while none apply). `features/pdf/progressVideos.ts` (pure,
  node-tested) picks them: the own view lists the required videos that apply to the person's role (`videoRequiredOf`,
  the same rule as P5's shared `videoRequiredFor`, which can replace it once P5 lands); another person's view says
  "2 of 2 required videos watched" from that person's `requiredTotal` (not the body's `required`, which counts every
  audience's videos) and lists them from `cells` / `videos`.

### Shared: `shared/src/logic/exportFormat.ts`

`PDF_PORTRAIT_MAX_COLUMNS`, `PdfOrientation`, `pdfOrientationFor` (as laid down) plus `PdfCellKind`,
`PDF_WINANSI_EXTRAS`, `toPdfText`, `pdfSafeText`, `pdfInfoText`, `pdfMoney`, `pdfNumber`, `pdfDate`, `pdfDateShort`,
`pdfDateTime`, `pdfDateRange`, `pdfPageLabel`, `pdfCellText`, `isNumericCell`, `isNumericColumn`, `parseExportFilename`,
`pdfFilenameFor`, `exportWhatFor`, `pdfHeadingFor` (now also takes `screenFilters`), `pdfGeneratedLine`, and
`asciiFold` (re-exported from the new `shared/src/logic/textFold.ts`, which holds the fold and transliteration tables
so the main chunk, which names every CSV file, does not pull in the rest). Unit tests: `exportFormat.test.ts` (19).

### For the packages that draw page PDFs (P2, P7, P8)

```ts
import { PDF_EXPORTS_READY, pdfDocument, exportTablePdf } from '@/lib/pdf';
import { reportExport } from '@/features/pdf/report';

const doc = await pdfDocument({ title: `Self-billed invoice ${inv.number}`, generatedBy: fullName(me) });
doc.header({ title: 'Self-billed invoice', subtitle: weekLabel, meta: [['Invoice', inv.number], ['Due', due]] })
  .addressBlocks(supplier, customer)
  .lineTable(columns, lines)        // muted: true for "not paid" lines
  .totals([{ label: 'Total due', value: '£234.00', strong: true }])
  .signatureBlock(office, person)
  .footer(`Linear MCR Limited · Self-billed invoice ${inv.number}`)
  .save(`linear-hub-invoice-${inv.number}.pdf`);
reportExport('pdf', filename, lines.length, 'invoice');
```

P8's venue report: `exportTablePdf({ title, subtitle, filters, columns, rows, totals, filename })`, or a
`pdfDocument` with `heading` + `table(columns, rows)` per section. Money passed to `lineTable` / `totals` is already
text ("£1,234.50"); in `table`/`exportTablePdf` use the CSV formatters (or `kind`) and the PDF writes it as on screen.

## Logic

- **Where it runs.** On the device, in the browser. jsPDF 4.2.1 and jspdf-autotable 5.0.8 (exact versions in
  `client/package.json`) live in their own chunk (`engine-*.js`, about 430 kB, 140 kB gzipped), loaded on the first PDF
  and from then on reused; opening an Export menu starts the download early. The main chunk grew by 2.5 kB in all
  (472.19 → 474.72 kB; the review fixes add 1.96 kB, the transliteration tables file names use), under the 5 kB limit. jsPDF's optional `html()` helpers (html2canvas, DOMPurify, canvg) are emitted as chunks but
  never loaded.
- **Page.** A4, millimetres. Tables up to six columns portrait, seven or more landscape (`pdfOrientationFor`). Margins
  14 mm portrait, 12 mm landscape. Page 1: the brand band (the violet mark, "Linear Hub", and on the right "Linear MCR
  Limited" and "Generated Thu 22 Oct 2026, 15:04 by Danil Varianyk"), the title (17 pt), the subtitle, the filter lines
  and the row count, a hairline. Later pages: a slim running header (mark, "Linear Hub", the document title). Every
  page: "Linear Hub · <title>" and "Page x of y" under a hairline. Document metadata: title, author Linear MCR Limited,
  creator Linear Hub, language en-GB. The title and subject keep the real characters (`pdfInfoText`; jsPDF writes
  them as UTF-16 when needed), so a viewer's title bar shows "St Ann’s Square – events", not "St Ann™s Square Œ
  events"; the default footer is folded once, so it keeps ’ – … “ ”.
- **Table PDFs** show exactly the CSV's columns and rows (the rows on screen, in screen order, when the item was
  picked). Each cell starts from the CSV text and is written the way the screen writes it: money "£1,234.50"
  (`-£12.50`), dates "Wed 21 Oct 2026", local times "21 Oct 2026, 09:30", counts "1,240", percentages as the CSV has
  them. A text cell that is a bare ISO date or CSV timestamp is written as one too. Tables over twelve columns drop the
  weekday ("21 Oct 2026") so a date fits a narrow column. Numeric columns are right-aligned (header too). Body font 9 pt
  up to six columns, 8.5 (7–9), 7.5 (10–13), 7 (14–16), 6.5 pt beyond (the 19-column team pay table). The header row
  repeats on every page; a totals row (`pdfTotals`) prints once, at the end; a row never splits across pages; a table
  short enough to fit 40% of a page moves whole to the next page rather than split.
- **Titles from the file name** (`pdfHeadingFor`), so no call site changed: `leaderboard-week-sales` → "Leaderboard" ·
  "This week" · "Ranked by sales"; `gauges-by-user-deansgate` → "Gauges by person" · "Team: Deansgate";
  `gauges-jordan-lee-entries` → "Gauge entries"; `team-directory-on-leave` → "Team directory" · "Status: On leave";
  `candidates-open` → "Candidates" · "Open candidates"; `event-…` → "Event gauges"; `payslips`, `team-pay`,
  `weekly-money-flow`, `finance-by-campaign`, `runs-to-pay`, `expenses`, `hired`; anything else sentence-cased. The
  subtitle is the page heading exactly as on screen ("Finance", "Jordan Lee", "Volt Energy — Manchester Business
  Park"), left out when the title already says it ("Gauges", "Team", "Leaderboard"); a name the subtitle shows is not
  repeated as a filter. The file name's date range becomes "1 – 21 Oct 2026"; a single date that is just today's
  file stamp is left out (the generated line has it). Filters set on screen beside the button are added
  (`screenFilters`, see ExportButton); a file-name line with the same label gives way to the screen's exact wording
  ("Team: St Ann’s" rather than the slug's "Team: St Ann S"), the date range stays last, a line is printed once.
- **Text the built-in font can draw** (`toPdfText`). jsPDF's Helvetica speaks WinAnsi; one character outside it turns
  the whole line into spaced-out gibberish. So Latin-1 stays as it is, the WinAnsi marks (– — … ‘ ’ “ ” • € ™) are
  passed as their bytes (with their real widths, so wrapping and right alignment stay true), accents outside Latin-1
  are stripped ("Łukasz" → "Lukasz"), Cyrillic and Greek are spelled in Latin letters (a plain spelling close to
  BGN/PCGN: "Иван Петров" → "Ivan Petrov", "Юлия Щербакова" → "Yuliya Shcherbakova", "Γιώργος Παπαδόπουλος" →
  "Giorgos Papadopoulos"), symbols folded ("→" → "->", "−" → "-", "≥" → ">="), unusual spaces become a space, control
  and zero-width characters go, and anything else (emoji, Chinese, Arabic…) prints "?". File names use the same
  folds in plain ASCII (`asciiFold`: "Łukasz O’Brien–Ștefan" → `lukasz-o-brien-stefan`, "Straße" → `strasse`).
- **Formula guard** (`pdfSafeText`): as in the CSV, a cell starting with `=`, `+`, `-`, `@`, tab or CR gets an
  apostrophe in front unless it is only digits, signs, currency and separators (numbers, money, phone numbers such as
  "+44 7700 900123" keep their sign), so a table copied out of the PDF into a spreadsheet cannot run a formula. The
  guard looks at the text **as printed** (after `toPdfText`, and again with leading spaces taken off), so a zero-width
  space, word joiner, BOM or soft hyphen in front, a minus sign "−" or hyphen "‐" (printed "-") or a full-width "＝"
  cannot carry a formula past it. Every PDF block uses it: table cells, `lineTable`, `keyValues`, `totals`.
- **Audit PDF**: with `total` and `query` from the page, every entry that matches its filters (newest first, up to
  2,000: about 55 A4 pages, made in about a second), read 200 at a time; an entry pushed to the next page by new
  activity while they are read is printed once. Without them, the entries on screen (50). Columns: When (local time),
  Who ("Linear Hub" for automatic steps), What happened, Record ("Pay run #123"), Changes (shared `auditChangeText`,
  up to four fields). The audit report's `rows` is the number of entries in the file.
- **Exports made without signal** (`report.ts`): the report waits in `localStorage` under
  `lm-export-reports:<userId>` (at most 100, oldest dropped first) and is sent, oldest first and one at a time, when
  the window says it is online again, when `api/client.ts` announces an answer after a failed request, after the
  next export that gets through, and when a page with an export button opens. Before sending it checks `GET
  /auth/me`: only that person's session sends their reports (someone else signed in on the same phone sends nothing).
  The audit row is stamped when the report arrives; the file name keeps the day the file was made.
- **Progress PDF**: read through the same React Query keys the page uses (cache first), so the server's scoping is
  unchanged (a leader can download only their own team's people, as on screen). The checklist (lesson, learned,
  self-check score, teach-back sent, signed off by whom; lessons not started in grey), "Next level: …" with each
  requirement met or not and where things are, and the required videos that apply to that person.
- **Tests**: `shared/src/logic/exportFormat.test.ts` (hand-worked fixtures: money, counts, dates on known weekdays,
  ranges across months and years, WinAnsi folding, the formula guard, cells, alignment, file names, every current CSV
  file name's heading). `server/src/test/pdf-export.test.ts` runs the real `render.ts` + `csv.ts` under Node with jsPDF
  and reads the files back byte by byte: header and `%%EOF`, every xref offset on its object, trailer, page count and
  A4 size (portrait / landscape), and the inflated text of each page — brand header, cells as on screen, header row on
  every page, totals once, "Page x of y", running headers, formula guard, folded characters, no 16-bit strings, the
  invoice blocks (P2), page flow, `needs()`, identical bytes on a second save; the review fixes (a title with ’ and
  – in the footer and in the document properties, hidden formulas in table cells and page blocks, Cyrillic and Greek
  names, file names, the required-video counts with P5's response shapes); plus the audit-event route contract.

## User guide

- **Export ▾** (every table that had **Export CSV**: Gauges, a person's gauges and entries, an event's gauges, the
  Leaderboard, Team, Campaigns, Recruitment's list and Hired column, Finance → My pay / Team pay / Company): pick
  **CSV** for a spreadsheet that opens in Excel, or **PDF** to print or share. The PDF holds exactly the rows on screen,
  with the filters set on screen (team, position, search…) and the date range under the title, money and dates written
  as on screen, and "Page 1 of 3" at the foot of each page. Wide tables print on landscape pages. On a phone the button
  shows just the download icon.
- **Audit → Download PDF**: every entry that matches the filters, newest first (up to 2,000) — who did what and when,
  the record and what changed. (Until the Audit page passes its filters to the button, it is the 50 entries on
  screen.)
- **Learning → Progress → Download PDF** (your own, or a person's from My team / Everyone): the COD pack checklist,
  what the next level needs, and the required videos.
- The first PDF of a visit takes a second or two while the PDF maker downloads (about 140 kB over the network); after
  that PDFs are instant. Offline, the CSV still works, and so does the PDF once the PDF maker has loaded on that
  visit; otherwise the PDF asks you to connect.
- Every download — CSV or PDF — is recorded in the audit trail with what, how many rows and the file name, including
  downloads made without signal: they are recorded when the phone is back online.

## Owner notes

- PDFs are made on the phone or laptop, not on the server: nothing extra is stored, and the "Generated" time is the
  device's clock.
- The built-in PDF font covers English and Western European letters. Other accents are stripped (Polish "Ł" → "L",
  Romanian "Ș" → "S"), Cyrillic and Greek names are spelled in Latin letters ("Иван Петров" → "Ivan Petrov"), and
  emoji and other scripts (Chinese, Arabic…) print as "?". **Decide before the self-billing invoices ship (P2 draws
  them with these blocks):** is a Latin spelling acceptable on an invoice, or should we embed a font that prints every
  name exactly (each PDF about 100–300 kB larger)?
- The audit PDF holds every entry that matches the filters, up to 2,000 (filter by person, record or dates for a
  longer period) — once the Audit page passes its filters to the button (a one-line change for P9 / the lead, in API
  above); until then it is the 50 entries on screen.
- Downloads made without signal are recorded when the phone is back online (stamped then; the file name keeps the
  day). If someone clears the browser's data first, or more than 100 wait, the oldest are lost.
- The Xero / Sage **Export for payroll** file is unchanged (an import file for payroll software, so no PDF).
- Decision for the owner (optional): the PDF tables use the same columns as the CSVs. If a printed version should
  leave out a column (e.g. the payroll Reference), tell us which and we'll trim the PDF only.
