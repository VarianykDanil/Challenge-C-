// The topbar bell — OWNED BY p5-needs-attention-feed (moved out of Topbar by p1 with today's behaviour unchanged).
// p5 replaces the internals with useAttention({ poll: true }), the per-device seen set, toasts and the tab badge.
// Contract for p5: keep the export name and the props (Topbar passes them through); the trigger stays a 40 px button.
import { useNavigate } from 'react-router-dom';
import { Bell, Inbox, Settings } from 'lucide-react';
import { Dropdown } from '../ui/Dropdown';

export interface NotificationsBellProps {
  /** Show the unread dot. Off by default (today nothing produces notifications). */
  hasNotifications?: boolean;
  /** Called when the menu opens. */
  onNotifications?: () => void;
}

export function NotificationsBell({ hasNotifications = false, onNotifications }: NotificationsBellProps) {
  const navigate = useNavigate();
  return (
    <Dropdown
      align="end"
      width={272}
      onOpenChange={(o) => { if (o) onNotifications?.(); }}
      header={
        <div>
          <div className="text-sm font-semibold text-fg">Notifications</div>
          <div className="mt-0.5 text-xs text-muted">{hasNotifications ? 'You have new activity.' : 'You’re all caught up.'}</div>
        </div>
      }
      items={[
        { label: hasNotifications ? 'New notifications' : 'No new notifications', icon: <Inbox />, disabled: !hasNotifications },
        { label: 'Settings', icon: <Settings />, onSelect: () => navigate('/settings'), separatorBefore: true },
      ]}
      trigger={
        <button
          type="button"
          aria-label={hasNotifications ? 'Notifications (new)' : 'Notifications'}
          className="focus-ring relative inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Bell className="h-[18px] w-[18px]" aria-hidden />
          {hasNotifications && (
            <span className="absolute right-2.5 top-2.5 flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent ring-2 ring-topbar" />
            </span>
          )}
        </button>
      }
    />
  );
}
