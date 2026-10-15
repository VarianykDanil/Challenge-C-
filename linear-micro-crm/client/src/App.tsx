// Owned by the Frontend Developer. Routes + auth gate + AppShell wrapper.
import { Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '@/components/layout';
import { ToastProvider } from '@/components/ui';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { RedirectIfAuthed, RequireAuth } from '@/auth/RequireAuth';
import { CAMPAIGN_ROLES, GAUGE_ROLES, RECRUITMENT_ROLES, RequireRole } from '@/auth/RequireRole';
import { LoginPage } from '@/pages/Login';
import { AboutPage } from '@/pages/About';
import { NotFoundPage } from '@/pages/NotFound';

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

function ShellLayout() {
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
        <Outlet />
      </Suspense>
    </AppShell>
  );
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
        <Routes>
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
            <Route index element={<DashboardPage />} />
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

