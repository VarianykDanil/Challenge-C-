# Release 1.2 docs fragments

Each 1.2 package writes its documentation here instead of editing `docs/LOGIC.md`, `docs/API.md` or
`docs/USER_GUIDE.md`; a later step merges the fragments into the placeholders those files already carry
(LOGIC.md §15, API.md "1.2 endpoints", USER_GUIDE.md "What's new in 1.2").

| Package | Fragment |
| --- | --- |
| r2-foundation (contracts) | `r2-foundation.md` |
| L1 learning-pack | `L1-learning-pack.md` |
| L2 learning-pitch | `L2-learning-pitch.md` |
| U1 sign-in-pin | `U1-sign-in-pin.md` (plus `docs/DEPLOY.md`, owned by U1) |
| U2 bulk-entry | `U2-bulk-entry.md` |
| U3 audit-trail | `U3-audit-trail.md` |
| U4 check-ins | `U4-check-ins.md` |
| U5 office-tools | `U5-office-tools.md` |

Each fragment has three sections:

- `## API` — endpoints, request and response shapes, role scoping, status codes, caching.
- `## Logic` — formulas, thresholds and edge cases (British English, specific numbers).
- `## User guide` — what each role sees, in plain words, with buttons named exactly as they appear in bold.
