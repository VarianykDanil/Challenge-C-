// Owned by the Frontend Developer. TanStack Query hooks for every endpoint in docs/API.md.
import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type {
  AttentionFeed,
  Announcement,
  BackupStatus,
  Campaign,
  Candidate,
  CandidateSource,
  CandidateStage,
  CandidateWithMeta,
  Dashboard,
  DashboardRange,
  EventForecastResponse,
  EventStatus,
  EventType,
  Expense,
  ExpenseCategory,
  FinanceSummary,
  FunnelRatios,
  GaugeEntryWithMeta,
  GaugeGroupBy,
  GaugeSummaryRow,
  GaugeTotals,
  GaugeUpsertInput,
  Interview,
  LeaderboardRow,
  PayForecast,
  PayPlan,
  PayrollRunWithUser,
  PayrollStatus,
  Position,
  RecruitmentSummary,
  Role,
  SalesEvent,
  SalesEventWithMeta,
  SmartInsights,
  StageChange,
  Team,
  TrendPoint,
  TwoFactorEnabled,
  TwoFactorSetup,
  TwoFactorStatus,
  User,
  UserStatus,
  UserWithTeam,
  WeekDigest,
} from '@lm/shared';
import { api, apiRaw, qs, totalCount } from './client';
import { useAuth } from '@/auth/AuthProvider';

// ───────────────────────────── Response shapes not in shared/types ─────────────────────────────

export interface DemoAccount { label: string; role: Role; email: string; employeeId: string }

export interface UserPerformance {
  user: UserWithTeam;
  totals: GaugeTotals;
  ratios: FunnelRatios;
  days: number;
  salesPerDay: number;
  trend: TrendPoint[];
  byCampaign: GaugeSummaryRow[];
  recentEntries: GaugeEntryWithMeta[];
  punctualityRate: number | null;
}

export type EventDetail = SalesEventWithMeta & { entries: GaugeEntryWithMeta[]; ratios: FunnelRatios };

export type Payslip = PayrollRunWithUser & { plan: PayPlan; entries: GaugeEntryWithMeta[] };

export interface MyFinance {
  runs: PayrollRunWithUser[];
  totals: { gross: number; commission: number; onTimeRate: number | null };
  nextPayday: string | null;
  nextPayAmount: number | null;
  /** Smart release 1.1 (p3): this week's estimate; null for recruiters / admins / LM_SMART=0. Never the official figure. */
  forecast?: PayForecast | null;
}

export type CandidateDetail = CandidateWithMeta & { history: StageChange[]; interviews: Interview[] };

export interface HealthInfo {
  ok: boolean;
  version: string;
  seededAt: string;
  /** Smart release 1.1 (p10): present for admins only. */
  backup?: BackupStatus;
}

// ───────────────────────────── Query params ─────────────────────────────

export interface RangeParams { from?: string; to?: string }
export interface UsersParams { teamId?: number | null; role?: Role; status?: UserStatus | 'all'; q?: string }
export interface EventsParams extends RangeParams { teamId?: number | null; campaignId?: number | null; status?: EventStatus | '' }
export interface GaugesParams extends RangeParams { userId?: number | null; eventId?: number | null; teamId?: number | null; campaignId?: number | null; limit?: number }
/** One page of `GET /gauges`: `total` comes from the `X-Total-Count` header (null when the server does not send it). */
export interface GaugesPage { rows: GaugeEntryWithMeta[]; offset: number; total: number | null }
export interface GaugeSummaryParams extends RangeParams { groupBy: GaugeGroupBy; teamId?: number | null; campaignId?: number | null; userId?: number | null }
export interface LeaderboardParams { period?: DashboardRange; metric?: 'sales' | 'conversion'; teamId?: number | null }
/** `status` is one status or a comma list (e.g. `pending,failed` = everything still to pay). */
export interface PayrollParams extends RangeParams { userId?: number | null; teamId?: number | null; status?: PayrollStatus | `${PayrollStatus},${PayrollStatus}` | '' }
export interface ExpensesParams extends RangeParams { category?: ExpenseCategory | ''; campaignId?: number | null }
export interface CandidatesParams { stage?: CandidateStage | ''; ownerId?: number | null; source?: CandidateSource | ''; q?: string; open?: boolean }
export interface InterviewsParams extends RangeParams { candidateId?: number | null }
/** GET /events/forecast: the event being planned (the query only runs once campaign, team and type are all chosen). */
export interface EventForecastParams { campaignId?: number | null; teamId?: number | null; type?: EventType | '' | null; targetSales?: number | null }

export type EventInput = Omit<SalesEvent, 'id' | 'status'> & { status?: EventStatus };
export type CampaignInput = Omit<Campaign, 'id'>;
export type UserInput = Omit<User, 'id' | 'avatarColor'> & { avatarColor?: string };
export type CandidateInput = Pick<Candidate, 'firstName' | 'lastName' | 'email'> & Partial<Omit<Candidate, 'id'>>;
export type InterviewInput = Omit<Interview, 'id' | 'interviewerName'>;
export type ExpenseInput = Omit<Expense, 'id'>;
export type AnnouncementInput = Pick<Announcement, 'title' | 'body' | 'pinned'>;

// ───────────────────────────── Query keys ─────────────────────────────

export const keys = {
  demoAccounts: ['demo-accounts'] as const,
  twoFactor: ['auth', 'two-factor'] as const,
  dashboard: (range: DashboardRange) => ['dashboard', range] as const,
  users: (p: UsersParams = {}) => ['users', 'list', p] as const,
  user: (id: number) => ['users', 'detail', id] as const,
  userPerformance: (id: number, p: RangeParams) => ['users', 'performance', id, p] as const,
  teams: ['teams'] as const,
  campaigns: (active?: boolean) => ['campaigns', active ?? 'all'] as const,
  events: (p: EventsParams = {}) => ['events', 'list', p] as const,
  event: (id: number) => ['events', 'detail', id] as const,
  gauges: (p: GaugesParams = {}) => ['gauges', 'list', p] as const,
  gaugesPaged: (p: GaugesParams, pageSize: number) => ['gauges', 'paged', p, pageSize] as const,
  gaugeSummary: (p: GaugeSummaryParams) => ['gauges', 'summary', p] as const,
  leaderboard: (p: LeaderboardParams) => ['leaderboard', p] as const,
  payroll: (p: PayrollParams = {}) => ['finance', 'payroll', 'list', p] as const,
  payslip: (id: number) => ['finance', 'payroll', 'detail', id] as const,
  financeSummary: (p: RangeParams) => ['finance', 'summary', p] as const,
  payPlans: ['finance', 'pay-plans'] as const,
  expenses: (p: ExpensesParams = {}) => ['finance', 'expenses', p] as const,
  myFinance: (weeks: number) => ['finance', 'me', weeks] as const,
  candidates: (p: CandidatesParams = {}) => ['recruitment', 'candidates', 'list', p] as const,
  candidate: (id: number) => ['recruitment', 'candidates', 'detail', id] as const,
  interviews: (p: InterviewsParams = {}) => ['recruitment', 'interviews', p] as const,
  recruitmentSummary: (p: RangeParams) => ['recruitment', 'summary', p] as const,
  announcements: ['announcements'] as const,
  health: ['health'] as const,
  // Smart release 1.1 — every key starts with 'dashboard', so the existing ['dashboard'] invalidations refresh them.
  insights: ['dashboard', 'insights'] as const,
  attention: ['dashboard', 'attention'] as const,
  digest: (week?: string) => ['dashboard', 'digest', week ?? 'last'] as const,
  eventForecast: (p: EventForecastParams) => ['dashboard', 'event-forecast', p] as const,
};

type QueryOpts<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, 'queryKey' | 'queryFn'>;

const num = (v: number | null | undefined): number | undefined => (v == null ? undefined : v);

// ───────────────────────────── Auth / misc ─────────────────────────────

export function useDemoAccounts() {
  return useQuery({ queryKey: keys.demoAccounts, queryFn: () => api<{ accounts: DemoAccount[] }>('/auth/demo-accounts'), staleTime: Infinity });
}
/** Alias used by the Designer's Login page (`pickDemoAccounts()`); it is the same query hook. */
export const pickDemoAccounts = useDemoAccounts;

export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: () => api<HealthInfo>('/health'), staleTime: Infinity });
}

export function useAnnouncements() {
  return useQuery({ queryKey: keys.announcements, queryFn: () => api<Announcement[]>('/announcements') });
}

export function useCreateAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AnnouncementInput) => api<Announcement>('/announcements', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['announcements'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ───────────────────────────── Two-step verification (TOTP) ─────────────────────────────

export function useTwoFactorStatus(opts: QueryOpts<TwoFactorStatus> = {}) {
  return useQuery({ queryKey: keys.twoFactor, queryFn: () => api<TwoFactorStatus>('/auth/2fa'), ...opts });
}

/**
 * After the second factor changes: refetch the status card and the signed-in user (`/auth/me` carries
 * `twoFactorEnabled`). `['auth']` also covers any future query keyed under it.
 */
function useInvalidateTwoFactor() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['auth'] });
    void refresh();
  }, [qc, refresh]);
}

/** POST /auth/2fa/setup → a new *pending* secret with its QR. Calling it again replaces the pending one. */
export function useStartTwoFactorSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<TwoFactorSetup>('/auth/2fa/setup', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.twoFactor }),
  });
}

/** POST /auth/2fa/enable with a code from the app → the one-time list of recovery codes. */
export function useEnableTwoFactor() {
  const invalidate = useInvalidateTwoFactor();
  return useMutation({
    mutationFn: (input: { code: string }) => api<TwoFactorEnabled>('/auth/2fa/enable', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** POST /auth/2fa/disable with a current code or an unused recovery code. */
export function useDisableTwoFactor() {
  const invalidate = useInvalidateTwoFactor();
  return useMutation({
    mutationFn: (input: { code?: string; recoveryCode?: string }) => api<void>('/auth/2fa/disable', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** POST /auth/2fa/recovery-codes → a fresh set; the old codes stop working. */
export function useRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string }) => api<TwoFactorEnabled>('/auth/2fa/recovery-codes', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.twoFactor }),
  });
}

/** Admin: POST /users/:id/2fa/reset — clears another person's second factor (lost device) and signs them out everywhere. */
export function useResetUserTwoFactor(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/users/${userId}/2fa/reset`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

// ───────────────────────────── Dashboard ─────────────────────────────

export function useDashboard(range: DashboardRange) {
  return useQuery({ queryKey: keys.dashboard(range), queryFn: () => api<Dashboard>(`/me/dashboard${qs({ range })}`) });
}

// ───────────────────────────── Smart release 1.1 ─────────────────────────────

/** GET /me/insights — the caller's pace, streaks, pay forecast, board streaks and (leader / admin) check-in list. */
export function useInsights(opts: QueryOpts<SmartInsights> = {}) {
  return useQuery({ queryKey: keys.insights, queryFn: () => api<SmartInsights>('/me/insights'), ...opts });
}

/** Re-poll the attention feed this often while the tab is visible. */
export const ATTENTION_POLL_MS = 60_000;

/**
 * GET /me/attention — the Needs-attention feed. With `poll`, it refetches every 60 s, but only while the page is
 * visible (`document.visibilityState === 'visible'`), plus on reconnect and when the window regains focus.
 */
export function useAttention({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: keys.attention,
    queryFn: () => api<AttentionFeed>('/me/attention'),
    refetchInterval: poll ? () => (typeof document === 'undefined' || document.visibilityState === 'visible' ? ATTENTION_POLL_MS : false) : false,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}

/** GET /me/digest — "Your week in review"; `week` is any date in the week (default: the last completed week). */
export function useDigest(week?: string) {
  return useQuery({ queryKey: keys.digest(week), queryFn: () => api<WeekDigest>(`/me/digest${qs({ week })}`) });
}

/** GET /events/forecast (admin / leader) — enabled only once campaign, team and type are all set. */
export function useEventForecast(params: EventForecastParams, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = params.campaignId != null && params.teamId != null && !!params.type;
  return useQuery({
    queryKey: keys.eventForecast(params),
    queryFn: () =>
      api<EventForecastResponse>(
        `/events/forecast${qs({ campaignId: num(params.campaignId), teamId: num(params.teamId), type: params.type || undefined, targetSales: num(params.targetSales) })}`,
      ),
    enabled: enabled && ready,
  });
}

// ───────────────────────────── People ─────────────────────────────

export function useUsers(params: UsersParams = {}, opts: QueryOpts<UserWithTeam[]> = {}) {
  return useQuery({
    queryKey: keys.users(params),
    queryFn: () => api<UserWithTeam[]>(`/users${qs({ teamId: num(params.teamId), role: params.role, status: params.status, q: params.q })}`),
    ...opts,
  });
}

export function useUser(id: number | null | undefined) {
  return useQuery({ queryKey: keys.user(id ?? 0), queryFn: () => api<UserWithTeam>(`/users/${id}`), enabled: id != null && id > 0 });
}

export function useUserPerformance(id: number | null | undefined, range: RangeParams) {
  return useQuery({
    queryKey: keys.userPerformance(id ?? 0, range),
    queryFn: () => api<UserPerformance>(`/users/${id}/performance${qs({ from: range.from, to: range.to })}`),
    enabled: id != null && id > 0,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UserInput) => api<UserWithTeam>('/users', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<User> & { id: number }) => api<UserWithTeam>(`/users/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: (user) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['teams'] });
      qc.setQueryData(keys.user(user.id), user);
      // Names, teams and positions are embedded in every list that shows a person: refetch them so the old name never lingers.
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
      void qc.invalidateQueries({ queryKey: ['gauges'] });
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['recruitment'] });
    },
  });
}

export function useTeams() {
  return useQuery({ queryKey: keys.teams, queryFn: () => api<Team[]>('/teams'), staleTime: 5 * 60_000 });
}

// ───────────────────────────── Campaigns ─────────────────────────────

export function useCampaigns(active?: boolean) {
  return useQuery({
    queryKey: keys.campaigns(active),
    queryFn: () => api<Campaign[]>(`/campaigns${qs({ active: active === undefined ? undefined : String(active) })}`),
    staleTime: 5 * 60_000,
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CampaignInput) => api<Campaign>('/campaigns', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaigns'] }),
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<Campaign> & { id: number }) => api<Campaign>(`/campaigns/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
      void qc.invalidateQueries({ queryKey: ['events'] });
      // Campaign name / colour / payout are embedded in gauge rows, finance by-campaign and the dashboard donut.
      void qc.invalidateQueries({ queryKey: ['gauges'] });
      void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ───────────────────────────── Events ─────────────────────────────

export function useEvents(params: EventsParams = {}, opts: QueryOpts<SalesEventWithMeta[]> = {}) {
  return useQuery({
    queryKey: keys.events(params),
    queryFn: () =>
      api<SalesEventWithMeta[]>(
        `/events${qs({ from: params.from, to: params.to, teamId: num(params.teamId), campaignId: num(params.campaignId), status: params.status })}`,
      ),
    ...opts,
  });
}

export function useEvent(id: number | null | undefined) {
  return useQuery({ queryKey: keys.event(id ?? 0), queryFn: () => api<EventDetail>(`/events/${id}`), enabled: id != null && id > 0 });
}

/** A new event changes calendars and the dashboard's upcoming list only (it carries no gauges yet). */
function invalidateEventRelated(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['events'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
}

export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EventInput) => api<SalesEventWithMeta>('/events', { method: 'POST', json: input }),
    onSuccess: () => invalidateEventRelated(qc),
  });
}

/** Editing an event can move its gauges to another date, team or campaign, so every aggregate is refetched. */
export function useUpdateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<SalesEvent> & { id: number }) => api<SalesEventWithMeta>(`/events/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => invalidateGaugeRelated(qc),
  });
}

/**
 * Deleting an event takes its gauge entries with it, so leaderboard, summaries, finance and performance are
 * refetched too. The deleted event's own detail query is only marked stale (never refetched — that would be a 404
 * while the page is still mounted); the page navigates away and the query is garbage-collected.
 */
export function useDeleteEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/events/${id}`, { method: 'DELETE' }),
    onSuccess: (_void, id) => {
      void qc.invalidateQueries({ queryKey: keys.event(id), refetchType: 'none' });
      void qc.invalidateQueries({ queryKey: ['events', 'list'] });
      void qc.invalidateQueries({ queryKey: ['gauges'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
      void qc.invalidateQueries({ queryKey: ['users', 'performance'] });
      void qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}

// ───────────────────────────── Gauges ─────────────────────────────

export function useGauges(params: GaugesParams = {}, opts: QueryOpts<GaugeEntryWithMeta[]> = {}) {
  return useQuery({
    queryKey: keys.gauges(params),
    queryFn: () =>
      api<GaugeEntryWithMeta[]>(
        `/gauges${qs({
          userId: num(params.userId),
          eventId: num(params.eventId),
          teamId: num(params.teamId),
          campaignId: num(params.campaignId),
          from: params.from,
          to: params.to,
          limit: params.limit,
        })}`,
      ),
    ...opts,
  });
}

export const GAUGES_PAGE_SIZE = 25;

/**
 * `GET /gauges` a page at a time (`limit` + `offset`), newest first. The total comes from the `X-Total-Count`
 * header; a server that does not send it (and so ignores `offset`) yields a single page and no "load more".
 */
export function useGaugesPaged(params: Omit<GaugesParams, 'limit'>, opts: { enabled?: boolean; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? GAUGES_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: keys.gaugesPaged(params, pageSize),
    queryFn: async ({ pageParam }): Promise<GaugesPage> => {
      const offset = pageParam;
      const r = await apiRaw<GaugeEntryWithMeta[]>(
        `/gauges${qs({
          userId: num(params.userId),
          eventId: num(params.eventId),
          teamId: num(params.teamId),
          campaignId: num(params.campaignId),
          from: params.from,
          to: params.to,
          limit: pageSize,
          offset: offset > 0 ? offset : undefined,
        })}`,
      );
      return { rows: r.data, offset, total: totalCount(r.headers) };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => {
      if (last.total == null || last.rows.length === 0) return undefined;
      const next = last.offset + last.rows.length;
      return next < last.total ? next : undefined;
    },
    enabled: opts.enabled,
  });
}

export function useGaugeSummary(params: GaugeSummaryParams, opts: QueryOpts<GaugeSummaryRow[]> = {}) {
  return useQuery({
    queryKey: keys.gaugeSummary(params),
    queryFn: () =>
      api<GaugeSummaryRow[]>(
        `/gauges/summary${qs({
          groupBy: params.groupBy,
          from: params.from,
          to: params.to,
          teamId: num(params.teamId),
          campaignId: num(params.campaignId),
          userId: num(params.userId),
        })}`,
      ),
    ...opts,
  });
}

/** Everything that depends on gauge data. */
function invalidateGaugeRelated(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['gauges'] });
  void qc.invalidateQueries({ queryKey: ['events'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['leaderboard'] });
  void qc.invalidateQueries({ queryKey: ['users', 'performance'] });
  void qc.invalidateQueries({ queryKey: ['finance'] });
}

/** Result of `POST /gauges`: `created` is true for a 201 (new entry) and false for a 200 (the existing day was updated). */
export interface GaugeUpsertResult { entry: GaugeEntryWithMeta; created: boolean }

export function useUpsertGauge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: GaugeUpsertInput & { id?: number }): Promise<GaugeUpsertResult> => {
      const r = await apiRaw<GaugeEntryWithMeta>('/gauges', { method: 'POST', json: input });
      return { entry: r.data, created: r.status === 201 };
    },
    onSuccess: () => invalidateGaugeRelated(qc),
  });
}

export function useUpdateGauge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<GaugeUpsertInput> & { id: number }) => api<GaugeEntryWithMeta>(`/gauges/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => invalidateGaugeRelated(qc),
  });
}

export function useDeleteGauge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/gauges/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateGaugeRelated(qc),
  });
}

export function useLeaderboard(params: LeaderboardParams) {
  return useQuery({
    queryKey: keys.leaderboard(params),
    queryFn: () => api<LeaderboardRow[]>(`/leaderboard${qs({ period: params.period, metric: params.metric, teamId: num(params.teamId) })}`),
  });
}

// ───────────────────────────── Finance ─────────────────────────────

export function usePayroll(params: PayrollParams = {}, opts: QueryOpts<PayrollRunWithUser[]> = {}) {
  return useQuery({
    queryKey: keys.payroll(params),
    queryFn: () =>
      api<PayrollRunWithUser[]>(
        `/finance/payroll${qs({ userId: num(params.userId), teamId: num(params.teamId), status: params.status, from: params.from, to: params.to })}`,
      ),
    ...opts,
  });
}

export function usePayslip(id: number | null | undefined) {
  return useQuery({ queryKey: keys.payslip(id ?? 0), queryFn: () => api<Payslip>(`/finance/payroll/${id}`), enabled: id != null && id > 0 });
}

export function usePayRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paidDate }: { id: number; paidDate?: string }) =>
      api<PayrollRunWithUser>(`/finance/payroll/${id}/pay`, { method: 'POST', json: paidDate ? { paidDate } : {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useFinanceSummary(range: RangeParams, opts: QueryOpts<FinanceSummary> = {}) {
  return useQuery({ queryKey: keys.financeSummary(range), queryFn: () => api<FinanceSummary>(`/finance/summary${qs({ from: range.from, to: range.to })}`), ...opts });
}

export function usePayPlans(opts: QueryOpts<PayPlan[]> = {}) {
  return useQuery({ queryKey: keys.payPlans, queryFn: () => api<PayPlan[]>('/finance/pay-plans'), staleTime: 5 * 60_000, ...opts });
}

export function useExpenses(params: ExpensesParams = {}, opts: QueryOpts<Expense[]> = {}) {
  return useQuery({
    queryKey: keys.expenses(params),
    queryFn: () => api<Expense[]>(`/finance/expenses${qs({ from: params.from, to: params.to, category: params.category, campaignId: num(params.campaignId) })}`),
    ...opts,
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ExpenseInput) => api<Expense>('/finance/expenses', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['finance'] }),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/finance/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['finance'] }),
  });
}

export function useMyFinance(weeks = 12) {
  return useQuery({ queryKey: keys.myFinance(weeks), queryFn: () => api<MyFinance>(`/finance/me${qs({ weeks })}`) });
}

// ───────────────────────────── Recruitment ─────────────────────────────

export function useCandidates(params: CandidatesParams = {}, opts: QueryOpts<CandidateWithMeta[]> = {}) {
  return useQuery({
    queryKey: keys.candidates(params),
    queryFn: () =>
      api<CandidateWithMeta[]>(
        `/recruitment/candidates${qs({ stage: params.stage, ownerId: num(params.ownerId), source: params.source, q: params.q, open: params.open ? 'true' : undefined })}`,
      ),
    ...opts,
  });
}

export function useCandidate(id: number | null | undefined) {
  return useQuery({ queryKey: keys.candidate(id ?? 0), queryFn: () => api<CandidateDetail>(`/recruitment/candidates/${id}`), enabled: id != null && id > 0 });
}

function invalidateRecruitment(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['recruitment'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
}

export function useCreateCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CandidateInput) => api<CandidateWithMeta>('/recruitment/candidates', { method: 'POST', json: input }),
    onSuccess: () => invalidateRecruitment(qc),
  });
}

export function useUpdateCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<Omit<Candidate, 'stage'>> & { id: number }) =>
      api<CandidateWithMeta>(`/recruitment/candidates/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => invalidateRecruitment(qc),
  });
}

export function useMoveCandidateStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage, note, teamId, position }: { id: number; stage: CandidateStage; note?: string; /** hire only */ teamId?: number | null; /** hire only: trainee | field_rep */ position?: Position }) =>
      api<CandidateWithMeta>(`/recruitment/candidates/${id}/stage`, { method: 'POST', json: { stage, note, ...(teamId !== undefined ? { teamId } : {}), ...(position ? { position } : {}) } }),
    onSuccess: (_c, vars) => {
      invalidateRecruitment(qc);
      if (vars.stage === 'hired') {
        void qc.invalidateQueries({ queryKey: ['users'] });
        void qc.invalidateQueries({ queryKey: ['teams'] });
      }
    },
  });
}

export function useInterviews(params: InterviewsParams = {}, opts: QueryOpts<Interview[]> = {}) {
  return useQuery({
    queryKey: keys.interviews(params),
    queryFn: () => api<Interview[]>(`/recruitment/interviews${qs({ from: params.from, to: params.to, candidateId: num(params.candidateId) })}`),
    ...opts,
  });
}

export function useCreateInterview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InterviewInput) => api<Interview>('/recruitment/interviews', { method: 'POST', json: input }),
    onSuccess: () => invalidateRecruitment(qc),
  });
}

export function useUpdateInterview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<InterviewInput> & { id: number }) => api<Interview>(`/recruitment/interviews/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => invalidateRecruitment(qc),
  });
}

export function useRecruitmentSummary(range: RangeParams = {}) {
  return useQuery({ queryKey: keys.recruitmentSummary(range), queryFn: () => api<RecruitmentSummary>(`/recruitment/summary${qs({ from: range.from, to: range.to })}`) });
}
