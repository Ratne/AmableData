import type { Site } from '@amable/api-types';
import { Globe } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { EmptyNote, Panel } from '../components/ui';

/** Settings tab `domains` — placeholder until custom tracking domains are implemented. */
export function DomainsTab({
  tenant: _tenant,
  site: _site,
  canConfigure: _canConfigure,
}: {
  tenant: string;
  site: Site;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  return (
    <Panel title={t('analytics.domains.title')}>
      <EmptyNote className="flex-col gap-2">
        <Globe className="size-5" aria-hidden />
        {t('analytics.stub.soon')}
      </EmptyNote>
    </Panel>
  );
}
