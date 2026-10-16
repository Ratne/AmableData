import type { SavedSearch } from '@amable/api-types/crm';
import { ListTable, PageToolbar, usePageChrome, type ListTableColumn } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../i18n';
import { listTableLabels } from '../../lib/labels';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useDirectory,
  usePermissions,
  useSavedSearches,
} from '../crm/api/hooks';
import { formatDate } from '../crm/components/cells';
import { ErrorNotice } from '../crm/components/states';
import { countConditions } from './query-model';

/** Every saved search (segment) of the workspace; opening one loads it in its list. */
export function SavedSearchesPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const { nameOf } = useDirectory();
  const navigate = useNavigate();
  const saved = useSavedSearches();
  usePageChrome({ title: t('nav.searches') });
  const remove = useCrmMutation({
    mutationFn: (rows: SavedSearch[]) =>
      Promise.all(rows.map((row) => api.savedSearches.remove(row.id))),
    invalidate: [crmKeys.savedSearches(slug)],
  });
  const open = (row: SavedSearch) =>
    row.entity === 'company'
      ? void navigate({
          to: '/t/$tenant/companies',
          params: { tenant: slug },
          search: { saved: row.id },
        })
      : void navigate({
          to: '/t/$tenant/contacts',
          params: { tenant: slug },
          search: { saved: row.id },
        });

  const columns: ListTableColumn<SavedSearch>[] = [
    {
      id: 'name',
      header: t('search.saved.name'),
      cell: (row) => <span className="font-medium">{row.name}</span>,
      sortable: true,
      sortValue: (row) => row.name,
    },
    {
      id: 'entity',
      header: t('search.saved.entity'),
      cell: (row) => <Badge variant="outline">{t(`search.global.type.${row.entity}`)}</Badge>,
      sortable: true,
      sortValue: (row) => row.entity,
    },
    {
      id: 'conditions',
      header: t('search.saved.conditions'),
      cell: (row) => countConditions(row.query.filter) + (row.query.q ? 1 : 0),
      align: 'right',
    },
    {
      id: 'shared',
      header: t('search.saved.visibility'),
      cell: (row) => (row.shared ? t('search.saved.shared') : t('search.saved.private')),
      hideBelow: 'md',
    },
    {
      id: 'owner',
      header: t('crm.field.owner_id'),
      cell: (row) => nameOf(row.owner_id),
      hideBelow: 'lg',
    },
    {
      id: 'updated',
      header: t('crm.field.updated_at'),
      cell: (row) => formatDate(locale, row.updated_at, true),
      sortable: true,
      sortValue: (row) => row.updated_at,
      firstDirection: 'desc',
      hideBelow: 'lg',
    },
  ];

  return (
    <>
      <PageToolbar
        filters={<p className="text-xs text-muted-foreground">{t('search.saved.pageHint')}</p>}
      />
      {saved.error ? (
        <div className="px-4">
          <ErrorNotice error={saved.error} />
        </div>
      ) : null}
      <ListTable<SavedSearch>
        rows={saved.data ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        columns={columns}
        labels={listTableLabels(t)}
        loading={saved.isPending}
        defaultSort={{ columnId: 'name', direction: 'asc' }}
        selectable={can('saved_searches:write')}
        onRowOpen={open}
        rowActions={[
          { id: 'open', label: t('search.saved.open'), icon: ExternalLink, onSelect: open },
        ]}
        deletion={
          can('saved_searches:write')
            ? { onDelete: (rows) => remove.mutateAsync(rows).then(() => undefined) }
            : undefined
        }
        emptyState={<p className="p-6 text-sm text-muted-foreground">{t('search.saved.empty')}</p>}
      />
    </>
  );
}
