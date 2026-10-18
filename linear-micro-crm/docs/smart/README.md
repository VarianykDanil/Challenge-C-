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
