// Keeps the screen awake while a page is open (the Quick gauges page: a rep counting a shift should not have to unlock
// the phone between stops). Uses the Screen Wake Lock API where it exists — secure contexts only, so plain http over a
// hotspot simply does nothing. Feature-detected, never throws, released on leave and taken again when the tab comes
// back into view (the browser drops the lock whenever the page is hidden).
import { useEffect } from 'react';

interface Sentinel {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}
interface WakeLockApi {
  request: (type: 'screen') => Promise<Sentinel>;
}

function wakeLockApi(): WakeLockApi | null {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext) return null;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    return api && typeof api.request === 'function' ? api : null;
  } catch {
    return null;
  }
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const api = wakeLockApi();
    if (!api) return;
    let sentinel: Sentinel | null = null;
    let pending = false;
    let left = false;

    const acquire = async () => {
      if (left || pending || sentinel || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const s = await api.request('screen');
        if (left) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
      } catch {
        /* refused (battery saver, permissions policy) — the screen just follows the phone's own setting */
      } finally {
        pending = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      left = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinel;
      sentinel = null;
      if (s) void s.release().catch(() => undefined);
    };
  }, [active]);
}
