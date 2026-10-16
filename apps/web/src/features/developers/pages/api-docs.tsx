import { PageBody, usePageChrome } from '@amable/ui';
import { useI18n } from '../../../i18n';
import { ApiReference } from '../openapi-viewer';

/** Settings → API reference (inside the workspace shell). */
export function ApiDocsPage() {
  const { t } = useI18n();
  usePageChrome({ title: t('dev.docs.title') });
  return (
    <PageBody className="pt-4">
      <ApiReference />
    </PageBody>
  );
}

/** Public `/docs/api`: the same reference without signing in (the document holds no data). */
export function PublicApiDocsPage() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold">
          {t('common.appName')} · {t('dev.docs.title')}
        </h1>
      </header>
      <div className="mx-auto max-w-7xl px-6 py-6">
        <ApiReference />
      </div>
    </div>
  );
}
