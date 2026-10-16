import { usePageChrome } from '@amable/ui';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '../../../i18n';
import { useLanding } from '../api/hooks';
import type { LandingPage } from '../api/types';

export type PageSection = 'editor' | 'settings';

const PATHS: Record<PageSection, '/t/$tenant/landing-pages/$pageId/edit' | '/t/$tenant/landing-pages/$pageId/settings'> = {
  editor: '/t/$tenant/landing-pages/$pageId/edit',
  settings: '/t/$tenant/landing-pages/$pageId/settings',
};

/** Header of a landing page: title, publish status and the editor / settings tabs. */
export function useLandingChrome(pageId: string, page: Pick<LandingPage, 'title' | 'status'> | undefined, section: PageSection): void {
  const { t } = useI18n();
  const { slug } = useLanding();
  const navigate = useNavigate();
  usePageChrome({
    title: page ? page.title || t('landing.untitled') : t('nav.landingPages'),
    ...(page === undefined
      ? {}
      : {
          status: t(`landing.status.${page.status}`),
          statusTone: page.status === 'published' ? ('success' as const) : ('neutral' as const),
        }),
    tabs: (['editor', 'settings'] as const).map((value) => ({ value, label: t(`landing.tab.${value}`) })),
    tab: section,
    onTabChange: (value) => {
      const next = value as PageSection;
      if (next !== section) void navigate({ to: PATHS[next], params: { tenant: slug, pageId } });
    },
  });
}
