// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// Settings → Invoices (field people: reps, leaders; recruiters too if P2 decides): the self-billing agreement (read and
// accept) and the supplier details printed on invoices (address, postcode, UTR, VAT number). Mounted in
// pages/Settings.tsx in the left column after the Security card, for every staff role, in an ErrorBoundary with
// fallback={null}. Render a whole Card, or nothing for roles that are not invoiced.
export interface InvoiceSettingsSectionProps {
  className?: string;
}

export function InvoiceSettingsSection(_props: InvoiceSettingsSectionProps) {
  return null;
}
