# Roadmap

Version 1.0.0 does the job the business asked for: gauges, pay, progression, recruitment and finance behind one sign-in, for four roles — rep, leader, recruiter and administrator. This is what comes next, in the order we would do it. Items move between columns on evidence from the pilot (see [`PITCH.md`](PITCH.md)), not on opinion.

**How something makes the list.** It must remove a question somebody at Linear asks every week, or remove a piece of paper, or protect the data. If it does none of those, it waits.

**Already in 1.0, so not on the list.** Coaching sentences built from the ratios (on the dashboard and the Gauges page), the login rate limit, immediate sign-out when someone leaves, employee IDs hidden from everyone but the office, automatic pending pay runs when a week closes, and events going live by themselves at their start time.

---

## Now — the first weeks after the pilot

| Item | Why | Notes |
|---|---|---|
| **Sign-in PIN** | Email plus employee ID is a light credential. A personal PIN the office can reset closes the gap while the company has no managed accounts. | Set on first sign-in; the existing rate limit and session revocation stay. Keeps the no-password simplicity for reps on a phone. |
| **CSV export** for gauges, pay runs and candidates | The office still needs figures in a spreadsheet for the accountant and for client reports. | Respect role rules: you can only export what you can see. Date-range filtered. |
| **Payday notifications** | "Have I been paid?" is the most common question. Tell people, do not make them look. | In-app first (announcement-style banner on the dashboard); email or push once we have addresses and consent. Fires when a pay run is marked paid, and the day before `dueDate` if still pending. |
| **One-tap check-in** at an event | Punctuality is only as good as the check-in data. The **Log gauges** form already has a **Now** button for the check-in time; this makes it a single tap on arrival, without opening the form. | Records `checkedInAt` on the day's entry; the five-minute grace rule already exists. |
| **Leader bulk gauge entry** | Leaders often collect the whole team's numbers at the end of the day. One screen, one row per rep, one save. | Validates every row against the funnel rule before submitting; same event-date and own-team rules as the single form. |
| **Announcement read receipts** | Leaders want to know the message landed. | Count of people who opened it, no names on the public view. |
| **Audit trail for pay and stage changes** | When a payslip is queried, show who changed what and when. | Stage changes already keep history; extend to payroll (who marked it paid) and gauge edits. |

## Next — the following quarter

| Item | Why | Notes |
|---|---|---|
| **Mobile PWA with offline gauge logging** | Private sites and event halls have poor signal. Reps should be able to log the day and sync later. | Installable, works offline, queues the save and replays it on the `(eventId, userId, date)` key, so a replay updates rather than duplicates. |
| **Marking a transfer as failed from the app** | Today a bounced payment can be marked paid again from **Runs to pay**, but flagging it as failed in the first place is not a button. | One action on the run, with a reason; keeps the on-time maths unchanged. |
| **New-starter documents with e-signing** | Hiring currently ends with paperwork in a folder. Contract, right-to-work checklist and policies, signed on a phone, attached to the employee record. | Triggered when a candidate is hired. Store signed PDFs, not just a flag. |
| **Interview scheduling with calendar invites** | Observation days get missed when they live only in a message thread. | Send `.ics` to candidate and interviewer; mark no-shows from the same screen. |
| **Client reporting portal** | Clients ask for weekly numbers on their campaign. Give them a read-only page instead of a spreadsheet by email. | Scoped to one campaign, no personal data about reps, revocable link. |
| **Progression tracker** | Make the ladder visible: what a trainee needs to reach field rep, and how close they are. | Criteria defined by the business; we show distance to target, not a verdict. |

## Later — when the business asks for it

| Item | Why | Notes |
|---|---|---|
| **Single sign-on** (Microsoft 365 or Google Workspace) | Replaces email + employee ID (or PIN) once the company has managed accounts for everyone. | Keep employee ID as the display identifier. |
| **Accounting export** (Xero or Sage) | Push approved pay runs and expenses straight into the ledger. | Only after the audit trail is in place. |
| **Multi-office support** | If Linear opens a second city, teams and events need an office dimension. | Mostly a data-model change plus filters. |
| **Partner API tokens** | Let a client or a payroll provider pull data without a user session. | Scoped, expiring tokens; rate-limited. |
| **Automated backups to cloud storage** | The database is one SQLite file; copy it somewhere safe on a schedule. | Nightly snapshot with 30-day retention is enough. |

---

## Not planned

- **Replacing WhatsApp for chat.** Linear Hub is for records, not conversations. Announcements cover the one-to-many case.
- **Timesheets or GPS tracking.** The check-in timestamp answers the punctuality question; tracking people's location does not earn its place.
- **A native app store app.** The PWA gets us offline and an icon on the home screen without two more codebases.
