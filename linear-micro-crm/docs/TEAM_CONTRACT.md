# Team working agreement

Linear Hub is built by a five-person squad. Each member owns a slice of the codebase; nobody edits
another member's files without agreeing first (the integrator merges and resolves conflicts).

| # | Member | Role | Owns |
|---|---|---|---|
| 1 | **Backend Developer** | Software development | `server/**`, `docs/API.md` (implements it exactly; may append notes) |
| 2 | **Frontend Developer** | Software development | `client/src/pages/**` (except `Login.tsx`, `About.tsx`), `client/src/api/**`, `client/src/auth/**`, `client/src/lib/**`, `client/src/App.tsx`, `client/src/main.tsx` |
| 3 | **Marketing & Content** | Marketing | `README.md`, `docs/TEAM.md`, `docs/PITCH.md`, `docs/USER_GUIDE.md`, `docs/ROADMAP.md`, `client/src/content/**`, `client/src/pages/About.tsx` |
| 4 | **Product Designer (Brand & UI)** | Design | `client/src/index.css`, `client/index.html`, `client/public/**`, `client/src/components/ui/**`, `client/src/components/layout/**`, `client/src/components/brand/**`, `client/src/pages/Login.tsx`, `docs/DESIGN.md` |
| 5 | **Logic Builder (Data & Charts)** | Design / logic | `shared/src/logic/**`, `shared/src/constants.ts`, `client/src/components/charts/**`, `docs/LOGIC.md` |

Shared and frozen: `shared/src/types.ts` (add optional fields only; report any change).

## Conventions
- TypeScript strict everywhere. ESM. Relative imports inside a package; `@lm/shared` across packages (`import { funnelRatios, type User } from '@lm/shared'`). Inside `shared/`, import with explicit `.ts` extensions.
- Client path alias `@/` → `client/src/`.
- Styling: Tailwind v4 utility classes with the **semantic tokens** defined in `client/src/index.css` (`bg-surface`, `bg-surface-2`, `text-fg`, `text-muted`, `border-border`, `bg-primary`, `text-primary`, `bg-accent`, `text-success`, `text-danger`, `text-warning`, `text-info`, `bg-bg`). Never hard-code hex colours in pages. Light and dark themes must both work (`.dark` on `<html>`).
- Money: `formatGBP()` from `client/src/lib/format.ts`. Dates: `date-fns`.
- Data fetching: TanStack Query via hooks in `client/src/api/hooks.ts`; raw fetch wrapper in `client/src/api/client.ts` (credentials: include, throws `ApiError`).
- Icons: `lucide-react`. Charts: `recharts` wrapped by `client/src/components/charts`.
- Accessibility: every interactive element keyboard reachable, labelled inputs, visible focus rings, colour never the only signal.
- Commit messages: imperative mood, scoped (`server: add payroll summary`).

## Layout contract (Designer ⇄ Frontend)
`client/src/components/layout/AppShell.tsx` exports:
```tsx
export interface AppShellProps { user: UserWithTeam; onLogout: () => void; children: React.ReactNode }
export function AppShell(props: AppShellProps): JSX.Element
```
It renders the sidebar (navigation filtered by `user.role` using `NAV_ITEMS` from `client/src/components/layout/nav.ts`),
topbar (search slot, theme toggle, user menu) and `<main>` with `children`. Pages render inside with
`<PageHeader title description actions />` from the UI kit at the top.

## UI kit contract (Designer ⇄ everyone)
Components exported from `client/src/components/ui/index.ts` keep the prop names in the skeleton files.
Frontend may request additions; Designer implements.

## Charts contract (Logic Builder ⇄ Frontend)
Components exported from `client/src/components/charts/index.ts` keep the prop names in the skeleton files.

## Definition of done
- `npm run typecheck` and `npm run build` pass from the repo root.
- Server smoke test (`npm run smoke -w server`) passes.
- Both themes verified visually; no console errors.

## Auth contract (Frontend ⇄ Designer)
`client/src/auth/AuthProvider.tsx` exports `AuthProvider` and `useAuth(): { user, loading, login(input), logout(), refresh() }`.
`client/src/api/hooks.ts` exports `useDemoAccounts()` → `{ accounts: { label, role, email, employeeId }[] }`.
`client/src/pages/Login.tsx` (Designer) exports `LoginPage()` and uses both. `client/src/pages/About.tsx` (Marketing) exports `AboutPage()`.

## Chart colour tokens
`--color-chart-1 … --color-chart-6` are defined in `client/src/index.css` (Designer) and consumed by charts (Logic Builder) via `var(--color-chart-n)`.
