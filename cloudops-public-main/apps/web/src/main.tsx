import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { shouldRetry } from './lib/api';
import { OrgProvider } from './lib/orgContext';
import { router } from './app/router';
import { ToastProvider } from './components/ui/Toast';
import { DialogProvider } from './components/ui/Dialogs';
// Self-hosted type (offline-first app — no external font CDN). Each file carries
// every subset with unicode-range, so e.g. ₹ (latin-ext) loads only when used.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetry, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OrgProvider>
          <ToastProvider>
            <DialogProvider>
              <RouterProvider router={router} />
            </DialogProvider>
          </ToastProvider>
        </OrgProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
