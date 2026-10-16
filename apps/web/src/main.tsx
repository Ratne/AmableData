import { ThemeProvider, Toaster } from '@amable/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StepUpProvider } from './features/auth/step-up';
import { I18nProvider } from './i18n';
import { savePreferences } from './lib/api';
import { router } from './router';
import './styles.css';

const queryClient = new QueryClient();

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
          <RouterProvider router={router} />
          <StepUpProvider />
          <Toaster />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
