# Roadmap

Version 1.1.0 adds the smart release to what 1.0 did — pace notes, pay estimates, check-in lists, the Needs-attention feed, event forecasts, signal-proof logging, recruitment deadlines, nightly backups and the weekly review — on top of gauges, pay, progression, recruitment and finance behind one sign-in for four roles (rep, leader, recruiter and administrator). This is what comes next, in the order we would do it. Items move between columns on evidence from the pilot (see [`PITCH.md`](PITCH.md)), not on opinion. What each release changed is in [`CHANGELOG.md`](../CHANGELOG.md).

**How something makes the list.** It must remove a question somebody at Linear asks every week, or remove a piece of paper, or protect the data. If it does none of those, it waits.

**Already shipped, so not on the list.** In 1.0: coaching sentences built from the ratios (on the dashboard and the Gauges page), the login rate limit, immediate sign-out when someone leaves, employee IDs hidden from everyone but the office, automatic pending pay runs when a week closes, and events going live by themselves at their start time. Since 1.0: **CSV export** on every data table and a printable payslip; optional **two-step verification**; **payday notifications** (due tomorrow, overdue and "You've been paid …" in the bell and the **Needs attention** card); the offline part of the old "PWA" item — **gauge saves kept on the phone** when the signal drops and replayed safely on the `(eventId, userId, date)` key, today's event preselected, a **Checking in? Use now** button and a live tally; **nightly backups** on the server laptop with a guarded restore; bulk **Mark paid** with payroll checks; event forecasts and suggested targets; recruitment deadlines that set themselves; the weekly review; running in the background as a service; compressed responses for the hotspot.

---

## Now — the first weeks of 1.1

| Item | Why | Notes |
|---|---|---|
| **Sign-in PIN** | Email plus employee ID is a light credential, and it matters more now that phones on a hotspot reach the server. Two-step verification exists but is optional; a personal PIN the office can reset closes the gap for everyone while the company has no managed accounts. | Set on first sign-in; the existing rate limit, session revocation and two-step verification stay. Keeps the no-password simplicity for reps on a phone. |
| **One-tap check-in** at an event | Punctuality is only as good as the check-in data. 1.1's **Checking in? Use now** button still lives inside the **Log gauges** form; arriving should be one tap. | A separate `check_ins` table stamped by the server clock (not the phone's), and an **I'm here** button on today's event card; the five-minute grace rule already exists. |
| **Leader bulk gauge entry** | Leaders often collect the whole team's numbers at the end of the day. One screen, one row per rep, one save. | `POST /gauges/bulk` in one transaction; validates every row against the funnel rule; same event-date, own-team and paid-week rules as the single form; paste-to-log from WhatsApp lines; goes through the 1.1 outbox when the signal drops. |
| **Audit trail for pay and stage changes** | When a payslip is queried, show who changed what and when. | Stage changes already keep history; extend to payroll (who marked it paid, bulk or single, shown on the payslip) and gauge edits. Then pay adjustments and disputes on top of it. |
| **Announcement read receipts** | Leaders want to know the message landed. | "Seen by N", no names on the public view; with edit, unpin and expiry for announcements. |

## Next — the following quarter

| Item | Why | Notes |
|---|---|---|
| **Ask Linear Hub** (assistant, rules mode) | Owners and leaders want to ask "why was Tuesday quiet?" and get an answer in the same voice as the weekly review. | Deterministic and role-scoped: answers only from facts the person can already see, built by the same rules as the review; private lines and check-in names never leave their owner. |
| **Command palette search** | The **Go to page…** box (⌘K / Ctrl+K) only finds pages. People want to jump to a person, an event or a candidate. | `GET /api/search`, role-scoped like every other read; the same box, results grouped by kind. |
| **Optional Claude mode for the assistant** | Free-text questions the rules cannot phrase well. | Opt-in, behind a new `ANTHROPIC_API_KEY` setting and its own switch; falls back to rules mode; per-user and daily caps; the model words the rule-based facts, never calculates them; works without it. |
| **Marking a transfer as failed from the app** | A bounced payment shows up in **Runs to pay** and the review, but flagging it as failed in the first place is still not a button. | One action on the run, with a reason; keeps the on-time maths unchanged. Needs the audit trail. |
| **HTTPS on the LAN, then an installable app** | 1.1 keeps saves on the phone while the page is open; an icon on the home screen and an app that opens without signal need a secure address. | A local certificate or a free tunnel unlocks the service worker, offline app open and the install prompt; the outbox stays the source of truth for saves. |
| **Phone polish pack** | It is used on phones over a hotspot. | Self-hosted fonts, a manifest and PNG icons, 44 px targets everywhere, safe areas, a board fallback on narrow screens. |
| **The review, delivered on Monday** | The review is ready on Monday morning; people should not have to open the app to see it. | In-app first; push or email once we have HTTPS and consent. Private lines only to their owner. |
| **Smart scheduling defaults** | Leaders re-type the same events every week. | A "same as last time" chip, clash and duplicate warnings, repeat-event scheduling. |
| **Weekly team targets with pace** | Leaders want to know on Thursday whether the week will land. | "On pace for 54 of 60 by Sunday" on the leader card, an estimate with its range like every forecast. |
| **Finance needs-attention rules and a pay-week close preview** | The owner wants loss weeks and Sunday-evening payroll surprises spotted early. | Loss weeks, low margins, missing recurring and duplicate expenses, a week-ahead cash estimate; Sunday-evening estimated runs with the people who still have unlogged days. |
| **Entry-time plausibility nudges** | A mistyped 600 instead of 60 is easiest to fix while the form is open. | "Double-check?" when a day is far outside the person's own usual; never blocks the save. |
| **Stage attribution and context benchmarks** | "Your conversion dropped" should say which stage and compare with the company's actual, not only the law of averages. | "What changed and why" on conversion; a company-actual benchmark beside the fixed ones. |
| **New-starter documents with e-signing** | Hiring currently ends with paperwork in a folder. Contract, right-to-work checklist and policies, signed on a phone, attached to the employee record. | Triggered when a candidate is hired. Store signed PDFs, not just a flag. |
| **Interview scheduling with calendar invites** | Observation days get missed when they live only in a message thread. | Send `.ics` to candidate and interviewer, with clash checks; outcomes recorded from the same screen (the 1.1 outcome prompt already asks). |
| **Client reporting portal** | Clients ask for weekly numbers on their campaign. Give them a read-only page instead of a spreadsheet by email. | Scoped to one campaign, no personal data about reps, revocable link; can reuse the campaign lines of the review. |
| **Progression tracker** | Make the ladder visible: what a trainee needs to reach field rep, and how close they are. | Criteria defined by the business; we show distance to target, never a verdict (same copy rules as LOGIC §14.0). |

## Later — when the business asks for it

| Item | Why | Notes |
|---|---|---|
| **Single sign-on** (Microsoft 365 or Google Workspace) | Replaces email + employee ID (or PIN) once the company has managed accounts for everyone. | Keep employee ID as the display identifier; two-step stays for anyone outside SSO. |
| **Off-site backup copies** | 1.1 takes nightly backups on the same laptop; a second copy elsewhere protects against losing the laptop. | Encrypted copy to cloud storage on a schedule; the guarded restore already exists. |
| **Accounting export** (Xero or Sage) and a bank-ready payment file | Push approved pay runs and expenses straight into the ledger, and pay Friday's runs from one file. | Only after the audit trail is in place. |
| **Roster / assignment table** | Who works which event. Forecasts and "not logged yet" are inferred today; a roster makes them exact. | Unlocks a hiring-needs forecast and exact attendance. |
| **Calendar export** | Reps want their events in their phone's calendar. | `.ics` downloads, then a personal subscription link. |
| **Offer letter, onboarding checklist and expense receipts** | Less paper after a hire and after a day out. | Receipts by phone camera; leader expense claims with approval. |
| **Recruitment source attribution** | Which job boards actually produce hires. | Cost per hire, sources ranked with honest small-number handling, a hire forecast. |
| **Event-day live board** | A big-number board on a tablet at the venue for the leader's huddle. | Read-only, team-scoped, works on the hotspot. |
| **Personal data tools** | GDPR: export someone's data, anonymise on leave, retention sweeps. | Admin-only, logged in the audit trail. |
| **System health page and ops tooling** | Know the laptop is healthy without a terminal; update safely. | Structured logs, an integrity watchdog, a config file, a new `npm run update` script, scripted releases with the changelog. |
| **Quality** | Keep phone and desktop working as the app grows. | Playwright phone/desktop tests with an accessibility check; dependency upgrades. |
| **Multi-office support** | If Linear opens a second city, teams and events need an office dimension. | Mostly a data-model change plus filters. |
| **Partner API tokens** | Let a client or a payroll provider pull data without a user session. | Scoped, expiring tokens; rate-limited. |

---

## Not planned

- **Replacing WhatsApp for chat.** Linear Hub is for records, not conversations. Announcements cover the one-to-many case, and the weekly review is made to be pasted into the group.
- **Timesheets or GPS tracking.** The check-in timestamp answers the punctuality question; tracking people's location does not earn its place.
- **A native app store app.** An installable web app gets us offline and an icon on the home screen without two more codebases.
