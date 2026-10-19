import { ESIGN_REQUEST_STATUSES, type EsignRequest, type EsignRequestStatus } from '@amable/api-types';
import { DashboardButton, ListTable, PageBody, PageToolbar, type ListTableColumn } from '@amable/ui';
import { useNavigate } from '@tanstack/react-router';
import { Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { ChoiceSelect, ListFooter } from '../../commerce/components/common';
import { useEsign, useEsignDates, useEsignPermissions, useRequests, useTemplates } from '../api/hooks';
import { ErrorNotice, RequestStatusPill, useEsignChrome } from '../components/common';
import { SendDialog } from '../components/send-dialog';

export function EsignRequestsPage() {
  const { t } = useI18n();
  const { slug } = useEsign();
  const { can } = useEsignPermissions();
  const navigate = useNavigate();
  const dates = useEsignDates();
  useEsignChrome('requests');
  const [status, setStatus] = useState<EsignRequestStatus | ''>('');
  const [templateId, setTemplateId] = useState('');
  const [sending, setSending] = useState(false);
  const templates = useTemplates();
  const requests = useRequests({ status: status === '' ? undefined : status, template_id: templateId === '' ? undefined : templateId });
  const rows = useMemo(() => requests.data?.pages.flatMap((page) => page.data) ?? [], [requests.data]);
  const open = (request: EsignRequest) => void navigate({ to: '/t/$tenant/signatures/$requestId', params: { tenant: slug, requestId: request.id } });

  const columns: ListTableColumn<EsignRequest>[] = [
    { id: 'name', header: t('esign.field.document'), cell: (r) => <span className="truncate font-medium">{r.name}</span>, sortable: true, sortValue: (r) => r.name.toLowerCase() },
    {
      id: 'signers',
      header: t('esign.field.signers'),
      cell: (r) => {
        const signed = r.signers.filter((s) => s.status === 'completed').length;
        return (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{r.signers.map((s) => s.name || s.email).join(', ')}</span>
            <span className="text-xs text-muted-foreground">{t('esign.requests.signedCount', { signed, total: r.signers.length })}</span>
          </span>
        );
      },
      hideBelow: 'md',
    },
    { id: 'status', header: t('esign.field.status'), cell: (r) => <RequestStatusPill status={r.status} /> },
    { id: 'origin', header: t('esign.field.origin'), cell: (r) => t(`esign.origin.${r.origin}`), hideBelow: 'lg' },
    { id: 'created', header: t('esign.field.sentAt'), cell: (r) => dates.dateTime(r.created_at), sortable: true, sortValue: (r) => r.created_at, hideBelow: 'md' },
  ];

  return (
    <>
      <PageToolbar
        filters={
          <div className="flex flex-wrap items-center gap-2">
            <ChoiceSelect
              value={status}
              onChange={(next) => setStatus(next as EsignRequestStatus | '')}
              emptyLabel={t('esign.filter.allStatuses')}
              ariaLabel={t('esign.field.status')}
              choices={ESIGN_REQUEST_STATUSES.map((value) => ({ value, label: t(`esign.requestStatus.${value}`) }))}
            />
            <ChoiceSelect
              value={templateId}
              onChange={setTemplateId}
              emptyLabel={t('esign.filter.allTemplates')}
              ariaLabel={t('esign.field.template')}
              choices={(templates.data ?? []).map((tpl) => ({ value: tpl.id, label: tpl.name }))}
            />
          </div>
        }
        actions={
          can('esign:write') ? (
            <DashboardButton variant="primary" onClick={() => setSending(true)}>
              <Send aria-hidden /> {t('esign.requests.new')}
            </DashboardButton>
          ) : null
        }
      />
      {requests.error ? (
        <PageBody>
          <ErrorNotice error={requests.error} />
        </PageBody>
      ) : (
        <div className="px-4">
          <ListTable<EsignRequest>
            rows={rows}
            getRowId={(r) => r.id}
            getRowLabel={(r) => r.name}
            columns={columns}
            labels={listTableLabels(t)}
            defaultSort={{ columnId: 'created', direction: 'desc' }}
            loading={requests.isPending}
            onRowOpen={open}
            emptyState={<p className="py-10 text-center text-sm text-muted-foreground">{t('esign.requests.empty')}</p>}
          />
          <ListFooter hasMore={requests.hasNextPage} loading={requests.isFetchingNextPage} onMore={() => void requests.fetchNextPage()} />
        </div>
      )}
      {sending ? <SendDialog onClose={() => setSending(false)} /> : null}
    </>
  );
}
