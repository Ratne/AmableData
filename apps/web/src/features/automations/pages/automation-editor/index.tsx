import '@xyflow/react/dist/style.css';
import type { AutomationDetail } from '@amable/api-types';
import { usePageChrome } from '@amable/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../../i18n';
import { CrmApiError } from '../../../crm/api/client';
import { errorMessage } from '../../../crm/api/hooks';
import { automationKeys, useAutomationApi } from '../../api/hooks';
import { Editor } from './editor';

/** `/t/$tenant/automations/$automationId` — the canvas editor. */
export function AutomationEditorPage() {
  const { t } = useI18n();
  const params = useParams({ strict: false });
  const automationId = (params as { automationId?: string }).automationId ?? '';
  const { slug, api } = useAutomationApi();
  const detail = useQuery({
    queryKey: automationKeys.detail(slug, automationId),
    queryFn: () => api.get(automationId),
    retry: false,
  });
  // The canvas keeps its own state: only the first load seeds it.
  const [seed, setSeed] = useState<AutomationDetail | null>(null);
  useEffect(() => {
    if (seed === null && detail.data !== undefined) setSeed(detail.data);
  }, [detail.data, seed]);

  const data = detail.data;
  usePageChrome({
    title: data?.name ?? t('auto.title'),
    ...(data === undefined
      ? {}
      : {
          status:
            data.status === 'active' && data.has_unpublished_changes
              ? `${t('auto.status.active')} · ${t('auto.status.unpublished')}`
              : t(`auto.status.${data.status}`),
          statusTone:
            data.status === 'active'
              ? 'success'
              : data.status === 'inactive'
                ? 'warning'
                : 'neutral',
        }),
  });
  if (detail.isError) {
    const notFound = detail.error instanceof CrmApiError && detail.error.status === 404;
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {notFound ? t('crm.error.notFound') : errorMessage(t, detail.error)}
      </div>
    );
  }
  if (seed === null || detail.data === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">{t('auto.loading')}</div>;
  }
  return (
    <ReactFlowProvider>
      <EditorFrame seed={seed} current={detail.data} />
    </ReactFlowProvider>
  );
}

/** The editor gets the live metadata (status, versions) but the seed graph only once. */
function EditorFrame({ seed, current }: { seed: AutomationDetail; current: AutomationDetail }) {
  const merged = useMemo(
    () => ({ ...current, draft_graph: seed.draft_graph, draft_revision: seed.draft_revision }),
    [current, seed],
  );
  return <Editor detail={merged} />;
}
