// Trial mode, as administrators see it: a strip under the top bar on every page ("Trial mode: demo sign-ins are on.
// Go live before real pay or bank details go in."), and the Settings card with the steps to go live. Nobody else sees
// either. It cannot be dismissed: it goes away when the owner runs npm run golive.
import { Link } from 'react-router-dom';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { ACCESS_MESSAGES, trialHeadline } from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
import { Card, CardHeader } from '@/components/ui';
import { useScrollToHash } from '@/lib/useScrollToHash';

export function TrialBanner() {
  const { user, trial } = useAuth();
  if (!trial?.trialMode || user?.role !== 'admin') return null;
  return (
    <div role="status" data-testid="trial-banner" className="border-b border-warning/30 bg-warning-soft">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6 lg:px-8">
        <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 flex-1 text-fg">
          <span className="font-semibold">{trialHeadline(trial.demoSignIns)}.</span>{' '}
          <span className="max-sm:hidden">Go live before real pay or bank details go in.</span>
        </span>
        <Link to="/settings#trial" className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-md font-medium text-primary underline-offset-4 hover:underline sm:min-h-0">
          How to go live
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

const STEPS = [
  'On the computer that runs Linear Hub, stop it: npm run stop (or npm run service:uninstall if it runs as a background service).',
  'Run npm run golive. It shows what goes and what stays, backs everything up and asks you to type GO LIVE.',
  'It removes the demo company: its people, their history and the demo records. Your settings, the people you added and what you made stay.',
  'If no administrator of your own is left, it makes you the owner and prints your employee ID and one-time setup code.',
  'Start Linear Hub again (npm start), sign in with your email, employee ID and setup code, and set up two-step verification.',
];

/** Settings → Trial mode (administrators, while in trial mode): what it means and how to go live. */
export function TrialSettingsSection() {
  const { user, trial } = useAuth();
  const on = !!trial?.trialMode && user?.role === 'admin';
  useScrollToHash('trial', on);
  if (!on) return null;
  return (
    <Card id="trial" tone="warning" data-testid="trial-settings" className="scroll-mt-40">
      <CardHeader
        title={trialHeadline(trial.demoSignIns)}
        description="This database still holds the demo company. While it does, the demo accounts cannot see or change real bank details, make administrators, reset anyone’s sign-in or approve a payment."
        icon={<TriangleAlert aria-hidden />}
      />
      <p className="text-sm text-fg">{ACCESS_MESSAGES.trialBody}</p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-fg">
        {STEPS.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {trial.demoSignIns
          ? 'To stop the one-tap demo sign-ins before going live, start Linear Hub with LM_DEMO_ACCOUNTS=0.'
          : 'The one-tap demo sign-ins are off. The demo company is still here until you go live.'}
      </p>
    </Card>
  );
}
