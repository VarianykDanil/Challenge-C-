// Owned by the Frontend Developer. Routes + auth gate + AppShell wrapper.
// Public landing (`/` signed out, `/welcome` always) added by the Product Designer — see pages/Landing.tsx.
import { Suspense, lazy, useEffect, useRef } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '@/components/layout';
import { ToastProvider, useToast } from '@/components/ui';
import { UNAUTHENTICATED_EVENT } from '@/api/client';
import { peekSessionEndNotice } from '@/api/sessionEnd';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { RedirectIfAuthed, RequireAuth } from '@/auth/RequireAuth';
import {
  AUDIT_ROLES, BULK_GAUGE_ROLES, CAMPAIGN_PAGE_ROLES, CAMPAIGN_ROLES, GAUGE_ROLES, PAYMENT_ROLES, RECRUITMENT_ROLES, RequireRole, STATEMENT_ROLES, VENUE_ROLES,
} from '@/auth/RequireRole';
import { PinSetupGate } from '@/auth/PinSetupGate';
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
// The field screen for the shift tally (sidebar's Quick gauges button); its own chunk, like every page.
const QuickGaugesPage = lazy(() => import('@/pages/QuickGauges').then((m) => ({ default: m.QuickGaugesPage })));
// The public page carries the charts bundle, so it is split too: signed-in users never download it.
const LandingPage = lazy(() => import('@/pages/Landing').then((m) => ({ default: m.LandingPage })));
// Sign-in and About are split as well (lead decision on the bundle: the main chunk back under 460 kB): someone who is
// already signed in, the usual case on a phone, never downloads the sign-in page, and About is rarely opened. The
// sign-in page loads behind the same full-page spinner the session check shows, so it reads as one wait.
const LoginPage = lazy(() => import('@/pages/Login').then((m) => ({ default: m.LoginPage })));
const AboutPage = lazy(() => import('@/pages/About').then((m) => ({ default: m.AboutPage })));
// Release 1.2 (r2-foundation lays down every page; each file names its owner): Learning hub, lesson, checklist (L1),
// pitch studio (L2), audit trail (U3), bulk gauge entry (U2).
const LearningPage = lazy(() => import('@/pages/Learning').then((m) => ({ default: m.LearningPage })));
const LearningLessonPage = lazy(() => import('@/pages/LearningLesson').then((m) => ({ default: m.LearningLessonPage })));
const LearningPitchPage = lazy(() => import('@/pages/LearningPitch').then((m) => ({ default: m.LearningPitchPage })));
const LearningProgressPage = lazy(() => import('@/pages/LearningProgress').then((m) => ({ default: m.LearningProgressPage })));
const AuditPage = lazy(() => import('@/pages/Audit').then((m) => ({ default: m.AuditPage })));
const BulkGaugesPage = lazy(() => import('@/pages/BulkGauges').then((m) => ({ default: m.BulkGaugesPage })));
// Release 1.3 (r3-foundation lays down every page; each file names its owner): statements (P3), learning video (P5),
// campaign page and the client portal (P6), interview schedule and sheet (P7), venues (P8).
const StatementsPage = lazy(() => import('@/pages/Statements').then((m) => ({ default: m.StatementsPage })));
const LearningVideoPage = lazy(() => import('@/pages/LearningVideo').then((m) => ({ default: m.LearningVideoPage })));
const CampaignPagePage = lazy(() => import('@/pages/CampaignPage').then((m) => ({ default: m.CampaignPagePage })));
const InterviewSchedulePage = lazy(() => import('@/pages/InterviewSchedule').then((m) => ({ default: m.InterviewSchedulePage })));
const InterviewSheetPage = lazy(() => import('@/pages/InterviewSheet').then((m) => ({ default: m.InterviewSheetPage })));
const VenuesPage = lazy(() => import('@/pages/Venues').then((m) => ({ default: m.VenuesPage })));
const VenueDetailPage = lazy(() => import('@/pages/VenueDetail').then((m) => ({ default: m.VenueDetailPage })));
// The client portal: its own shell and pages, never the staff AppShell (P6).
const ClientShell = lazy(() => import('@/features/client/ClientShell').then((m) => ({ default: m.ClientShell })));
const ClientPortalPage = lazy(() => import('@/pages/ClientPortal').then((m) => ({ default: m.ClientPortalPage })));
const ClientSecurityPage = lazy(() => import('@/pages/ClientSecurity').then((m) => ({ default: m.ClientSecurityPage })));
// Release 1.4 (F): paying people from Linear Hub (admin)
const PaymentsPayPage = lazy(() => import('@/pages/PaymentsPay').then((m) => ({ default: m.PaymentsPayPage })));
const PaymentBatchPage = lazy(() => import('@/pages/PaymentBatch').then((m) => ({ default: m.PaymentBatchPage })));

/**
 * Signed-in shell: one layout route for every signed-in page, the dashboard included (as the index child), so the
 * AppShell — sidebar, topbar, drawer and the element that has focus — stays mounted across navigation.
 */
function ShellLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  // Release 1.3: a client portal account never sees the staff app — every staff path sends it to its portal.
  if (user.role === 'client') return <Navigate to="/client" replace />;
  // Release 1.2 (U1): the PIN gate shows "Create your PIN" instead of the app while one is required (pass-through now).
  return (
    <PinSetupGate>
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
    </PinSetupGate>
  );
}

/**
 * Release 1.3 (r3-foundation): the client portal's layout — client accounts only (staff are sent to their dashboard),
 * inside U1's PIN gate (P6 makes a PIN required for client accounts), with its own lazy shell (features/client).
 */
function ClientLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'client') return <Navigate to="/" replace />;
  return (
    <PinSetupGate>
      <Suspense fallback={<FullPageSpinner label="Loading…" />}>
        <ClientShell
          user={user}
          onLogout={() => {
            void logout().finally(() => navigate('/login', { replace: true }));
          }}
        >
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </ClientShell>
      </Suspense>
    </PinSetupGate>
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

/**
 * Gate for the `/` tree: the public landing page when signed out at `/` exactly, otherwise the signed-in shell
 * (RequireAuth sends a signed-out visitor of any other path to /login and brings them back afterwards).
 */
function HomeGate() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <FullPageSpinner label="Loading…" />;
  // Release 1.4: after the automatic sign-out 14 hours after sign-in, `/` goes to the sign-in page (which says why)
  if (!user && pathname === '/' && !peekSessionEndNotice()) return <PublicLanding />;
  return (
    <RequireAuth>
      <ShellLayout />
    </RequireAuth>
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
      // Release 1.4: the automatic sign-out 14 hours after sign-in is explained on the sign-in page itself
      if (!peekSessionEndNotice()) toast.info('Your session has ended', 'Sign in again to carry on where you left off.');
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
          <Route path="/welcome" element={<PublicLanding />} />
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <Suspense fallback={<FullPageSpinner label="Loading…" />}>
                  <LoginPage />
                </Suspense>
              </RedirectIfAuthed>
            }
          />
          {/* Release 1.3: the client portal (P6) — Updates and Security, nothing else. */}
          <Route path="/client" element={<RequireAuth><ClientLayout /></RequireAuth>}>
            <Route index element={<ClientPortalPage />} />
            <Route path="security" element={<ClientSecurityPage />} />
            <Route path="*" element={<Navigate to="/client" replace />} />
          </Route>
          <Route path="/" element={<HomeGate />}>
            <Route index element={<DashboardPage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="events/:id" element={<EventDetailPage />} />
            <Route path="gauges" element={<RequireRole roles={GAUGE_ROLES}><GaugesPage /></RequireRole>} />
            <Route path="gauges/bulk" element={<RequireRole roles={BULK_GAUGE_ROLES}><BulkGaugesPage /></RequireRole>} />
            <Route path="quick" element={<RequireRole roles={GAUGE_ROLES}><QuickGaugesPage /></RequireRole>} />
            <Route path="leaderboard" element={<LeaderboardPage />} />
            <Route path="recruitment" element={<RequireRole roles={RECRUITMENT_ROLES}><RecruitmentPage /></RequireRole>} />
            <Route path="recruitment/:id" element={<RequireRole roles={RECRUITMENT_ROLES}><CandidateDetailPage /></RequireRole>} />
            <Route path="finance" element={<FinancePage />} />
            <Route path="campaigns" element={<RequireRole roles={CAMPAIGN_ROLES}><CampaignsPage /></RequireRole>} />
            <Route path="team" element={<TeamPage />} />
            <Route path="team/:id" element={<UserDetailPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="learning" element={<LearningPage />} />
            <Route path="learning/pack/:lessonKey" element={<LearningLessonPage />} />
            <Route path="learning/pitch/:campaignCode" element={<LearningPitchPage />} />
            <Route path="learning/progress" element={<LearningProgressPage />} />
            <Route path="audit" element={<RequireRole roles={AUDIT_ROLES}><AuditPage /></RequireRole>} />
            {/* Release 1.3 pages (each file names its owner) */}
            <Route path="finance/statements" element={<RequireRole roles={STATEMENT_ROLES}><StatementsPage /></RequireRole>} />
            <Route path="finance/pay" element={<RequireRole roles={PAYMENT_ROLES}><PaymentsPayPage /></RequireRole>} />
            <Route path="finance/pay/batches/:id" element={<RequireRole roles={PAYMENT_ROLES}><PaymentBatchPage /></RequireRole>} />
            <Route path="venues" element={<RequireRole roles={VENUE_ROLES}><VenuesPage /></RequireRole>} />
            <Route path="venues/:key" element={<RequireRole roles={VENUE_ROLES}><VenueDetailPage /></RequireRole>} />
            <Route path="recruitment/schedule" element={<RequireRole roles={RECRUITMENT_ROLES}><InterviewSchedulePage /></RequireRole>} />
            <Route path="recruitment/interviews/:id" element={<RequireRole roles={RECRUITMENT_ROLES}><InterviewSheetPage /></RequireRole>} />
            <Route path="learning/videos/:id" element={<LearningVideoPage />} />
            <Route path="campaigns/:id" element={<RequireRole roles={CAMPAIGN_PAGE_ROLES}><CampaignPagePage /></RequireRole>} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
