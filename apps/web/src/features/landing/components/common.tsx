import { type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { errorMessage } from '../api/hooks';
import { ApiErrorNotice, QueryPageState } from '../../../components/feature-kit';

export { Pill, FormField, SectionCard, Choice, type Tone } from '../../../components/feature-kit';

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <ApiErrorNotice
      error={error}
      message={errorMessage(t, error)}
      forbiddenTitle={t('landing.error.forbiddenTitle')}
    />
  );
}

export function PageState(props: {
  isPending: boolean;
  error: unknown;
  children: () => ReactNode;
}) {
  return <QueryPageState {...props} notice={(error) => <ErrorNotice error={error} />} />;
}

/** Normalizes a page path typed by the user: leading slash, no spaces, no trailing slash. */
export function normalizePath(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, '-').toLowerCase();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

export function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/${slug}`;
}
