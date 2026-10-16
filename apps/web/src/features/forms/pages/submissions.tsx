import type { FormSubmission, SubmissionStatus } from '@amable/api-types';
import { displayValue, type FormField, type SubmissionValue } from '@amable/forms';
import {
  DashboardButton,
  DashboardFilterMenu,
  ListTable,
  PageBody,
  PageToolbar,
  type ListTableColumn,
  type ListTableRowAction,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@amable/ui/ui/sheet';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { RefreshCw, Trash2, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { formsKeys, useDates, useForm, useForms, useFormsMutation, usePermissions } from '../api/hooks';
import { ErrorNotice, Pill, SectionCard, type Tone } from '../components/common';
import { useFormChrome } from '../components/form-chrome';

const STATUS_TONE: Record<SubmissionStatus, Tone> = { pending: 'info', processed: 'success', failed: 'danger' };
const DELIVERY_TONE = { success: 'success', failed: 'danger', skipped: 'neutral', retrying: 'warning' } as const;

function isValue(value: unknown): value is SubmissionValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string'))
  );
}

function valueText(fields: Map<string, FormField>, key: string, value: unknown, yes: string, no: string): string {
  if (!isValue(value)) return '';
  if (typeof value === 'boolean') return value ? yes : no;
  return displayValue(fields.get(key), value);
}

export function SubmissionsPage() {
  const { t } = useI18n();
  const { formId = '' } = useParams({ strict: false }) as { formId?: string };
  const search: { submission?: unknown } = useSearch({ strict: false });
  const { slug, api } = useForms();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { dateTime } = useDates();
  const form = useForm(formId);
  useFormChrome(formId, form.data, 'submissions');
  const [status, setStatus] = useState<'all' | SubmissionStatus>('all');
  const [openId, setOpenId] = useState<string | null>(typeof search.submission === 'string' ? search.submission : null);

  const fields = useMemo(() => new Map((form.data?.definition.fields ?? []).map((f) => [f.key, f])), [form.data]);
  const submissions = useInfiniteQuery({
    queryKey: [...formsKeys.submissions(slug, formId), status],
    queryFn: ({ pageParam }) =>
      api.submissions.list(formId, { ...(pageParam === '' ? {} : { cursor: pageParam }), ...(status === 'all' ? {} : { status }) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => submissions.data?.pages.flatMap((p) => p.data) ?? [], [submissions.data]);
  const open = rows.find((r) => r.id === openId) ?? null;
  const writable = can('forms:write');

  const reprocess = useFormsMutation({
    mutationFn: (id: string) => api.submissions.reprocess(formId, id),
    invalidate: [formsKeys.submissions(slug, formId)],
    success: t('forms.submissions.reprocessed'),
  });
  const remove = useFormsMutation({
    mutationFn: (id: string) => api.submissions.remove(formId, id),
    invalidate: [formsKeys.submissions(slug, formId), formsKeys.root(slug)],
    success: t('forms.submissions.deleted'),
    onSuccess: () => setOpenId(null),
  });

  const preview = (s: FormSubmission): string =>
    Object.entries(s.values)
      .filter(([key]) => fields.get(key)?.sensitive !== true)
      .slice(0, 3)
      .map(([key, value]) => valueText(fields, key, value, t('forms.common.yes'), t('forms.common.no')))
      .filter((v) => v !== '')
      .join(' · ');

  const columns: ListTableColumn<FormSubmission>[] = [
    { id: 'date', header: t('forms.submissions.date'), cell: (s) => dateTime(s.created_at) },
    { id: 'summary', header: t('forms.submissions.summary'), cell: (s) => <span className="truncate">{preview(s)}</span> },
    {
      id: 'status',
      header: t('forms.field.status'),
      cell: (s) => <Pill tone={STATUS_TONE[s.status]}>{t(`forms.submissions.status.${s.status}`)}</Pill>,
    },
    {
      id: 'contact',
      header: t('forms.submissions.contact'),
      cell: (s) =>
        s.contact_id ? (
          <Link
            to="/t/$tenant/contacts/$contactId"
            params={{ tenant: slug, contactId: s.contact_id }}
            className="text-primary underline-offset-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {s.contact_created ? t('forms.submissions.newContact') : t('forms.submissions.existingContact')}
          </Link>
        ) : (
          '—'
        ),
      hideBelow: 'md',
    },
    {
      id: 'deliveries',
      header: t('forms.submissions.deliveries'),
      cell: (s) => (
        <span className="flex flex-wrap gap-1">
          {s.deliveries.map((d) => (
            <Pill key={d.id} tone={DELIVERY_TONE[d.status]}>
              {d.connection_name}
            </Pill>
          ))}
        </span>
      ),
      hideBelow: 'lg',
    },
  ];

  const rowActions = (s: FormSubmission): ListTableRowAction<FormSubmission>[] =>
    writable
      ? [
          { id: 'reprocess', label: t('forms.submissions.reprocess'), icon: RefreshCw, onSelect: () => reprocess.mutate(s.id) },
          { id: 'delete', label: t('forms.submissions.delete'), icon: Trash2, tone: 'danger', separatorBefore: true, onSelect: () => remove.mutate(s.id) },
        ]
      : [];

  return (
    <>
      <PageToolbar
        filters={
          <DashboardFilterMenu
            label={t('forms.field.status')}
            value={status}
            onValueChange={(value) => setStatus(value as 'all' | SubmissionStatus)}
            options={(['all', 'pending', 'processed', 'failed'] as const).map((value) => ({
              value,
              label: value === 'all' ? t('forms.filter.all') : t(`forms.submissions.status.${value}`),
            }))}
          />
        }
      />
      {submissions.error ? (
        <PageBody>
          <ErrorNotice error={submissions.error} />
        </PageBody>
      ) : (
        <ListTable<FormSubmission>
          className="px-4"
          rows={rows}
          getRowId={(s) => s.id}
          getRowLabel={(s) => preview(s) || s.id}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          manualSorting
          loading={submissions.isPending}
          onRowOpen={(s) => setOpenId(s.id)}
          rowActions={writable ? rowActions : undefined}
          emptyState={<p className="py-10 text-center text-sm text-muted-foreground">{t('forms.submissions.empty')}</p>}
          footer={
            submissions.hasNextPage ? (
              <div className="flex justify-center py-3">
                <DashboardButton variant="ghost" disabled={submissions.isFetchingNextPage} onClick={() => void submissions.fetchNextPage()}>
                  {t('forms.common.loadMore')}
                </DashboardButton>
              </div>
            ) : null
          }
        />
      )}
      <Sheet open={open !== null} onOpenChange={(next) => (next ? undefined : setOpenId(null))}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {open ? (
            <>
              <SheetHeader>
                <SheetTitle>{t('forms.submissions.detail', { date: dateTime(open.created_at) })}</SheetTitle>
              </SheetHeader>
              <div className="grid gap-4 px-4 pb-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={STATUS_TONE[open.status]}>{t(`forms.submissions.status.${open.status}`)}</Pill>
                  {open.contact_id ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void navigate({ to: '/t/$tenant/contacts/$contactId', params: { tenant: slug, contactId: open.contact_id ?? '' } })
                      }
                    >
                      <UserRound aria-hidden /> {t('forms.submissions.openContact')}
                    </Button>
                  ) : null}
                  {writable ? (
                    <>
                      <Button variant="outline" size="sm" disabled={reprocess.isPending} onClick={() => reprocess.mutate(open.id)}>
                        <RefreshCw aria-hidden /> {t('forms.submissions.reprocess')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(open.id)}>
                        <Trash2 aria-hidden /> {t('forms.submissions.delete')}
                      </Button>
                    </>
                  ) : null}
                </div>
                {open.error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{open.error}</p> : null}
                {open.warnings.length > 0 ? (
                  <ul className="list-disc rounded-lg bg-amber-500/10 px-6 py-2 text-sm text-amber-800 dark:text-amber-200">
                    {open.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                <SectionCard title={t('forms.submissions.values')}>
                  <dl className="grid gap-2 text-sm">
                    {Object.entries(open.values).map(([key, value]) => (
                      <div key={key} className="grid gap-0.5">
                        <dt className="text-xs text-muted-foreground">{fields.get(key)?.label || key}</dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {valueText(fields, key, value, t('forms.common.yes'), t('forms.common.no'))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </SectionCard>
                <SectionCard title={t('forms.submissions.source')}>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    {Object.entries({ ...open.source, ...open.tracking })
                      .filter(([, value]) => value !== null && value !== '')
                      .map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-muted-foreground">{key}</dt>
                          <dd className="truncate">{String(value)}</dd>
                        </div>
                      ))}
                  </dl>
                </SectionCard>
                <SectionCard title={t('forms.submissions.deliveries')}>
                  {open.deliveries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('forms.submissions.noDeliveries')}</p>
                  ) : (
                    <ul className="grid gap-2 text-sm">
                      {open.deliveries.map((d) => (
                        <li key={d.id} className="grid gap-1 rounded-lg border p-2">
                          <span className="flex items-center gap-2">
                            <span className="font-medium">{d.connection_name}</span>
                            <Pill tone={DELIVERY_TONE[d.status]}>{t(`forms.delivery.${d.status}`)}</Pill>
                            <span className="text-xs text-muted-foreground">
                              {t('forms.submissions.attempts', { count: d.attempts })} · {dateTime(d.updated_at)}
                            </span>
                          </span>
                          {d.response ? <code className="block truncate text-xs text-muted-foreground">{d.response}</code> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionCard>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
