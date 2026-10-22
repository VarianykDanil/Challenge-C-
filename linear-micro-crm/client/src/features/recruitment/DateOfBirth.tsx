// Release 1.3 — OWNED BY P7 recruitment-plus. A candidate's date of birth: the age, the "Under 18" warning and the
// profile's editor. Recruitment roles only (the page and the API both check). The same rules as the server
// (shared dateOfBirthProblem: a real date, not in the future, 14 to 100 years old).
import { useId, useState } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, Pencil } from 'lucide-react';
import { CANDIDATE_ADULT_AGE, ageOn, dateOfBirthProblem, isUnderAge } from '@lm/shared';
import { Badge, Button, Card, Input, useToast } from '@/components/ui';
import { useUpdateCandidate, type CandidateDetail } from '@/api/hooks';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { parseDate } from '@/lib/format';

/** "12 Mar 2001" (no weekday: it is a birthday, not an appointment). */
export function dobLabel(dob: string): string {
  const d = parseDate(dob);
  return d ? format(d, 'd MMM yyyy') : dob;
}

/** The day they turn 18 ("16 Nov 2026"), for the warning. */
function eighteenthBirthday(dob: string): string {
  const [y, m, d] = dob.split('-');
  return dobLabel(`${Number(y) + CANDIDATE_ADULT_AGE}-${m}-${m === '02' && d === '29' ? '28' : d}`);
}

export function UnderAgeBadge({ dateOfBirth }: { dateOfBirth?: string | null }) {
  if (!dateOfBirth || !isUnderAge(dateOfBirth, todayISO())) return null;
  return <Badge tone="warning">Under 18</Badge>;
}

/** The callout at the top of a candidate's profile while they are under 18. */
export function UnderAgeNotice({ name, dateOfBirth }: { name: string; dateOfBirth?: string | null }) {
  if (!dateOfBirth || !isUnderAge(dateOfBirth, todayISO())) return null;
  const age = ageOn(dateOfBirth, todayISO());
  return (
    <Card tone="warning" padded={false} className="flex items-start gap-3 p-4" role="note" data-testid="under-age-notice">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
      <div className="text-sm">
        <p className="font-semibold text-fg">Under 18: {name} is {age}</p>
        <p className="mt-0.5 text-muted">They turn 18 on {eighteenthBirthday(dateOfBirth)}. Young workers have extra rules on hours, breaks and supervision; check them before an offer.</p>
      </div>
    </Card>
  );
}

/** The profile row: the date and age, with an editor for recruitment roles. */
export function DateOfBirthRow({ candidate, canWrite }: { candidate: CandidateDetail; canWrite: boolean }) {
  const toast = useToast();
  const uid = useId();
  const update = useUpdateCandidate();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(candidate.dateOfBirth ?? '');
  const [error, setError] = useState<string | null>(null);
  const dob = candidate.dateOfBirth ?? null;
  const age = dob ? ageOn(dob, todayISO()) : null;

  const save = () => {
    const problem = value ? dateOfBirthProblem(value, todayISO()) : null;
    setError(problem);
    if (problem) return;
    update.mutate(
      { id: candidate.id, dateOfBirth: value },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success(value ? 'Date of birth saved' : 'Date of birth removed');
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  if (editing) {
    return (
      <div className="border-t border-border pt-3" data-testid="candidate-dob">
        <dt className="mb-2"><label htmlFor={`${uid}-dob`} className="block text-sm text-muted">Date of birth</label></dt>
        <dd>
        <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-2">
          <Input id={`${uid}-dob`} type="date" value={value} max={todayISO()} onChange={(e) => setValue(e.target.value)} invalid={!!error} aria-describedby={error ? `${uid}-err` : undefined} autoFocus />
          {error && <p id={`${uid}-err`} className="text-xs font-medium text-danger" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {dob && <Button variant="ghost" onClick={() => setValue('')} disabled={!value}>Clear</Button>}
            <Button variant="ghost" onClick={() => { setEditing(false); setValue(dob ?? ''); setError(null); }}>Cancel</Button>
            <Button type="submit" loading={update.isPending} disabled={value === (dob ?? '')}>Save</Button>
          </div>
        </form>
        </dd>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 border-t border-border pt-3" data-testid="candidate-dob">
      <dt className="shrink-0 whitespace-nowrap text-muted">Date of birth</dt>
      <dd className="flex flex-wrap items-center justify-end gap-2 text-right">
        {dob ? <span>{dobLabel(dob)}{age !== null ? ` · ${age}` : ''}</span> : <span className="text-muted">Not recorded</span>}
        <UnderAgeBadge dateOfBirth={dob} />
        {canWrite && (
          <Button size="icon-sm" variant="ghost" className="max-sm:h-10 max-sm:w-10" label={dob ? 'Edit date of birth' : 'Add date of birth'} onClick={() => { setValue(dob ?? ''); setEditing(true); }}>
            <Pencil aria-hidden />
          </Button>
        )}
      </dd>
    </div>
  );
}
