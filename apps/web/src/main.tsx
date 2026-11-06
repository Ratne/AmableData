import { loadCatalog } from '@amable/i18n/client';
import { ThemeProvider, Toaster } from '@amable/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StepUpProvider } from './features/auth/step-up';
import { I18nProvider, initialLocale } from './i18n';
import { installActivityTracking } from './lib/activity';
import { savePreferences } from './lib/api';
import { router } from './router';
import { ActivityBar } from './shell/activity-bar';
import './styles.css';

installActivityTracking();
// Start the catalog download before React mounts; the provider picks up the same promise.
void loadCatalog(initialLocale()).catch(() => undefined);

/** 4xx answers (ApiError, TenantApiError) do not change on retry. */
function isClientError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// Fresh for 30 s: navigating back or refocusing the tab reuses the cache; mutations still invalidate.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => failureCount < 2 && !isClientError(error),
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('#root element missing in index.html');
}

// Language and theme are applied locally at once, mirrored in the cookie, then saved on the user.
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider onLocaleChange={(locale) => savePreferences({ locale })}>
        <ThemeProvider onThemeChange={(theme) => savePreferences({ theme })}>
          <ActivityBar />
          <RouterProvider router={router} />
          <StepUpProvider />
          <Toaster />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
