import { DashboardButton, usePageChrome, type ListTableBulkAction } from '@amable/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { GitMerge, Plus, Tag, TagsIcon, Upload } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { crmKeys, useCrm, usePermissions } from '../api/hooks';
import {
  BulkTagDialog,
  CreateContactDialog,
  MergeDialog,
  type RecordRef,
} from '../components/contact-dialogs';
import { RecordSearchView, type SearchRow } from './record-search-view';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function contactRowLabel(row: SearchRow, fallback: string): string {
  return (
    [text(row['given_name']), text(row['family_name'])].filter(Boolean).join(' ') ||
    text(row['email']) ||
    fallback
  );
}

export function ContactsListPage() {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search: { saved?: unknown; tag?: unknown } = useSearch({ strict: false });
  const initialSavedId = typeof search.saved === 'string' ? search.saved : undefined;
  const initialTagId = typeof search.tag === 'string' ? search.tag : undefined;
  usePageChrome({ title: t('nav.contacts') });

  const [creating, setCreating] = useState(false);
  const [tagMode, setTagMode] = useState<'apply' | 'remove' | null>(null);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [merging, setMerging] = useState<RecordRef[] | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: crmKeys.root(slug) });
  const unnamed = t('crm.contacts.unnamed');

  const bulkActions: ListTableBulkAction<SearchRow>[] = [];
  if (can('contacts:write')) {
    bulkActions.push(
      {
        id: 'tag',
        label: t('crm.bulk.applyTags'),
        icon: Tag,
        onSelect: (rows) => {
          setBulkIds(rows.map((row) => row.id));
          setTagMode('apply');
        },
      },
      {
        id: 'untag',
        label: t('crm.bulk.removeTags'),
        icon: TagsIcon,
        onSelect: (rows) => {
          setBulkIds(rows.map((row) => row.id));
          setTagMode('remove');
        },
      },
    );
  }
  if (can('contacts:merge')) {
    bulkActions.push({
      id: 'merge',
      label: t('crm.merge.title'),
      icon: GitMerge,
      onSelect: (rows) => {
        if (rows.length < 2) return;
        setMerging(rows.map((row) => ({ id: row.id, label: contactRowLabel(row, unnamed) })));
      },
    });
  }

  return (
    <>
      <RecordSearchView
        entity="contact"
        initialSavedId={initialSavedId}
        initialTagId={initialTagId}
        requiredColumns={['given_name', 'family_name', 'email']}
        defaultColumns={['email', 'phone', 'company_name', 'owner_id', 'tags', 'created_at']}
        nameColumn={{
          header: t('crm.field.name'),
          sortField: 'name',
          render: (row) => (
            <span className="truncate font-medium">{contactRowLabel(row, unnamed)}</span>
          ),
        }}
        rowLabel={(row) => contactRowLabel(row, unnamed)}
        onOpen={(row) =>
          void navigate({
            to: '/t/$tenant/contacts/$contactId',
            params: { tenant: slug, contactId: row.id },
          })
        }
        bulkActions={bulkActions}
        deletion={
          can('contacts:write')
            ? {
                onDelete: async (rows) => {
                  await Promise.all(rows.map((row) => api.contacts.remove(row.id)));
                  await refresh();
                },
                onUndo: async (rows) => {
                  await Promise.all(rows.map((row) => api.contacts.restore(row.id)));
                  await refresh();
                },
              }
            : undefined
        }
        toolbarActions={
          <>
            {can('contacts:import') ? (
              <DashboardButton
                variant="ghost"
                onClick={() =>
                  void navigate({ to: '/t/$tenant/contacts/import', params: { tenant: slug } })
                }
              >
                <Upload aria-hidden /> {t('crm.import.title')}
              </DashboardButton>
            ) : null}
            {can('contacts:write') ? (
              <DashboardButton variant="primary" onClick={() => setCreating(true)}>
                <Plus aria-hidden /> {t('crm.contacts.new')}
              </DashboardButton>
            ) : null}
          </>
        }
      />
      <CreateContactDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(contact) => {
          setCreating(false);
          void navigate({
            to: '/t/$tenant/contacts/$contactId',
            params: { tenant: slug, contactId: contact.id },
          });
        }}
      />
      <BulkTagDialog
        mode={tagMode}
        contactIds={bulkIds}
        onOpenChange={(open) => (open ? undefined : setTagMode(null))}
        onDone={() => setTagMode(null)}
      />
      {merging !== null ? (
        <MergeDialog
          open
          initial={merging}
          onOpenChange={(open) => (open ? undefined : setMerging(null))}
          onMerged={() => setMerging(null)}
        />
      ) : null}
    </>
  );
}
