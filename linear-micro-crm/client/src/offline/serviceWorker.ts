// Registers the offline service worker (dist/sw.js, built from client/sw/) and tells the app when a new release is
// ready, so it can offer to reload.
//
// Service workers only run on a secure address (https://, or localhost on the server's own computer). On a plain
// http:// address over the office Wi-Fi the browser has no service worker at all: nothing registers, nothing breaks,
// and the app works as before (saves with no signal still wait in the outbox while the page is open).
import { useSyncExternalStore } from 'react';

export interface ServiceWorkerState {
  /** The browser can run the offline app here (a secure address and a browser that supports it). */
  supported: boolean;
  /** The app is saved on this phone, so it opens with no signal. */
  offlineReady: boolean;
  /** A new release is downloaded and waiting; reloading switches to it. */
  updateReady: boolean;
}

let state: ServiceWorkerState = { supported: false, offlineReady: false, updateReady: false };
const listeners = new Set<() => void>();
let waiting: ServiceWorker | null = null;

function set(next: Partial<ServiceWorkerState>): void {
  const merged = { ...state, ...next };
  if (merged.supported === state.supported && merged.offlineReady === state.offlineReady && merged.updateReady === state.updateReady) return;
  state = merged;
  for (const l of listeners) l();
}

/** True where a service worker can run: a browser with the API on a secure address. */
export function serviceWorkerSupported(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext === true && 'serviceWorker' in navigator;
  } catch {
    return false;
  }
}

/** Re-check for a new release this often while the app is open, and whenever it comes back to the front. */
const UPDATE_CHECK_MS = 30 * 60_000;

function watchWaiting(reg: ServiceWorkerRegistration): void {
  const offerUpdate = (sw: ServiceWorker | null) => {
    if (!sw) return;
    waiting = sw;
    // a first install (no worker controlled this page yet) is not an update: the app is simply saved now
    if (navigator.serviceWorker.controller) set({ updateReady: true });
  };
  if (reg.waiting) offerUpdate(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed') {
        if (navigator.serviceWorker.controller) offerUpdate(sw);
        else set({ offlineReady: true });
      }
      if (sw.state === 'activated') set({ offlineReady: true });
    });
  });
}

let started = false;

/** Called once at start-up (src/main.tsx). Never throws; does nothing in development or on an insecure address. */
export function registerServiceWorker(): void {
  if (started || import.meta.env.DEV || !serviceWorkerSupported()) return;
  started = true;
  set({ supported: true });
  const go = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      if (reg.active) set({ offlineReady: true });
      watchWaiting(reg);
      const check = () => void reg.update().catch(() => undefined);
      window.setInterval(() => {
        if (document.visibilityState === 'visible' && navigator.onLine !== false) check();
      }, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine !== false) check();
      });
    } catch {
      // a failed registration leaves the app as it was before service workers: it still works online
    }
  };
  // after the first screen has loaded, so saving the app never competes with showing it
  if (document.readyState === 'complete') void go();
  else window.addEventListener('load', () => void go(), { once: true });
}

let reloading = false;

/** Switches to the waiting release and reloads the page once it has taken over. */
export function applyUpdate(): void {
  if (!waiting) {
    window.location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useServiceWorker(): ServiceWorkerState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
