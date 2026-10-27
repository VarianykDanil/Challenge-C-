import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ApiError, isNetworkError } from './api/client';
// Inter (variable weight, Latin and other scripts split by unicode-range) served from this app, not Google Fonts.
import '@fontsource-variable/inter/wght.css';
import './index.css';
import { registerServiceWorker } from './offline/serviceWorker';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Never retry auth/permission errors; retry transient failures once. With no signal at all, fail at once: the
      // page shows "You're offline" instead of loading forever, and it refetches when the connection is back.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
        !(isNetworkError(error) && typeof navigator !== 'undefined' && navigator.onLine === false) &&
        failureCount < 1,
      // Try the request even when the browser says it is offline (it then fails and says so) rather than waiting
      // silently; the app shell itself comes from the service worker.
      networkMode: 'offlineFirst',
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
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
