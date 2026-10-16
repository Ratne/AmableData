import type { EmailTemplateSummary, Snippet } from '@amable/api-types';
import {
  DashboardButton,
  ListTable,
  PageBody,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { validateLiquid } from '@amable/email-render';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BookOpen, Pencil, Plus } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { emailKeys, useEmailApi, useEmailMutation, usePermissions } from '../api';
import { formatDateTime } from '../components';
import { CodeEditor, insertAtCursor } from '../liquid/code-editor';
import { GuideDialog } from '../liquid/guide';
import { LiquidHelperPanel } from '../liquid/panel';
import { IssueList } from '../liquid/preview-pane';

const BLANK_DOC = {
  type: 'doc' as const,
  content: [
    { type: 'paragraph' },
    { type: 'emailFooter', attrs: { unsubscribeLabel: 'Unsubscribe' }, content: [{ type: 'paragraph' }] },
  ],
};

export function TemplatesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'templates' | 'snippets'>('templates');
  usePageChrome({
    title: t('email.templates.title'),
    tabs: [
      { value: 'templates', label: t('email.templates.tabTemplates') },
      { value: 'snippets', label: t('email.templates.tabSnippets') },
    ],
    tab,
    onTabChange: (value) => setTab(value === 'snippets' ? 'snippets' : 'templates'),
  });
  return tab === 'templates' ? <TemplateList /> : <SnippetList />;
}

function TemplateList() {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: emailKeys.templates(slug), queryFn: () => api.templates.list() });
  const create = useEmailMutation({
    mutationFn: () => api.templates.create({ name: t('email.templates.untitled'), subject: '', body: BLANK_DOC }),
    invalidate: [emailKeys.templates(slug)],
    onSuccess: (tpl) => void navigate({ to: '/t/$tenant/templates/$templateId', params: { tenant: slug, templateId: tpl.id } }),
  });
  const remove = useEmailMutation({
    mutationFn: async (rows: EmailTemplateSummary[]) => {
      for (const row of rows) await api.templates.remove(row.id);
    },
    invalidate: [emailKeys.templates(slug)],
  });
  const columns: ListTableColumn<EmailTemplateSummary>[] = [
    { id: 'name', header: t('email.common.name'), cell: (row) => <span className="font-medium">{row.name}</span>, sortable: true, sortValue: (r) => r.name },
    { id: 'subject', header: t('email.common.subject'), cell: (row) => row.subject || '—', hideBelow: 'md' },
    {
      id: 'status',
      header: t('email.common.status'),
      cell: (row) => (
        <Badge variant={row.compiled ? 'secondary' : 'destructive'}>
          {row.compiled ? t('email.templates.compiled') : t('email.templates.notCompiled')}
        </Badge>
      ),
    },
    {
      id: 'updated',
      header: t('email.common.updated'),
      cell: (row) => formatDateTime(locale, row.updated_at),
      sortable: true,
      sortValue: (r) => r.updated_at,
      hideBelow: 'lg',
    },
  ];
  return (
    <>
      <PageToolbar
        actions={
          can('templates:write') ? (
            <DashboardButton variant="primary" onClick={() => create.mutate(undefined)} disabled={create.isPending}>
              <Plus className="size-4" />
              {t('email.templates.new')}
            </DashboardButton>
          ) : null
        }
      />
      <ListTable<EmailTemplateSummary>
        rows={list.data?.data ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        columns={columns}
        labels={listTableLabels(t)}
        loading={list.isPending}
        defaultSort={{ columnId: 'updated', direction: 'desc' }}
        onRowOpen={(row) => void navigate({ to: '/t/$tenant/templates/$templateId', params: { tenant: slug, templateId: row.id } })}
        {...(can('templates:write') ? { deletion: { onDelete: (rows) => remove.mutateAsync(rows), confirm: true } } : {})}
        emptyState={<p className="py-10 text-center text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('email.templates.empty')}</p>}
      />
    </>
  );
}

function SnippetDialog({ snippet, onClose }: { snippet: Snippet | null; onClose: () => void }) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const [key, setKey] = useState(snippet?.key ?? '');
  const [name, setName] = useState(snippet?.name ?? '');
  const [body, setBody] = useState(snippet?.body ?? '');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const bodyLatest = useRef(body);
  bodyLatest.current = body;
  const validation = useMemo(() => validateLiquid(body), [body]);
  const documentSource = useMemo(() => ({ label: t('email.liquid.preview.thisSnippet'), get: () => bodyLatest.current }), [t]);
  const save = useEmailMutation({
    mutationFn: () =>
      snippet === null ? api.snippets.create({ key, name, body }) : api.snippets.update(snippet.id, { name, body }),
    invalidate: [emailKeys.snippets(slug), emailKeys.liquidSchema(slug)],
    success: t('email.common.saved'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '' && /^[a-z][a-z0-9_]{0,62}$/.test(key)) save.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex h-[90vh] flex-col sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{snippet === null ? t('email.snippets.new') : t('email.snippets.edit')}</DialogTitle>
          <DialogDescription>{t('email.snippets.bodyHint')}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_minmax(22rem,28rem)]">
          <form id="snippet-form" onSubmit={submit} className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="snippet-name">{t('email.common.name')}</Label>
                <Input id="snippet-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="snippet-key">{t('email.snippets.key')}</Label>
                <Input
                  id="snippet-key"
                  value={key}
                  disabled={snippet !== null}
                  onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  className="font-mono"
                  required
                />
              </div>
            </div>
            <p className="-mt-2 text-xs text-(--obsidian-dashboard-shell-text-subtle)">
              {t('email.snippets.keyHint', { field: `{{ snippets.${key || 'key'} }}` })}
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="snippet-body">{t('email.snippets.body')}</Label>
              <CodeEditor
                ref={bodyRef}
                id="snippet-body"
                value={body}
                onChange={setBody}
                rows={14}
                errorLine={validation.errors[0]?.line ?? null}
                placeholder={'{% if contact.tags contains "VIP" %}Thanks for being a VIP!{% else %}Join our VIP club.{% endif %}'}
              />
              {validation.ok ? (
                <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('email.liquid.valid')}</p>
              ) : (
                <IssueList errors={validation.errors} />
              )}
            </div>
          </form>
          <aside className="flex min-h-0 flex-col rounded-lg border p-3" aria-label={t('email.liquid.title')} data-testid="snippet-liquid-panel">
            <h3 className="mb-2 text-sm font-semibold">{t('email.liquid.title')}</h3>
            <LiquidHelperPanel
              documentSource={documentSource}
              onInsert={(code) => setBody((current) => insertAtCursor(bodyRef.current, current, code))}
            />
          </aside>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('email.common.cancel')}
          </Button>
          <Button type="submit" form="snippet-form" disabled={save.isPending}>
            {t('email.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnippetsEmptyState({ canWrite, onNew, onGuide }: { canWrite: boolean; onNew: () => void; onGuide: () => void }) {
  const { t } = useI18n();
  return (
    <PageBody className="mx-auto grid max-w-xl gap-3 py-10 text-center text-sm">
      <p className="text-base font-medium">{t('email.snippets.emptyTitle')}</p>
      <p className="text-(--obsidian-dashboard-shell-text-subtle)">{t('email.snippets.empty')}</p>
      <code className="mx-auto rounded bg-(--obsidian-dashboard-shell-muted) px-2 py-1 text-xs">
        {'Hi {{ contact.first_name | default: "there" }}'}
      </code>
      <div className="flex justify-center gap-2">
        <Button type="button" variant="outline" onClick={onGuide}>
          <BookOpen className="size-4" />
          {t('email.liquid.howItWorks')}
        </Button>
        {canWrite ? (
          <Button type="button" onClick={onNew}>
            <Plus className="size-4" />
            {t('email.snippets.new')}
          </Button>
        ) : null}
      </div>
    </PageBody>
  );
}

function SnippetList() {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const [editing, setEditing] = useState<Snippet | null | 'new'>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const list = useQuery({ queryKey: emailKeys.snippets(slug), queryFn: api.snippets.list });
  const remove = useEmailMutation({
    mutationFn: async (rows: Snippet[]) => {
      for (const row of rows) await api.snippets.remove(row.id);
    },
    invalidate: [emailKeys.snippets(slug)],
  });
  const columns: ListTableColumn<Snippet>[] = [
    { id: 'name', header: t('email.common.name'), cell: (row) => <span className="font-medium">{row.name}</span>, sortable: true, sortValue: (r) => r.name },
    { id: 'key', header: t('email.snippets.key'), cell: (row) => <code className="text-xs">{`{{ snippets.${row.key} }}`}</code> },
    { id: 'updated', header: t('email.common.updated'), cell: (row) => formatDateTime(locale, row.updated_at), hideBelow: 'lg' },
  ];
  return (
    <>
      <PageToolbar
        actions={
          <>
            <DashboardButton onClick={() => setGuideOpen(true)}>
              <BookOpen className="size-4" />
              {t('email.liquid.howItWorks')}
            </DashboardButton>
            {can('templates:write') ? (
              <DashboardButton variant="primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" />
                {t('email.snippets.new')}
              </DashboardButton>
            ) : null}
          </>
        }
      />
      <ListTable<Snippet>
        rows={list.data?.data ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        columns={columns}
        labels={listTableLabels(t)}
        loading={list.isPending}
        defaultSort={{ columnId: 'name', direction: 'asc' }}
        {...(can('templates:write')
          ? {
              onRowOpen: (row: Snippet) => setEditing(row),
              rowActions: (row: Snippet) => [{ id: 'edit', label: t('email.common.edit'), icon: Pencil, onSelect: () => setEditing(row) }],
              deletion: { onDelete: (rows: Snippet[]) => remove.mutateAsync(rows), confirm: true },
            }
          : {})}
        emptyState={
          <SnippetsEmptyState canWrite={can('templates:write')} onNew={() => setEditing('new')} onGuide={() => setGuideOpen(true)} />
        }
      />
      {editing !== null ? <SnippetDialog snippet={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <GuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  );
}
