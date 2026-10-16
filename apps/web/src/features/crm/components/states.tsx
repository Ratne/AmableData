import { PageBody } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { CrmApiError } from '../api/client';
import { errorMessage } from '../api/hooks';

/** Inline failure: a permission notice for 403, the API message otherwise. */
export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  const forbidden = error instanceof CrmApiError && error.status === 403;
  return (
    <Alert variant={forbidden ? 'default' : 'destructive'} role="alert">
      {forbidden ? <ShieldAlert aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{forbidden ? t('crm.error.forbiddenTitle') : t('common.error')}</AlertTitle>
      <AlertDescription>{errorMessage(t, error)}</AlertDescription>
    </Alert>
  );
}

/** Loading skeleton / error for a whole page body. */
export function PageState({
  isPending,
  error,
  children,
}: {
  isPending: boolean;
  error: unknown;
  children: () => ReactNode;
}) {
  if (error) {
    return (
      <PageBody className="pt-4">
        <ErrorNotice error={error} />
      </PageBody>
    );
  }
  if (isPending) {
    return (
      <PageBody className="grid gap-3 pt-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </PageBody>
    );
  }
  return <>{children()}</>;
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
