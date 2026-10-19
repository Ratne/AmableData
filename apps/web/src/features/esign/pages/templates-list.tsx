import type { EsignTemplate } from '@amable/api-types';
import { DashboardButton, ListTable, PageBody, PageToolbar, type ListTableColumn, type ListTableRowAction } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Pencil, Plus, Send } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { ChoiceSelect, FormField } from '../../commerce/components/common';
import { esignKeys, useEsign, useEsignDates, useEsignMutation, useEsignPermissions, useTemplates } from '../api/hooks';
import { ErrorNotice, TemplateStatusPill, useEsignChrome } from '../components/common';
import { SendDialog } from '../components/send-dialog';

export function EsignTemplatesPage() {
  const { t } = useI18n();
  const { slug, api } = useEsign();
  const { can } = useEsignPermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dates = useEsignDates();
  const templates = useTemplates();
  useEsignChrome('templates');
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState<EsignTemplate | null>(null);
  const [view, setView] = useState<'current' | 'archived'>('current');
  const writable = can('esign:write');
  const rows = useMemo(
    () => (templates.data ?? []).filter((tpl) => (tpl.status === 'archived') === (view === 'archived')),
    [templates.data, view],
  );
  const setStatus = useEsignMutation({
    mutationFn: ({ id, status }: { id: string; status: EsignTemplate['status'] }) => api.templates.update(id, { status }),
    invalidate: [esignKeys.templates(slug)],
    success: (result) => t(`esign.editor.status.${result.status}`),
  });
  const open = (template: EsignTemplate) =>
    void navigate({ to: '/t/$tenant/signatures/templates/$templateId', params: { tenant: slug, templateId: template.id } });

  const columns: ListTableColumn<EsignTemplate>[] = [
    { id: 'name', header: t('esign.field.name'), cell: (tpl) => <span className="truncate font-medium">{tpl.name}</span>, sortable: true, sortValue: (tpl) => tpl.name.toLowerCase() },
    {
      id: 'document',
      header: t('esign.field.document'),
      cell: (tpl) =>
        tpl.source === null ? (
          <span className="text-muted-foreground">{t('esign.templates.noDocument')}</span>
        ) : (
          <span className="truncate">{t('esign.templates.pages', { name: tpl.source.filename, count: tpl.pages.length })}</span>
        ),
      hideBelow: 'md',
    },
    { id: 'parties', header: t('esign.field.parties'), cell: (tpl) => tpl.parties.map((p) => p.name).join(', '), hideBelow: 'lg' },
    { id: 'fields', header: t('esign.field.fields'), cell: (tpl) => tpl.fields.length, align: 'right', hideBelow: 'lg' },
    { id: 'status', header: t('esign.field.status'), cell: (tpl) => <TemplateStatusPill status={tpl.status} /> },
    { id: 'updated', header: t('esign.field.updated'), cell: (tpl) => dates.dateTime(tpl.updated_at), sortable: true, sortValue: (tpl) => tpl.updated_at, hideBelow: 'md' },
  ];

  const rowActions = (template: EsignTemplate): ListTableRowAction<EsignTemplate>[] => [
    { id: 'edit', label: t('esign.action.edit'), icon: Pencil, onSelect: () => open(template) },
    ...(writable && template.status === 'active' && template.ready
      ? [{ id: 'send', label: t('esign.action.send'), icon: Send, onSelect: () => setSending(template) }]
      : []),
    ...(writable
      ? [
          template.status === 'archived'
            ? {
                id: 'restore',
                label: t('esign.action.restore'),
                icon: ArchiveRestore,
                onSelect: () => setStatus.mutate({ id: template.id, status: 'draft' }),
              }
            : {
                id: 'archive',
                label: t('esign.action.archive'),
                icon: Archive,
                onSelect: () => setStatus.mutate({ id: template.id, status: 'archived' }),
              },
        ]
      : []),
  ];

  return (
    <>
      <PageToolbar
        filters={
          <ChoiceSelect
            value={view}
            onChange={(next) => setView(next === 'archived' ? 'archived' : 'current')}
            ariaLabel={t('esign.field.status')}
            choices={[
              { value: 'current', label: t('esign.filter.currentTemplates') },
              { value: 'archived', label: t('esign.filter.archivedTemplates') },
            ]}
          />
        }
        actions={
          writable ? (
            <DashboardButton variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> {t('esign.templates.new')}
            </DashboardButton>
          ) : null
        }
      />
      {templates.error ? (
        <PageBody>
          <ErrorNotice error={templates.error} />
        </PageBody>
      ) : (
        <ListTable<EsignTemplate>
          className="px-4"
          rows={rows}
          getRowId={(tpl) => tpl.id}
          getRowLabel={(tpl) => tpl.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'updated', direction: 'desc' }}
          loading={templates.isPending}
          selectable={writable}
          onRowOpen={open}
          rowActions={rowActions}
          deletion={
            writable
              ? {
                  onDelete: async (rows) => {
                    await Promise.all(rows.map((tpl) => api.templates.remove(tpl.id)));
                    await queryClient.invalidateQueries({ queryKey: esignKeys.root(slug) });
                  },
                  confirm: true,
                }
              : undefined
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t(view === 'archived' ? 'esign.templates.noArchived' : 'esign.templates.empty')}
            </p>
          }
        />
      )}
      {creating ? <CreateTemplateDialog onClose={() => setCreating(false)} onCreated={open} /> : null}
      {sending !== null ? <SendDialog template={sending} onClose={() => setSending(null)} /> : null}
    </>
  );
}

function CreateTemplateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (template: EsignTemplate) => void }) {
  const { t } = useI18n();
  const { api } = useEsign();
  const [name, setName] = useState('');
  const create = useEsignMutation({
    mutationFn: () => api.templates.create({ name: name.trim() }),
    onSuccess: onCreated,
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
            <DialogTitle>{t('esign.templates.new')}</DialogTitle>
          </DialogHeader>
          <FormField label={t('esign.field.name')} hint={t('esign.templates.nameHint')}>
            {(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || create.isPending}>
              {t('esign.templates.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
