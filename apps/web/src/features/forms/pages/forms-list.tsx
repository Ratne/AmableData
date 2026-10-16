import type { FormSummary } from '@amable/api-types';
import { defaultFormDefinition } from '@amable/forms';
import {
  DashboardButton,
  DashboardFilterMenu,
  ListTable,
  PageBody,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
  type ListTableRowAction,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Copy, Inbox, Pencil, Plug, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { formsKeys, useDates, useForms, useFormsMutation, usePermissions } from '../api/hooks';
import { ErrorNotice, FormField, Pill } from '../components/common';

type StatusFilter = 'all' | 'active' | 'inactive' | 'archived';

export function FormsListPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useForms();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { dateTime } = useDates();
  usePageChrome({ title: t('nav.forms') });
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [creating, setCreating] = useState(false);
  const writable = can('forms:write');

  const forms = useQuery({
    queryKey: formsKeys.list(slug, filter),
    queryFn: async () => (await api.forms.list(filter === 'all' ? {} : { status: filter })).data,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: formsKeys.root(slug) });
  const open = (form: FormSummary, to: '' | '/submissions' | '/connections' = '') =>
    void navigate({
      to: `/t/$tenant/forms/$formId${to}`,
      params: { tenant: slug, formId: form.id },
    });

  const duplicate = useFormsMutation({
    mutationFn: (id: string) => api.forms.duplicate(id),
    success: t('forms.list.duplicated'),
  });
  const archive = useFormsMutation({
    mutationFn: (input: { id: string; archived: boolean }) =>
      input.archived ? api.forms.restore(input.id) : api.forms.archive(input.id),
    success: (form) => (form.archived ? t('forms.list.archived') : t('forms.list.restored')),
  });

  const columns: ListTableColumn<FormSummary>[] = [
    {
      id: 'name',
      header: t('forms.field.name'),
      cell: (f) => <span className="truncate font-medium">{f.name}</span>,
      sortable: true,
      sortValue: (f) => f.name.toLowerCase(),
    },
    {
      id: 'status',
      header: t('forms.field.status'),
      cell: (f) =>
        f.archived ? (
          <Pill tone="neutral">{t('forms.status.archived')}</Pill>
        ) : (
          <Pill tone={f.status === 'active' ? 'success' : 'warning'}>{t(`forms.status.${f.status}`)}</Pill>
        ),
    },
    {
      id: 'submissions',
      header: t('forms.field.submissions'),
      cell: (f) => f.submission_count.toLocaleString(locale),
      align: 'right',
      sortable: true,
      sortValue: (f) => f.submission_count,
    },
    {
      id: 'last',
      header: t('forms.field.lastSubmission'),
      cell: (f) => dateTime(f.last_submission_at),
      sortable: true,
      sortValue: (f) => f.last_submission_at ?? '',
      hideBelow: 'md',
    },
    {
      id: 'fields',
      header: t('forms.field.fields'),
      cell: (f) => `${String(f.field_count)} · ${t('forms.list.connections', { count: f.connection_count })}`,
      hideBelow: 'lg',
    },
    {
      id: 'updated',
      header: t('forms.field.updated'),
      cell: (f) => dateTime(f.updated_at),
      sortable: true,
      sortValue: (f) => f.updated_at,
      hideBelow: 'lg',
    },
  ];

  const rowActions = (form: FormSummary): ListTableRowAction<FormSummary>[] => {
    const actions: ListTableRowAction<FormSummary>[] = [
      { id: 'edit', label: t('forms.action.edit'), icon: Pencil, onSelect: () => open(form) },
    ];
    if (can('forms:submissions_read')) {
      actions.push({ id: 'submissions', label: t('forms.tab.submissions'), icon: Inbox, onSelect: () => open(form, '/submissions') });
    }
    actions.push({ id: 'connections', label: t('forms.tab.connections'), icon: Plug, onSelect: () => open(form, '/connections') });
    if (writable) {
      actions.push(
        { id: 'duplicate', label: t('forms.action.duplicate'), icon: Copy, separatorBefore: true, onSelect: () => duplicate.mutate(form.id) },
        {
          id: 'archive',
          label: form.archived ? t('forms.action.restore') : t('forms.action.archive'),
          icon: form.archived ? ArchiveRestore : Archive,
          onSelect: () => archive.mutate({ id: form.id, archived: form.archived }),
        },
      );
    }
    return actions;
  };

  return (
    <>
      <PageToolbar
        filters={
          <DashboardFilterMenu
            label={t('forms.field.status')}
            value={filter}
            onValueChange={(value) => setFilter(value as StatusFilter)}
            options={(['all', 'active', 'inactive', 'archived'] as const).map((value) => ({
              value,
              label: value === 'all' ? t('forms.filter.all') : t(`forms.status.${value}`),
            }))}
          />
        }
        actions={
          writable ? (
            <DashboardButton variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> {t('forms.list.new')}
            </DashboardButton>
          ) : null
        }
      />
      {forms.error ? (
        <PageBody>
          <ErrorNotice error={forms.error} />
        </PageBody>
      ) : (
        <ListTable<FormSummary>
          className="px-4"
          rows={forms.data ?? []}
          getRowId={(f) => f.id}
          getRowLabel={(f) => f.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'updated', direction: 'desc' }}
          selectable={writable}
          loading={forms.isPending}
          onRowOpen={(f) => open(f)}
          rowActions={rowActions}
          deletion={
            writable
              ? {
                  onDelete: async (rows) => {
                    await Promise.all(rows.map((f) => api.forms.remove(f.id)));
                    await refresh();
                  },
                  confirm: true,
                }
              : undefined
          }
          emptyState={<p className="py-10 text-center text-sm text-muted-foreground">{t('forms.list.empty')}</p>}
        />
      )}
      {creating ? (
        <CreateFormDialog
          locale={locale === 'it' ? 'it' : 'en'}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void navigate({ to: '/t/$tenant/forms/$formId', params: { tenant: slug, formId: id } });
          }}
        />
      ) : null}
    </>
  );
}

function CreateFormDialog({
  locale,
  onClose,
  onCreated,
}: {
  locale: 'en' | 'it';
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const { api } = useForms();
  const [name, setName] = useState('');
  const create = useFormsMutation({
    mutationFn: () => api.forms.create({ name: name.trim(), definition: defaultFormDefinition(locale) }),
    onSuccess: (form) => onCreated(form.id),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('forms.list.new')}</DialogTitle>
          </DialogHeader>
          <FormField label={t('forms.field.name')} hint={t('forms.list.nameHint')}>
            {(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || create.isPending}>
              {t('forms.list.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
