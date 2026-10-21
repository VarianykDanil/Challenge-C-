// Release 1.3 slot — OWNED BY P1 pay-rule (laid down by r3-foundation; renders nothing until P1 pay-rule fills it).
// Settings → Pay (admin): the day rate (£63.50) and the date the 1.3 rule applies from (PAY_RULE_FROM). Mounted in
// pages/Settings.tsx in the left column after the backups card, administrators only, in an ErrorBoundary with
// fallback={null}. Render a whole Card (the column spaces cards itself).
export interface PaySettingsSectionProps {
  className?: string;
}

export function PaySettingsSection(_props: PaySettingsSectionProps) {
  return null;
}
