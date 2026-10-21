// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// Settings → Company (admin): legal name, address, company number, the authorised signatory and an optional signature
// image, printed on every self-billing invoice. Mounted in pages/Settings.tsx in the left column after Settings → Pay,
// administrators only, in an ErrorBoundary with fallback={null}. Render a whole Card.
export interface CompanySettingsSectionProps {
  className?: string;
}

export function CompanySettingsSection(_props: CompanySettingsSectionProps) {
  return null;
}
