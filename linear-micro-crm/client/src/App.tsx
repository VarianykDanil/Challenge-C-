// Owned by the Frontend Developer. Routes + auth gate + AppShell wrapper.
// Public landing (`/` signed out, `/welcome` always) added by the Product Designer — see pages/Landing.tsx.
import { Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '@/components/layout';
import { ToastProvider, useToast } from '@/components/ui';
import { UNAUTHENTICATED_EVENT } from '@/api/client';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { RedirectIfAuthed, RequireAuth } from '@/auth/RequireAuth';
import { CAMPAIGN_ROLES, GAUGE_ROLES, RECRUITMENT_ROLES, RequireRole } from '@/auth/RequireRole';
import { LoginPage } from '@/pages/Login';
import { AboutPage } from '@/pages/About';
import { NotFoundPage } from '@/pages/NotFound';
import { FullPageSpinner } from '@/features/common/FullPageSpinner';

// Pages are code-split so the first paint of the dashboard stays light.
const DashboardPage = lazy(() => import('@/pages/Dashboard').then((m) => ({ default: m.DashboardPage })));
const EventsPage = lazy(() => import('@/pages/Events').then((m) => ({ default: m.EventsPage })));
const EventDetailPage = lazy(() => import('@/pages/EventDetail').then((m) => ({ default: m.EventDetailPage })));
const GaugesPage = lazy(() => import('@/pages/Gauges').then((m) => ({ default: m.GaugesPage })));
const LeaderboardPage = lazy(() => import('@/pages/Leaderboard').then((m) => ({ default: m.LeaderboardPage })));
const RecruitmentPage = lazy(() => import('@/pages/Recruitment').then((m) => ({ default: m.RecruitmentPage })));
const CandidateDetailPage = lazy(() => import('@/pages/CandidateDetail').then((m) => ({ default: m.CandidateDetailPage })));
const FinancePage = lazy(() => import('@/pages/Finance').then((m) => ({ default: m.FinancePage })));
const CampaignsPage = lazy(() => import('@/pages/Campaigns').then((m) => ({ default: m.CampaignsPage })));
const TeamPage = lazy(() => import('@/pages/Team').then((m) => ({ default: m.TeamPage })));
const UserDetailPage = lazy(() => import('@/pages/UserDetail').then((m) => ({ default: m.UserDetailPage })));
const SettingsPage = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })));
// The public page carries the charts bundle, so it is split too: signed-in users never download it.
const LandingPage = lazy(() => import('@/pages/Landing').then((m) => ({ default: m.LandingPage })));

/** Signed-in shell. Renders `children` when given (the `/` home route), otherwise the nested route via <Outlet />. */
function ShellLayout({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  return (
    <AppShell
      user={user}
      fluid={pathname === '/recruitment'}
      onLogout={() => {
        void logout().finally(() => navigate('/login', { replace: true }));
      }}
    >
      <Suspense fallback={<PageFallback />}>
        {children ?? <Outlet />}
      </Suspense>
    </AppShell>
  );
}

/** The public landing page (also the sign-out destination's neighbour): lazy, outside the shell. */
function PublicLanding() {
  return (
    <Suspense fallback={<FullPageSpinner label="Loading…" />}>
      <LandingPage />
    </Suspense>
  );
}

/** `/`: the public landing page when signed out, the dashboard inside the shell when signed in. */
function HomeRoute() {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner label="Loading…" />;
  if (!user) return <PublicLanding />;
  return (
    <ShellLayout>
      <DashboardPage />
    </ShellLayout>
  );
}

/** When any request comes back 401 the session is gone: clear state once, say so, and send the user to sign in (returning here afterwards). */
function SessionWatcher() {
  const { user, clearSession } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const handled = useRef(false);
  useEffect(() => {
    handled.current = false;
  }, [user]);
  useEffect(() => {
    const onExpired = () => {
      if (!user || handled.current) return;
      handled.current = true;
      clearSession();
      toast.info('Your session has ended', 'Sign in again to carry on where you left off.');
      navigate('/login', { replace: true, state: { from: location.pathname + location.search } });
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onExpired);
  }, [user, clearSession, toast, navigate, location.pathname, location.search]);
  return null;
}

function PageFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted" role="status" aria-live="polite">
      Loading page…
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <SessionWatcher />
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/welcome" element={<PublicLanding />} />
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <LoginPage />
              </RedirectIfAuthed>
            }
          />
          <Route
            element={
              <RequireAuth>
                <ShellLayout />
              </RequireAuth>
            }
          >
            <Route path="events" element={<EventsPage />} />
            <Route path="events/:id" element={<EventDetailPage />} />
            <Route path="gauges" element={<RequireRole roles={GAUGE_ROLES}><GaugesPage /></RequireRole>} />
            <Route path="leaderboard" element={<LeaderboardPage />} />
            <Route path="recruitment" element={<RequireRole roles={RECRUITMENT_ROLES}><RecruitmentPage /></RequireRole>} />
            <Route path="recruitment/:id" element={<RequireRole roles={RECRUITMENT_ROLES}><CandidateDetailPage /></RequireRole>} />
            <Route path="finance" element={<FinancePage />} />
            <Route path="campaigns" element={<RequireRole roles={CAMPAIGN_ROLES}><CampaignsPage /></RequireRole>} />
            <Route path="team" element={<TeamPage />} />
            <Route path="team/:id" element={<UserDetailPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}

