// Team → edit someone (administrators, not their own row): whether they have finished setting up, and "Give a setup
// code" for anyone who has not (a lost or expired code, an account from before setup codes). The admin's fresh
// two-step code first; the new code is shown once in the Sign-in details dialog.
import { useId, useState } from 'react';
import { Ticket } from 'lucide-react';
import type { SetupCodeIssued, UserWithTeam } from '@lm/shared';
import { useIssueSetupCode } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button } from '@/components/ui';
import { apiMessage } from '@/features/common/QueryStates';
import { fullName } from '@/lib/format';
import { SetupCodeDialog } from './SetupCodeDialog';
import { StepUpDialog } from './StepUpDialog';

export function SetupCodeSection({ user }: { user: UserWithTeam }) {
  const me = useCurrentUser();
  if (me.role !== 'admin' || me.id === user.id || user.status === 'left') return null;
  return <SetupCodeCard user={user} />;
}

function SetupCodeCard({ user }: { user: UserWithTeam }) {
  const uid = useId();
  const issue = useIssueSetupCode(user.id);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<SetupCodeIssued | null>(null);
  const finished = user.twoFactorEnabled === true;

  function onConfirm(code: string) {
    setError(null);
    issue.mutate(
      { code },
      {
        onSuccess: (r) => {
          setAsking(false);
          setIssued(r);
        },
        onError: (e) => setError(apiMessage(e, 'Could not make a setup code.')),
      },
    );
  }

  return (
    <section aria-labelledby={`${uid}-setup`} data-testid="admin-setup-code" className="rounded-xl border border-border bg-surface-2/50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Ticket className="h-4 w-4 text-muted" aria-hidden />
            <h4 id={`${uid}-setup`} className="font-sans text-sm font-semibold tracking-normal text-fg">Sign-in setup</h4>
            {user.twoFactorEnabled !== undefined && (
              <Badge tone={finished ? 'success' : 'warning'} dot={finished} size="sm">{finished ? 'Finished' : 'Not finished'}</Badge>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {finished
              ? 'They sign in with two-step verification. A setup code is only needed after a reset of their two-step or PIN.'
              : 'They need a one-time setup code to sign in and finish setting up. Any older code stops working.'}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => { setError(null); setAsking(true); }} leftIcon={<Ticket aria-hidden />}>
          Give a setup code
        </Button>
      </div>
      <StepUpDialog
        open={asking}
        onClose={() => setAsking(false)}
        tone="primary"
        title={`Give ${fullName(user)} a setup code?`}
        description="It works once, for 7 days, and replaces any code they had. You see it only once."
        confirmLabel="Give a setup code"
        busy={issue.isPending}
        error={error}
        onConfirm={onConfirm}
      />
      {issued && (
        <SetupCodeDialog
          name={fullName(user)}
          firstName={user.firstName}
          email={user.email}
          idLabel="Employee ID"
          idValue={user.employeeId}
          setupCode={issued.setupCode}
          expiresAt={issued.expiresAt}
          withheld={issued.withheld}
          intro={`${fullName(user)} has a new setup code.`}
          next="finish setting up as the app asks"
          onClose={() => setIssued(null)}
        />
      )}
    </section>
  );
}
