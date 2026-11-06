import type { ReactNode } from 'react';
import { ApiErrorNotice, QueryPageState } from '../../../components/feature-kit';
import { useI18n } from '../../../i18n';
import { errorMessage } from '../api/hooks';

/** Inline failure: a permission notice for 403, the API message otherwise. */
export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <ApiErrorNotice
      error={error}
      message={errorMessage(t, error)}
      forbiddenTitle={t('crm.error.forbiddenTitle')}
    />
  );
}

/** Loading skeleton / error for a whole page body. */
export function PageState(props: {
  isPending: boolean;
  error: unknown;
  children: () => ReactNode;
}) {
  return (
    <QueryPageState {...props} skeletons={2} notice={(error) => <ErrorNotice error={error} />} />
  );
}

export function SectionCard({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border bg-card p-4 ${className ?? ''}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
