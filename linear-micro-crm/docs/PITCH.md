# Linear Hub — the case for Linear MCR

*For the owner. Ten minutes to read. Every number that is an estimate says so, and says how we arrived at it.*

---

## In one paragraph

Linear MCR already runs on numbers: six gauges per rep per event, judged against the law of averages, and a pay plan that turns those gauges into a weekly wage. What the business does not have is a place where those numbers live. They are collected on paper and in WhatsApp, tallied by hand, and answered from memory. Linear Hub is that place. Every employee signs in with their work email and employee ID and sees their own gauges, ratios, pay and position on the ladder. Leaders see their team. The office sees recruitment and finance. Nothing about how Linear sells changes; what changes is how long it takes to know what happened.

---

## Where the time goes today

| Question | How it is answered now | What it costs |
|---|---|---|
| "How did the team do yesterday?" | Each rep messages six numbers to the leader; the leader retypes and adds them up. | Leader time every evening; mistakes in transcription; no history anyone can search. |
| "Which part of Jordan's pitch needs work?" | Gut feel, or working out ratios by hand at the end of the week. | Coaching arrives late and is general rather than specific. |
| "How many of last month's applicants reached observation day? Where did the good ones come from?" | Nobody knows without reading back through notes. | Recruitment spend goes where it always has, not where the hires come from. |
| "What am I being paid this week, and when?" | Ask the leader, who asks the office. | Interruptions for the office; uncertainty for the rep; late payments noticed late. |
| "Was Priya's team on time this month?" | Nobody is recording it. | Punctuality cannot be coached or rewarded because it cannot be seen. |

---

## What Linear Hub does

**For a rep.** Sign in on your phone. Your dashboard shows this week's stops, sales and conversion, how that compares with last week, your rank, your earnings to date and your next payday. After an event you log six numbers; the form will not let you enter more presentations than people at the table. Your ratios light up green or amber against the company benchmarks, so you know which stage to work on before anyone has to tell you. Your payslip is itemised: days, commission, bonus, deductions.

**For a leader.** Create the week's events against the right campaign. Log a day for anyone on your team if they cannot. See the team funnel, every member's ratios side by side, and who moved up or down the leaderboard. See whether your team's pay runs went out on time. Post an announcement that everyone sees on their dashboard.

**For the recruiter.** Every candidate on one board: Applied → Phone screen → Interview → Observation day → Offer → Hired. Who owns them, where they came from, what the next action is and whether it is overdue. Move someone to *Hired* and their employee record is created on the spot. See conversion by source and the average time from application to first day.

**For the office.** Campaigns with what the client pays per sale and what the rep earns. Weekly pay runs calculated from the pay plan, marked paid in one click, with the on-time rate tracked. Expenses by category and campaign. Revenue, payroll, expenses and margin by week and by campaign.

---

## What changes

The figures below are **estimates, not promises**. Each one says how we arrived at it and how the pilot will check it.

| Outcome | What we expect | How we got the number | How we will know |
|---|---|---|---|
| **Leader admin time** | **1.5–2.5 hours saved per leader per week** *(estimate)* | A leader with five or six reps collects six gauges from each after every event, retypes them and tallies the team. We put that at 20–30 minutes per event day and five event days a week. Logging in Linear Hub takes the rep under a minute and the leader nothing. | Ask pilot leaders to note their evening admin time for one week before and the two weeks during. |
| **Faster, more specific coaching** | Leaders can name the weak stage for every rep **the same day**, not at the end of the week | Ratios are computed on every entry and shown against the benchmarks. Today they are worked out by hand, if at all. | Count coaching conversations in the pilot that start from a named ratio. Aim: most of them. |
| **Recruitment visibility** | Within four weeks Linear knows **conversion by source and time to hire** — numbers it does not have today | Every stage change is recorded with a timestamp; the summary is computed from them. | The recruitment summary page is populated and the office has used it to decide where to post next. |
| **Payroll accuracy** | **Fewer pay queries**, and the ones that remain are answered from the payslip | Every run is calculated by the same formula from the pay plan (base per day + commission + bonus + overrides − deductions) and itemised. | Count pay queries to the office per week before and during the pilot. |
| **Payroll punctuality** | **95% or more** of pay runs paid on or before the due date *(target, not a baseline — the baseline is unknown today)* | The on-time rate is tracked per run and summarised weekly. | Visible on the finance page from the first pay run. |
| **Rep punctuality** | Lateness becomes **visible and coachable** per rep | Check-in time is compared with the event start with a five-minute grace period. | Punctuality rate appears on each rep's dashboard and performance view. |

What we are *not* claiming: that the platform sells more. The gauges and the pitch do that. The platform makes the gauges honest and quick to see.

---

## What it costs to run

- **No licences and no per-seat fees.** Everything in Linear Hub is open-source software; there is nothing to subscribe to.
- **One small server.** The whole application — API, database and web app — runs on a single modest machine (or, to start, a spare laptop in the office). The database is one SQLite file.
- **Back up the file.** Copy it somewhere safe nightly. That is the entire backup strategy for version 1.
- **Nothing leaves your control.** No third-party analytics, no external services, no data sent anywhere.

---

## Rollout plan

**Week 0 — prepare.** The office sends the employee list, pay plans and campaign payouts (see below). We load them and check the first week's pay runs against what the office actually paid. Admins get a thirty-minute walkthrough.

**Weeks 1–2 — pilot one team.** One crew leader and their team (six to eight people) use Linear Hub for every event, alongside the existing WhatsApp routine so nothing is lost. Thirty minutes with the leader at the start; a five-minute message to the reps. We watch three things: does every rep log every event day; does the leader stop retyping; do the pay runs match.

**End of week 2 — review.** Three questions with the owner: Did logging stick? Did the leader's evenings get shorter? Did anything in the numbers surprise us? Fix what needs fixing.

**Weeks 3–4 — all teams.** Roll out team by team, one leader walkthrough each. Recruitment moves onto the board the same fortnight.

**Week 6 — retire the old routine.** WhatsApp stays for conversation; gauges, pay and candidates live in Linear Hub only.

---

## What we need from the business

1. **The employee list** — name, work email, employee ID, role (admin, leader, recruiter or rep), position on the ladder, team, start date and pay plan.
2. **The pay plans** — for each position: base per day, commission per sale, the weekly sales threshold and bonus amount, and the leader override per team sale.
3. **Campaign payouts** — for each live campaign: what the client pays per confirmed sale and the default rep commission.
4. **A decision on administrators** — who in the office can create users, edit campaigns, mark payroll paid and record expenses.
5. **An owner for payday** — one person who marks runs paid each week. It is one click, but it needs to be someone's job.
6. **Thirty minutes per leader** during their rollout week.

---

## Questions we expect

**Is the data secure?**
Each person signs in with their work email and employee ID; the session is an httpOnly cookie that the browser cannot leak to scripts. Access is by role: a rep sees only their own gauges and pay, a leader their own team, a recruiter the pipeline, and only administrators see everything. The database is a single file on a server you control; nothing is sent to a third party. We are honest about the limit: email plus employee ID is a light credential, suitable for a known team on version 1. Employee IDs should be treated as private, and single sign-on is on the roadmap for when the company has managed accounts for everyone.

**Does it work on phones?**
Yes. It is built for a rep standing in a car park: responsive layout, large tap targets, a dark theme, and nothing that needs a desk. Offline logging for venues with poor signal is first on the roadmap after the pilot.

**Can we get the data out?**
The office views show everything, and the database is a standard SQLite file that any spreadsheet-friendly tool can open. CSV export from within the app (gauges, pay runs, candidates) is the first roadmap item.

**What if someone logs the wrong numbers?**
The form rejects impossible funnels (you cannot have more sales than taps). Leaders and administrators can correct or delete an entry, and every entry carries the time it was submitted.

**What happens when someone leaves?**
Their status is set to *left*. They can no longer sign in; their history stays so the numbers still add up.

**Who owns the data?**
Linear MCR Limited. It is your file on your server.

**How long does it take to learn?**
A rep: under five minutes. A leader: half an hour. The office: an hour, most of it on pay plans.

---

*Linear Hub v1.0.0 — © Linear MCR Limited, internal use.*
