// Offline banner — OWNED BY p7-signal-proof-logging. Mounted by AppShell under the topbar (by file path, not through
// the features/common barrel), inside an ErrorBoundary with fallback={null}.
//
// Shows when the browser reports 'offline' or a request could not reach the server (lm:network false); clears on
// 'online' or the next HTTP response of any kind (lm:network true). While it shows it quietly asks GET /health every
// 30 seconds, so a hotspot that comes back clears it (and replays the gauge outbox) without a tap.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui';
import { api, NETWORK_EVENT, type NetworkEventDetail } from '@/api/client';

const PROBE_MS = 30_000;

export interface OfflineBannerProps {
  /** Add "Gauges you save are kept on this phone." (people who log gauges). */
  gaugeNote?: boolean;
}

export function OfflineBanner({ gaugeNote = true }: OfflineBannerProps) {
  const qc = useQueryClient();
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    const onNetwork = (e: Event) => setOffline(!(e as CustomEvent<NetworkEventDetail>).detail?.online);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    window.addEventListener(NETWORK_EVENT, onNetwork);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      window.removeEventListener(NETWORK_EVENT, onNetwork);
    };
  }, []);

  // Any answer clears the banner through lm:network; a failure keeps it. Errors are expected here, so swallow them.
  const probe = useCallback(() => api('/health').catch(() => undefined), []);

  useEffect(() => {
    if (!offline) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void probe();
    }, PROBE_MS);
    return () => window.clearInterval(id);
  }, [offline, probe]);

  const retry = async () => {
    setRetrying(true);
    try {
      await Promise.allSettled([probe(), qc.refetchQueries({ type: 'active' })]);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div role="status" aria-live="polite">
      {offline && (
        <div data-offline-banner className="border-b border-warning/40 bg-warning-soft px-4 py-1.5 sm:px-6 sm:py-2 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3">
            <WifiOff className="h-5 w-5 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg sm:text-sm">
              <span className="font-semibold">Can&apos;t reach Linear Hub — check the hotspot.</span>
              {gaugeNote && <span className="text-muted"> Gauges you save are kept on this phone.</span>}
            </p>
            {/* Phones: a 40 px icon button keeps the strip to two lines; wider screens show the words. */}
            <span className="shrink-0 sm:hidden">
              <Button variant="outline" size="icon" label="Try again" onClick={() => void retry()} loading={retrying}>
                <RefreshCw aria-hidden />
              </Button>
            </span>
            <span className="hidden shrink-0 sm:block">
              <Button variant="outline" size="md" onClick={() => void retry()} loading={retrying} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}>
                Try again
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
