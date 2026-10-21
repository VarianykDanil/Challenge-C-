# Release 1.3 docs fragments

Each 1.3 package writes its documentation here instead of editing `docs/LOGIC.md`, `docs/API.md`,
`docs/USER_GUIDE.md`, `docs/ROADMAP.md`, `README.md` or `CHANGELOG.md`; the lead merges the fragments into those files.

| Package | Fragment |
| --- | --- |
| r3-foundation (contracts) | `r3-foundation.md` |
| P1 pay-rule | `P1-pay-rule.md` |
| P2 invoices | `P2-invoices.md` |
| P3 statements | `P3-statements.md` |
| P4 pdf-everywhere | `P4-pdf-everywhere.md` |
| P5 learning-videos | `P5-learning-videos.md` |
| P6 client-portal | `P6-client-portal.md` |
| P7 recruitment-plus | `P7-recruitment-plus.md` |
| P8 venue-insights | `P8-venue-insights.md` |
| P9 audit-everything | `P9-audit-everything.md` |

Each fragment has four sections:

- `## API` — endpoints, request and response shapes, role scoping (every role, the client role and anonymous),
  status codes, caching.
- `## Logic` — formulas, thresholds and edge cases (British English, specific numbers, worked examples).
- `## User guide` — what each role sees, in plain words, with buttons named exactly as they appear in bold.
- `## Owner notes` — anything Matt must know or decide.
