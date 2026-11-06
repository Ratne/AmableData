import type {
  CustomField,
  CustomFieldEntityPath,
  CustomFieldGroup,
  CustomFieldTab,
} from '@amable/api-types/crm';
import {
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  PageToolbar,
  usePageChrome,
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
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, FolderPlus, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useCustomFieldLayout,
  usePermissions,
} from '../api/hooks';
import { PageState } from '../components/states';
import { FieldDialog } from '../components/custom-field-dialog';
import { reorder } from '../reorder';

const ENTITIES = [
  'contacts',
  'companies',
  'opportunities',
  'orders',
] as const satisfies readonly CustomFieldEntityPath[];

function NameDialog({
  title,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onSubmit(name.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{title}</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            autoFocus
            maxLength={100}
            aria-label={t('crm.common.name')}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Pending =
  | { kind: 'field'; field: CustomField | null; groupId?: string }
  | { kind: 'tab'; tab: CustomFieldTab | null }
  | { kind: 'group'; tabId: string; group: CustomFieldGroup | null }
  | { kind: 'delete'; target: 'field' | 'tab' | 'group'; id: string; name: string }
  | null;

function Reorder({
  index,
  count,
  onMove,
}: {
  index: number;
  count: number;
  onMove: (delta: -1 | 1) => void;
}) {
  const { t } = useI18n();
  return (
    <span className="flex">
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={index === 0}
        aria-label={t('crm.common.moveUp')}
        onClick={() => onMove(-1)}
      >
        <ArrowUp className="size-3.5" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={index === count - 1}
        aria-label={t('crm.common.moveDown')}
        onClick={() => onMove(1)}
      >
        <ArrowDown className="size-3.5" aria-hidden />
      </Button>
    </span>
  );
}

export function CustomFieldsSettingsPage() {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const [entity, setEntity] = useState<(typeof ENTITIES)[number]>('contacts');
  const layout = useCustomFieldLayout(entity);
  const [pending, setPending] = useState<Pending>(null);
  usePageChrome({
    title: t('nav.customFields'),
    tabs: ENTITIES.map((value) => ({ value, label: t(`crm.entity.${value}`) })),
    tab: entity,
    onTabChange: (value) =>
      setEntity(ENTITIES.find((candidate) => candidate === value) ?? 'contacts'),
  });
  const canManage = can('settings:manage');
  const invalidate = [
    crmKeys.customFields(slug, entity),
    crmKeys.layout(slug, entity),
    crmKeys.searchFields(slug, entity === 'companies' ? 'company' : 'contact'),
  ];
  const mutate = useCrmMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    invalidate,
    onSuccess: () => setPending(null),
  });

  return (
    <PageState isPending={layout.isPending} error={layout.error}>
      {() => {
        const data = layout.data;
        if (!data) return null;
        const groupChoices = data.tabs.flatMap((tab) =>
          tab.groups.map((group) => ({ id: group.id, label: `${tab.name} › ${group.name}` })),
        );
        const fieldRow = (field: CustomField, index: number, siblings: readonly CustomField[]) => (
          <li key={field.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 text-sm">
              {field.label}
              <span className="ml-2 font-mono text-xs text-muted-foreground">{field.key}</span>
            </span>
            <Badge variant="outline">{t(`crm.fieldType.${field.type}`)}</Badge>
            {field.required ? (
              <Badge variant="secondary">{t('crm.customFields.required')}</Badge>
            ) : null}
            {field.sensitive ? (
              <Lock
                className="size-3.5 text-muted-foreground"
                aria-label={t('crm.customFields.sensitive')}
              />
            ) : null}
            {canManage ? (
              <>
                <Reorder
                  index={index}
                  count={siblings.length}
                  onMove={(delta) => {
                    mutate.mutate(() =>
                      reorder(siblings, index, delta, (item, position) =>
                        api.customFields.update(entity, item.id, { position }),
                      ),
                    );
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('crm.common.edit')}
                  onClick={() => setPending({ kind: 'field', field })}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('list.delete')}
                  onClick={() =>
                    setPending({ kind: 'delete', target: 'field', id: field.id, name: field.label })
                  }
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </>
            ) : null}
          </li>
        );
        return (
          <>
            <PageToolbar
              actions={
                canManage ? (
                  <>
                    <DashboardButton
                      variant="ghost"
                      onClick={() => setPending({ kind: 'tab', tab: null })}
                    >
                      <FolderPlus aria-hidden /> {t('crm.customFields.newTab')}
                    </DashboardButton>
                    <DashboardButton
                      variant="primary"
                      onClick={() => setPending({ kind: 'field', field: null })}
                    >
                      <Plus aria-hidden /> {t('crm.customFields.new')}
                    </DashboardButton>
                  </>
                ) : null
              }
            />
            <PageBody className="grid gap-4">
              {data.tabs.map((tab, tabIndex) => (
                <section
                  key={tab.id}
                  className="rounded-xl border bg-card p-4"
                  aria-label={tab.name}
                >
                  <header className="mb-2 flex items-center gap-2">
                    <h3 className="flex-1 text-sm font-semibold">{tab.name}</h3>
                    {canManage ? (
                      <>
                        <Reorder
                          index={tabIndex}
                          count={data.tabs.length}
                          onMove={(delta) => {
                            mutate.mutate(() =>
                              reorder(data.tabs, tabIndex, delta, (item, position) =>
                                api.customFields.updateTab(entity, item.id, { position }),
                              ),
                            );
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending({ kind: 'group', tabId: tab.id, group: null })}
                        >
                          <Plus className="size-3.5" aria-hidden /> {t('crm.customFields.newGroup')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t('crm.common.rename')}
                          onClick={() => setPending({ kind: 'tab', tab })}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t('list.delete')}
                          onClick={() =>
                            setPending({
                              kind: 'delete',
                              target: 'tab',
                              id: tab.id,
                              name: tab.name,
                            })
                          }
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </>
                    ) : null}
                  </header>
                  {tab.groups.map((group, groupIndex) => (
                    <div key={group.id} className="mb-3 rounded-lg border p-3">
                      <div className="flex items-center gap-2 border-b pb-1">
                        <h4 className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                          {group.name}
                        </h4>
                        {canManage ? (
                          <>
                            <Reorder
                              index={groupIndex}
                              count={tab.groups.length}
                              onMove={(delta) => {
                                mutate.mutate(() =>
                                  reorder(tab.groups, groupIndex, delta, (item, position) =>
                                    api.customFields.updateGroup(entity, item.id, { position }),
                                  ),
                                );
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7"
                              onClick={() =>
                                setPending({ kind: 'field', field: null, groupId: group.id })
                              }
                            >
                              <Plus className="size-3.5" aria-hidden />{' '}
                              {t('crm.customFields.addField')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={t('crm.common.rename')}
                              onClick={() => setPending({ kind: 'group', tabId: tab.id, group })}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={t('list.delete')}
                              onClick={() =>
                                setPending({
                                  kind: 'delete',
                                  target: 'group',
                                  id: group.id,
                                  name: group.name,
                                })
                              }
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </>
                        ) : null}
                      </div>
                      <ul className="divide-y">
                        {group.fields.map((field, i) => fieldRow(field, i, group.fields))}
                      </ul>
                      {group.fields.length === 0 ? (
                        <p className="pt-2 text-xs text-muted-foreground">
                          {t('crm.customFields.emptyGroup')}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </section>
              ))}
              <section className="rounded-xl border bg-card p-4">
                <h3 className="mb-2 text-sm font-semibold">{t('crm.customFields.ungrouped')}</h3>
                <ul className="divide-y">
                  {data.ungrouped.map((field, i) => fieldRow(field, i, data.ungrouped))}
                </ul>
                {data.ungrouped.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('crm.customFields.none')}</p>
                ) : null}
              </section>
            </PageBody>

            {pending?.kind === 'field' ? (
              <FieldDialog
                entity={entity}
                field={pending.field}
                defaultGroupId={pending.groupId}
                groups={groupChoices}
                onClose={() => setPending(null)}
              />
            ) : null}
            {pending?.kind === 'tab' ? (
              <NameDialog
                title={pending.tab ? t('crm.common.rename') : t('crm.customFields.newTab')}
                initial={pending.tab?.name ?? ''}
                onClose={() => setPending(null)}
                onSubmit={(name) =>
                  mutate.mutate(() =>
                    pending.tab
                      ? api.customFields.updateTab(entity, pending.tab.id, { name })
                      : api.customFields.createTab(entity, { name, position: data.tabs.length }),
                  )
                }
              />
            ) : null}
            {pending?.kind === 'group' ? (
              <NameDialog
                title={pending.group ? t('crm.common.rename') : t('crm.customFields.newGroup')}
                initial={pending.group?.name ?? ''}
                onClose={() => setPending(null)}
                onSubmit={(name) =>
                  mutate.mutate(() =>
                    pending.group
                      ? api.customFields.updateGroup(entity, pending.group.id, { name })
                      : api.customFields.createGroup(entity, { tab_id: pending.tabId, name }),
                  )
                }
              />
            ) : null}
            <DashboardConfirmDialog
              open={pending?.kind === 'delete'}
              onOpenChange={(open) => (open ? undefined : setPending(null))}
              title={t('crm.customFields.confirmDelete', {
                name: pending?.kind === 'delete' ? pending.name : '',
              })}
              description={t('crm.customFields.confirmDeleteBody')}
              confirmLabel={t('list.delete')}
              cancelLabel={t('common.cancel')}
              tone="danger"
              onConfirm={() => {
                if (pending?.kind !== 'delete') return;
                const { target, id } = pending;
                mutate.mutate(() =>
                  target === 'field'
                    ? api.customFields.remove(entity, id)
                    : target === 'tab'
                      ? api.customFields.removeTab(entity, id)
                      : api.customFields.removeGroup(entity, id),
                );
              }}
            />
          </>
        );
      }}
    </PageState>
  );
}
