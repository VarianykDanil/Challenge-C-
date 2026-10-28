# Working agreement for parallel work packages

Linear Hub is built by one developer at Noryn System Ltd directing AI coding agents (see [`TEAM.md`](TEAM.md)). Each
release is split into work packages that are built at the same time, each in its own git worktree and branch. This
page is the agreement they all work to: the conventions, and the contracts between the parts of the code, so that
packages built side by side fit together when they are merged.

**Ownership.** Every package brief lists the files that package may change. A package that truly needs a small change
outside its list makes the smallest change it can and says so in its notes, so the merge can check it. Comments in the
code that say a file is "owned by" a role or a package code (P1–P9, L2, U5 and so on) are history from earlier
releases, not people: [`MAINTAINERS.md`](MAINTAINERS.md) explains them.

**Shared and frozen:** `shared/src/types.ts` (add optional fields only, and say so in the package notes).

## Conventions
- TypeScript strict everywhere. ESM. Relative imports inside a package; `@lm/shared` across packages (`import { funnelRatios, type User } from '@lm/shared'`). Inside `shared/`, import with explicit `.ts` extensions.
- Client path alias `@/` → `client/src/`.
- Styling: Tailwind v4 utility classes with the **semantic tokens** defined in `client/src/index.css` (`bg-surface`, `bg-surface-2`, `text-fg`, `text-muted`, `border-border`, `bg-primary`, `text-primary`, `bg-accent`, `text-success`, `text-danger`, `text-warning`, `text-info`, `bg-bg`). Never hard-code hex colours in pages. Light and dark themes must both work (`.dark` on `<html>`).
- Money: `formatGBP()` from `client/src/lib/format.ts`. Dates: `date-fns`.
- Data fetching: TanStack Query via hooks in `client/src/api/hooks.ts`; raw fetch wrapper in `client/src/api/client.ts` (credentials: include, throws `ApiError`).
- Icons: `lucide-react`. Charts: `recharts` wrapped by `client/src/components/charts`.
- Accessibility: every interactive element keyboard reachable, labelled inputs, visible focus rings, colour never the only signal.
- Commit messages: imperative mood, scoped (`server: add payroll summary`).

## Layout contract (layout ⇄ pages)
`client/src/components/layout/AppShell.tsx` exports:
```tsx
export interface AppShellProps { user: UserWithTeam; onLogout: () => void; children: React.ReactNode }
export function AppShell(props: AppShellProps): JSX.Element
```
It renders the sidebar (navigation filtered by `user.role` using `NAV_ITEMS` from `client/src/components/layout/nav.ts`),
topbar (search slot, theme toggle, user menu) and `<main>` with `children`. Pages render inside with
`<PageHeader title description actions />` from the UI kit at the top.

## UI kit contract (UI kit ⇄ everyone)
Components exported from `client/src/components/ui/index.ts` keep the prop names in the skeleton files.
Pages may ask for additions; the UI kit adds them, keeping existing prop names.

## Charts contract (charts ⇄ pages)
Components exported from `client/src/components/charts/index.ts` keep the prop names in the skeleton files.

## Definition of done
- `npm run typecheck`, `npm test`, `npm run smoke -w server` and `npm run build` pass in `linear-micro-crm/`.
- A test that failed before the change passes after it (for anything that can be tested).
- Both themes checked at phone and laptop sizes; no console errors.
- The package's notes (`docs/fragments/<release>-<package>.md`) say what changed, for users, the owner and developers.

## Auth contract (sign-in ⇄ pages)
`client/src/auth/AuthProvider.tsx` exports `AuthProvider` and `useAuth(): { user, loading, login(input), logout(), refresh() }`.
`client/src/api/hooks.ts` exports `useDemoAccounts()` → `{ accounts: { label, role, email, employeeId }[] }`.
`client/src/pages/Login.tsx` exports `LoginPage()` and uses both. `client/src/pages/About.tsx` exports `AboutPage()`.

## Chart colour tokens
`--color-chart-1 … --color-chart-6` are defined in `client/src/index.css` and used by the charts via `var(--color-chart-n)`.
