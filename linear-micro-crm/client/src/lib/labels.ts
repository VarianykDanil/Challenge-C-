// Owned by the Frontend Developer. Display labels and badge tones for enum-like fields.
import type { CampaignSector, CampaignType, CandidateStage, EventStatus, Interview, PayrollStatus, Position, UserStatus } from '@lm/shared';
import type { BadgeTone } from '@/components/ui';

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  scheduled: 'Scheduled',
  live: 'Live',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const EVENT_STATUS_TONES: Record<EventStatus, BadgeTone> = {
  scheduled: 'info',
  live: 'success',
  completed: 'neutral',
  cancelled: 'danger',
};

export const PAYROLL_STATUS_LABELS: Record<PayrollStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  late: 'Paid late',
  failed: 'Failed',
};
export const PAYROLL_STATUS_TONES: Record<PayrollStatus, BadgeTone> = {
  pending: 'warning',
  paid: 'success',
  late: 'accent',
  failed: 'danger',
};

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  left: 'Left',
};
export const USER_STATUS_TONES: Record<UserStatus, BadgeTone> = {
  active: 'success',
  on_leave: 'warning',
  left: 'neutral',
};

export const STAGE_TONES: Record<CandidateStage, BadgeTone> = {
  applied: 'neutral',
  screening: 'info',
  interview: 'primary',
  observation: 'accent',
  offer: 'warning',
  hired: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
};

export const SECTOR_LABELS: Record<CampaignSector, string> = {
  charity: 'Charity',
  energy: 'Energy',
  telecoms: 'Telecoms',
  broadband: 'Broadband',
  other: 'Other',
};
export const CAMPAIGN_TYPE_LABELS: Record<CampaignType, string> = {
  fundraising: 'Fundraising',
  b2c: 'B2C',
  b2b: 'B2B',
};

export const INTERVIEW_TYPE_LABELS: Record<Interview['type'], string> = {
  phone: 'Phone screen',
  first: 'First interview',
  observation: 'Observation day',
  final: 'Final interview',
};
export const INTERVIEW_OUTCOME_LABELS: Record<Interview['outcome'], string> = {
  pending: 'Pending',
  passed: 'Passed',
  failed: 'Failed',
  no_show: 'No show',
};
export const INTERVIEW_OUTCOME_TONES: Record<Interview['outcome'], BadgeTone> = {
  pending: 'warning',
  passed: 'success',
  failed: 'danger',
  no_show: 'neutral',
};

/** Build `{value,label}` options from a label map, for `<Select>`. */
export function optionsFrom<K extends string>(labels: Record<K, string>, keys?: readonly K[]): { value: K; label: string }[] {
  const ks = keys ?? (Object.keys(labels) as K[]);
  return ks.map((k) => ({ value: k, label: labels[k] }));
}

/** Positions a candidate can apply for — nobody is hired straight into a leadership or office role. */
export const ENTRY_POSITIONS: Position[] = ['trainee', 'field_rep'];
