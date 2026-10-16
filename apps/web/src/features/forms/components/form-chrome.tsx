import { usePageChrome } from '@amable/ui';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '../../../i18n';
import { useForms, usePermissions } from '../api/hooks';

export type FormSection = 'builder' | 'submissions' | 'connections';

const PATHS: Record<FormSection, '/t/$tenant/forms/$formId' | '/t/$tenant/forms/$formId/submissions' | '/t/$tenant/forms/$formId/connections'> = {
  builder: '/t/$tenant/forms/$formId',
  submissions: '/t/$tenant/forms/$formId/submissions',
  connections: '/t/$tenant/forms/$formId/connections',
};

/** Header of the form pages: title, status and the builder / submissions / connections tabs. */
export function useFormChrome(
  formId: string,
  form: { name: string; status: 'active' | 'inactive'; archived: boolean } | undefined,
  section: FormSection,
): void {
  const { t } = useI18n();
  const { slug } = useForms();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const sections: FormSection[] = ['builder', ...(can('forms:submissions_read') ? (['submissions'] as const) : []), 'connections'];
  usePageChrome({
    title: form?.name ?? t('nav.forms'),
    ...(form === undefined
      ? {}
      : form.archived
        ? { status: t('forms.status.archived'), statusTone: 'neutral' as const }
        : {
            status: t(`forms.status.${form.status}`),
            statusTone: form.status === 'active' ? ('success' as const) : ('warning' as const),
          }),
    tabs: sections.map((value) => ({ value, label: t(`forms.tab.${value}`) })),
    tab: section,
    onTabChange: (value) => {
      const next = value as FormSection;
      if (next !== section) void navigate({ to: PATHS[next], params: { tenant: slug, formId } });
    },
  });
}
