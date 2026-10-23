// Release 1.2 — OWNED BY U1 sign-in-pin. Settings > Security, under two-step verification (mounted in pages/Settings.tsx
// in an ErrorBoundary with fallback={null}; `className` carries the spacing, mt-4):
//  - "Sign-in PIN": your own PIN — set, change (asks for the current one) or remove (not while a PIN is required).
//  - "Sign-in rules" (administrators): require a PIN for everyone, and the session idle timeout. Switching a rule on
//    asks first; the server refuses a rule that would lock out the admin making the change, and the switch says so
//    before anyone tries. Release 1.4 (package S): the "Require two-step verification for administrators" switch is now
//    a plain line ("Two-step verification is required for everyone"), and "Sign out after" sets the hours from sign-in
//    to the automatic sign-out (4–24, default 14).
import { useEffect, useId, useState, type FormEvent } from 'react';
import { KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import {
  PIN_PROBLEM_MESSAGES, SESSION_IDLE_HOURS_DEFAULT, SESSION_MAX_HOURS_DEFAULT, SESSION_MAX_HOURS_MAX, SESSION_MAX_HOURS_MIN, isPinFormatValid, pinProblem,
  type SecuritySettings,
} from '@lm/shared';
import { ApiError } from '@/api/client';
import { pinKeys, usePinStatus, useRemovePin, useSecuritySettings, useSetPin, useUpdateSecuritySettings } from '@/api/pin';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Modal, Select, Skeleton, Switch, useToast } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { apiMessage, errorMessage } from '@/features/common/QueryStates';
import { formatDate } from '@/lib/format';
import { PinField, PinInput } from './PinInput';
import { PIN_COPY, pinUnlockTime } from './pinCopy';

export interface PinSettingsProps {
  className?: string;
}

export function PinSettings({ className }: PinSettingsProps) {
  const user = useCurrentUser();
  return (
    <div className={clsx('space-y-4', className)}>
      <OwnPinSection />
      {user.role === 'admin' && <SignInRulesSection />}
    </div>
  );
}

/* ───────────────────────────── your PIN ───────────────────────────── */

type PinModal = null | 'set' | 'remove';

function OwnPinSection() {
  const t = PIN_COPY.settings;
  const uid = useId();
  const status = usePinStatus();
  const [modal, setModal] = useState<PinModal>(null);
  const s = status.data;
  const close = () => setModal(null);
  const { refetch } = status;

  // A lock ends by itself: read the status again at that minute, so Change and Remove come back without a reload.
  const lockedUntil = s?.locked ? s.lockedUntil : undefined;
  useEffect(() => {
    const wait = lockedUntil ? Date.parse(lockedUntil) - Date.now() + 1000 : Number.NaN;
    if (!Number.isFinite(wait) || wait > 2 ** 31 - 1) return;
    const timer = setTimeout(() => void refetch(), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [lockedUntil, refetch]);

  return (
    <section aria-labelledby={`${uid}-title`} data-testid="pin-card" className="rounded-xl border border-border p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id={`${uid}-title`} className="font-sans text-sm font-semibold tracking-normal text-fg">{t.title}</h4>
            {status.isLoading ? (
              <Skeleton className="h-5 w-12 rounded-full" />
            ) : s ? (
              <Badge tone={s.locked ? 'danger' : s.hasPin ? 'success' : 'neutral'} dot={s.hasPin && !s.locked} data-testid="pin-badge">
                {s.locked ? t.locked : s.hasPin ? t.on : t.off}
              </Badge>
            ) : null}
            {s?.required && <Badge tone="info" size="sm">{t.required}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted" data-testid="pin-status">
            {status.isLoading ? (
              <Skeleton className="h-3.5 w-56" />
            ) : status.isError ? (
              <span className="inline-flex flex-wrap items-center gap-2 text-danger">
                {errorMessage(status.error, 'Could not load your PIN status')}
                <Button variant="outline" size="xs" onClick={() => void status.refetch()} leftIcon={<RefreshCw aria-hidden />}>Try again</Button>
              </span>
            ) : s?.locked ? (
              t.lockedHint(pinUnlockTime(s.lockedUntil))
            ) : s?.hasPin ? (
              <>
                {t.setAt} <span className="font-medium text-fg">{formatDate(s.setAt)}</span>
              </>
            ) : (
              t.offHint
            )}
          </p>
          {s?.required && !s.locked && <p className="mt-1.5 text-xs text-muted">{t.requiredHint}</p>}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {s?.hasPin ? (
            <>
              <Button variant="outline" onClick={() => setModal('set')} disabled={s.locked} leftIcon={<KeyRound aria-hidden />}>{t.change}</Button>
              {!s.required && (
                <Button variant="outline" onClick={() => setModal('remove')} disabled={s.locked} leftIcon={<Trash2 aria-hidden />}>{t.remove}</Button>
              )}
            </>
          ) : (
            <Button onClick={() => setModal('set')} disabled={!s} leftIcon={<KeyRound aria-hidden />}>{t.set}</Button>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{t.description} {t.lockRule}</p>

      {modal === 'set' && <SetPinModal changing={Boolean(s?.hasPin)} onClose={close} />}
      {modal === 'remove' && <RemovePinModal onClose={close} />}
    </section>
  );
}

/** The `path` of the first validation detail of an ApiError ('pin', 'currentPin'), if any. */
function errorField(e: unknown): string | null {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return null;
  const first = e.details[0] as { path?: unknown } | undefined;
  return typeof first?.path === 'string' ? first.path : null;
}

/** After a 423 the card behind the dialog should show the lock too: read the PIN status again. */
function useRefreshOnLock(): (e: unknown) => void {
  const qc = useQueryClient();
  return (e) => {
    if (e instanceof ApiError && e.status === 423) void qc.invalidateQueries({ queryKey: pinKeys.status, exact: true });
  };
}

/** A refusal that is not about one field: locked (423, the server's sentence says until when), too many tries (429), network. */
function generalError(e: unknown): string {
  if (e instanceof ApiError && e.status === 423) return apiMessage(e, PIN_COPY.login.locked);
  if (e instanceof ApiError && e.status === 429) return apiMessage(e, PIN_COPY.login.tooMany);
  return apiMessage(e, 'Could not save your PIN. Try again.');
}

function SetPinModal({ changing, onClose }: { changing: boolean; onClose: () => void }) {
  const t = PIN_COPY.settings;
  const user = useCurrentUser();
  const toast = useToast();
  const save = useSetPin();
  const refreshOnLock = useRefreshOnLock();
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  /** Errors show for a field once it was left with something in it, and for every field after a submit. */
  const [submitted, setSubmitted] = useState(false);
  const [pinLeft, setPinLeft] = useState(false);
  const [againLeft, setAgainLeft] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problem = pinProblem(pin, { employeeId: user.employeeId });
  const currentError = fieldError?.field === 'currentPin' ? fieldError.message : submitted && changing && !isPinFormatValid(current) ? t.currentNeeded : null;
  const pinError = fieldError?.field === 'pin' ? fieldError.message : (submitted || pinLeft) && problem ? PIN_PROBLEM_MESSAGES[problem] : null;
  const againError = (submitted || againLeft) && !problem && again !== pin ? PIN_COPY.mismatch : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    setFieldError(null);
    if ((changing && !isPinFormatValid(current)) || problem || again !== pin || save.isPending) return;
    try {
      await save.mutateAsync({ pin, ...(changing ? { currentPin: current } : {}) });
      toast.success(t.savedToast, t.savedToastBody);
      onClose();
    } catch (err) {
      refreshOnLock(err);
      const field = errorField(err);
      if (field === 'currentPin' || field === 'pin') {
        setFieldError({ field, message: apiMessage(err, 'Check this field') });
        if (field === 'currentPin') setCurrent('');
      } else {
        setError(generalError(err));
      }
    }
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title={changing ? t.changeTitle : t.setTitle}
      icon={<KeyRound aria-hidden />}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form={formId} loading={save.isPending} disabled={!pin || !again || (changing && !current)}>{t.save}</Button>
        </>
      }
    >
      {error && <p role="alert" className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-fg">{error}</p>}
      <form id={formId} onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
        <input type="text" name="username" autoComplete="username" value={user.email} readOnly tabIndex={-1} aria-hidden className="sr-only" />
        {changing && (
          <PinField htmlFor={`${uid}-current`} label={t.currentLabel} error={currentError}>
            <PinInput id={`${uid}-current`} autoComplete="current-password" value={current} onChange={(v) => { setCurrent(v); setFieldError(null); }} invalid={!!currentError} disabled={save.isPending} />
          </PinField>
        )}
        <PinField htmlFor={`${uid}-pin`} label={t.newLabel} hint={PIN_COPY.rulesHint} error={pinError}>
          <PinInput
            id={`${uid}-pin`}
            autoComplete="new-password"
            value={pin}
            onChange={(v) => { setPin(v); setFieldError(null); }}
            onBlur={() => { if (pin) setPinLeft(true); }}
            invalid={!!pinError}
            disabled={save.isPending}
          />
        </PinField>
        <PinField htmlFor={`${uid}-again`} label={t.confirmLabel} error={againError}>
          <PinInput
            id={`${uid}-again`}
            autoComplete="new-password"
            value={again}
            onChange={setAgain}
            onBlur={() => { if (again) setAgainLeft(true); }}
            invalid={!!againError}
            disabled={save.isPending}
          />
        </PinField>
      </form>
    </Modal>
  );
}

function RemovePinModal({ onClose }: { onClose: () => void }) {
  const t = PIN_COPY.settings;
  const user = useCurrentUser();
  const toast = useToast();
  const remove = useRemovePin();
  const refreshOnLock = useRefreshOnLock();
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isPinFormatValid(current) || remove.isPending) return;
    setError(null);
    try {
      await remove.mutateAsync({ currentPin: current });
      toast.success(t.removedToast);
      onClose();
    } catch (err) {
      refreshOnLock(err);
      setError(errorField(err) === 'currentPin' ? apiMessage(err, PIN_COPY.login.wrong) : generalError(err));
      setCurrent('');
    }
  }

  const formId = `${uid}-remove`;
  return (
    <Modal
      open
      onClose={onClose}
      title={t.removeTitle}
      description={t.removeBody}
      icon={<Trash2 aria-hidden />}
      tone="danger"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>Cancel</Button>
          <Button type="submit" form={formId} variant="danger" loading={remove.isPending} disabled={!isPinFormatValid(current)}>{t.remove}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void onSubmit(e)} noValidate>
        <input type="text" name="username" autoComplete="username" value={user.email} readOnly tabIndex={-1} aria-hidden className="sr-only" />
        <PinField htmlFor={`${uid}-current`} label={t.currentLabel} error={error}>
          <PinInput id={`${uid}-current`} autoComplete="current-password" value={current} onChange={(v) => { setCurrent(v); setError(null); }} invalid={!!error} disabled={remove.isPending} />
        </PinField>
      </form>
    </Modal>
  );
}

/* ───────────────────────────── sign-in rules (admin) ───────────────────────────── */

const IDLE_CHOICES = [1, 2, 4, 8, 12, 24, 48, 72] as const;

function idleOptions(current: number): { value: string; label: string }[] {
  const hours = IDLE_CHOICES.includes(current as (typeof IDLE_CHOICES)[number]) ? [...IDLE_CHOICES] : [...IDLE_CHOICES, current].sort((a, b) => a - b);
  return hours.map((h) => ({ value: String(h), label: `${PIN_COPY.rules.hours(h)}${h === SESSION_IDLE_HOURS_DEFAULT ? ' (default)' : ''}` }));
}

/** Release 1.4: "Sign out after" — every two hours from 4 to 24 (the server takes any whole hour in the range). */
const MAX_AGE_CHOICES = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24] as const;

function maxAgeOptions(current: number): { value: string; label: string }[] {
  const hours = MAX_AGE_CHOICES.includes(current as (typeof MAX_AGE_CHOICES)[number]) ? [...MAX_AGE_CHOICES] : [...MAX_AGE_CHOICES, current].sort((a, b) => a - b);
  return hours
    .filter((h) => h >= SESSION_MAX_HOURS_MIN && h <= SESSION_MAX_HOURS_MAX)
    .map((h) => ({ value: String(h), label: `${PIN_COPY.rules.hours(h)}${h === SESSION_MAX_HOURS_DEFAULT ? ' (default)' : ''}` }));
}

type RuleKey = 'requirePin';

/**
 * One rule switch. When switching it on would lock out the admin looking at it (`blocked`), the switch is disabled and
 * the reason sits under it at full strength (outside the switch's faded label).
 */
function RuleRow({ checked, onChange, busy, blocked, label, body, blockedNote }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  busy: boolean;
  blocked: boolean;
  label: string;
  body: string;
  blockedNote: string;
}) {
  return (
    <div className="py-3">
      <Switch checked={checked} onChange={onChange} disabled={busy || blocked} label={label} description={body} />
      {blocked && <p className="mt-1 text-xs font-medium text-warning">{blockedNote}</p>}
    </div>
  );
}

function SignInRulesSection() {
  const t = PIN_COPY.rules;
  const uid = useId();
  const toast = useToast();
  const settings = useSecuritySettings();
  const update = useUpdateSecuritySettings();
  const ownPin = usePinStatus();
  const [confirm, setConfirm] = useState<RuleKey | null>(null);
  const s = settings.data;
  const hasOwnPin = Boolean(ownPin.data?.hasPin);
  const maxHours = s?.sessionMaxHours ?? SESSION_MAX_HOURS_DEFAULT;

  async function save(patch: Partial<SecuritySettings>) {
    try {
      await update.mutateAsync(patch);
      toast.success(t.savedToast);
      setConfirm(null);
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    }
  }

  const toggle = (key: RuleKey) => (on: boolean) => {
    if (on) setConfirm(key);
    else void save({ [key]: false });
  };

  return (
    <section aria-labelledby={`${uid}-rules`} data-testid="sign-in-rules" className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`${uid}-rules`} className="font-sans text-sm font-semibold tracking-normal text-fg">{t.title}</h4>
        <Badge tone="primary" size="sm">Admin</Badge>
      </div>
      <p className="mt-1 text-xs text-muted">{t.description}</p>

      {settings.isLoading ? (
        <div className="mt-4 space-y-3" aria-busy>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : settings.isError || !s ? (
        <p className="mt-4 inline-flex flex-wrap items-center gap-2 text-sm text-danger">
          {errorMessage(settings.error, 'Could not load the sign-in rules')}
          <Button variant="outline" size="xs" onClick={() => void settings.refetch()} leftIcon={<RefreshCw aria-hidden />}>Try again</Button>
        </p>
      ) : (
        <div className="mt-3 divide-y divide-border">
          <RuleRow
            checked={s.requirePin}
            onChange={toggle('requirePin')}
            busy={update.isPending}
            blocked={!s.requirePin && !hasOwnPin}
            label={t.requirePin}
            body={t.requirePinBody}
            blockedNote={t.requirePinNeedsOwn}
          />
          {/* Release 1.4 (package S): not a switch any more — required for every account */}
          <div className="flex items-start gap-3 py-3" data-testid="two-factor-everyone">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{t.twoFactorEveryone}</p>
              <p className="mt-0.5 text-xs text-muted">{t.twoFactorEveryoneBody}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <label htmlFor={`${uid}-max-age`} className="text-sm font-medium text-fg">{t.maxAge}</label>
              <p className="mt-0.5 text-xs text-muted">{t.maxAgeHint(maxHours)}</p>
            </div>
            <Select
              id={`${uid}-max-age`}
              data-testid="session-max-hours"
              className="sm:w-44"
              value={String(maxHours)}
              onChange={(e) => void save({ sessionMaxHours: Number(e.target.value) })}
              options={maxAgeOptions(maxHours)}
              disabled={update.isPending}
            />
          </div>
          <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <label htmlFor={`${uid}-idle`} className="text-sm font-medium text-fg">{t.idle}</label>
              <p className="mt-0.5 text-xs text-muted">{t.idleHint(s.sessionIdleHours)}</p>
            </div>
            <Select
              id={`${uid}-idle`}
              data-testid="session-idle-hours"
              className="sm:w-44"
              value={String(s.sessionIdleHours)}
              onChange={(e) => void save({ sessionIdleHours: Number(e.target.value) })}
              options={idleOptions(s.sessionIdleHours)}
              disabled={update.isPending}
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'requirePin'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void save({ requirePin: true })}
        title={t.requirePinConfirmTitle}
        description={t.requirePinConfirmBody}
        confirmLabel={t.turnOn}
        loading={update.isPending}
      />
    </section>
  );
}
