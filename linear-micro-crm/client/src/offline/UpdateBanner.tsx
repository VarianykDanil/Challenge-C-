// "A new version of Linear Hub is ready": shown under the top bar when a new release has been saved on this phone in
// the background (src/offline/serviceWorker.ts). Reloading switches to it; until then the app keeps working as it is.
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';
import { applyUpdate, useServiceWorker } from './serviceWorker';

export function UpdateBanner() {
  const { updateReady } = useServiceWorker();
  return (
    <div role="status" aria-live="polite">
      {updateReady && (
        <div data-update-banner className="border-b border-info/40 bg-info-soft px-4 py-1.5 sm:px-6 sm:py-2 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3">
            <RefreshCw className="h-5 w-5 shrink-0 text-info" aria-hidden />
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg sm:text-sm">
              <span className="font-semibold">A new version of Linear Hub is ready.</span>
              <span className="text-muted"> Reload when you have saved what you are doing.</span>
            </p>
            <Button size="sm" className="shrink-0" onClick={applyUpdate}>Reload</Button>
          </div>
        </div>
      )}
    </div>
  );
}
