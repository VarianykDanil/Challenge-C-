import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ApiError, NETWORK_EVENT, isNetworkError, type NetworkEventDetail } from './api/client';
// Inter (variable weight, Latin and other scripts split by unicode-range) served from this app, not Google Fonts.
import '@fontsource-variable/inter/wght.css';
import './index.css';
import { registerServiceWorker } from './offline/serviceWorker';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Never retry auth/permission errors; retry transient failures once. With no signal at all, after a read that
      // already waited its time limit, or while the proxy says the app is down, fail at once: the page shows "You're
      // offline" instead of loading forever, and it refetches when the app answers again (below).
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
        !(isNetworkError(error) && (error.reason !== 'unreachable' || (typeof navigator !== 'undefined' && navigator.onLine === false))) &&
        failureCount < 1,
      // Try the request even when the browser says it is offline (it then fails and says so) rather than waiting
      // silently; the app shell itself comes from the service worker.
      networkMode: 'offlineFirst',
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// When the app answers again after it could not be reached (lm:network false → true), pages that failed for that
// reason load again by themselves. The browser's own 'online' event does this for TanStack Query when the phone's
// signal comes back; this covers a server that was down or not answering while the phone had signal.
let appReachable = true;
window.addEventListener(NETWORK_EVENT, (e) => {
  const online = !!(e as CustomEvent<NetworkEventDetail>).detail?.online;
  if (online && !appReachable) {
    void queryClient.refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' && isNetworkError(q.state.error) });
  }
  appReachable = online;
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

// The offline app (a secure address only; nothing happens on plain http:// or in development).
registerServiceWorker();
