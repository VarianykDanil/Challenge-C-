// Release 1.2 slot — OWNED BY U1 sign-in-pin (laid down by r2-foundation; renders nothing until U1 fills it).
// Settings > Security: set / change your PIN, and for admins the sign-in settings (require a PIN for everyone,
// require two-step for administrators, session idle timeout). Mounted in pages/Settings.tsx inside the Security card,
// under two-step verification, in an ErrorBoundary with fallback={null}; `className` carries the spacing (mt-4).
export interface PinSettingsProps {
  className?: string;
}

export function PinSettings(_props: PinSettingsProps) {
  return null;
}
