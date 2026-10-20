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
      forbiddenTitle={t('forms.error.forbiddenTitle')}
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
