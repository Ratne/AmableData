import {
  CUSTOM_FIELD_TYPES,
  OPTION_FIELD_TYPES,
  type CustomField,
  type CustomFieldConfig,
  type CustomFieldEntityPath,
  type CustomFieldGroup,
  type CustomFieldOption,
  type CustomFieldTab,
  type CustomFieldType,
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
import { Checkbox } from '@amable/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { ArrowDown, ArrowUp, FolderPlus, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../../commerce/components/currency-select';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  useCustomFieldLayout,
  usePermissions,
} from '../api/hooks';
import { ChoiceSelect } from '../components/inputs';
import { PageState } from '../components/states';
import { reorder } from '../reorder';

const ENTITIES = [
  'contacts',
  'companies',
  'opportunities',
] as const satisfies readonly CustomFieldEntityPath[];

export function slugifyKey(label: string): string {
  const base = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (base === '') return '';
  return /^[a-z]/.test(base) ? base : `f_${base}`;
}

function OptionsEditor({
  options,
  onChange,
  depth,
  maxDepth,
}: {
  options: CustomFieldOption[];
  onChange: (options: CustomFieldOption[]) => void;
  depth: number;
  maxDepth: number;
}) {
  const { t } = useI18n();
  const set = (index: number, next: CustomFieldOption) =>
    onChange(options.map((option, i) => (i === index ? next : option)));
  return (
    <div className={depth > 1 ? 'ml-5 grid gap-1.5 border-l pl-3' : 'grid gap-1.5'}>
      {options.map((option, index) => (
        <div key={index} className="grid gap-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              value={option.label}
              placeholder={t('crm.customFields.optionLabel')}
              aria-label={t('crm.customFields.optionLabel')}
              className="h-8"
              onChange={(e) => {
                const label = e.target.value;
                const autoValue = option.value === '' || option.value === slugifyKey(option.label);
                set(index, {
                  ...option,
                  label,
                  ...(autoValue ? { value: slugifyKey(label) } : {}),
                });
              }}
            />
            <Input
              value={option.value}
              placeholder={t('crm.customFields.optionValue')}
              aria-label={t('crm.customFields.optionValue')}
              className="h-8 w-36 font-mono text-xs"
              onChange={(e) => set(index, { ...option, value: e.target.value })}
            />
            {depth < maxDepth ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('crm.customFields.addChild')}
                onClick={() =>
                  set(index, {
                    ...option,
                    children: [
                      ...((option.children ?? []) as CustomFieldOption[]),
                      { value: '', label: '' },
                    ],
                  } as CustomFieldOption)
                }
              >
                <Plus className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('crm.common.remove')}
              onClick={() => onChange(options.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </div>
          {option.children && option.children.length > 0 ? (
            <OptionsEditor
              options={option.children as CustomFieldOption[]}
              depth={depth + 1}
              maxDepth={maxDepth}
              onChange={(children) => set(index, { ...option, children } as CustomFieldOption)}
            />
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start"
        onClick={() => onChange([...options, { value: '', label: '' }])}
      >
        <Plus className="size-3.5" aria-hidden /> {t('crm.customFields.addOption')}
      </Button>
    </div>
  );
}

function cleanOptions(options: CustomFieldOption[]): CustomFieldOption[] {
  return options
    .filter((o) => o.label.trim() !== '' && o.value.trim() !== '')
    .map((o) => {
      const children = o.children ? cleanOptions(o.children as CustomFieldOption[]) : [];
      return {
        value: o.value.trim(),
        label: o.label.trim(),
        ...(children.length > 0 ? { children } : {}),
      } as CustomFieldOption;
    });
}

function FieldDialog({
  entity,
  field,
  defaultGroupId,
  groups,
  onClose,
}: {
  entity: CustomFieldEntityPath;
  field: CustomField | null;
  defaultGroupId?: string;
  groups: ReadonlyArray<{ id: string; label: string }>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const [label, setLabel] = useState(field?.label ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'TEXT');
  const [groupId, setGroupId] = useState(
    field ? (field.group_id ?? '') : (defaultGroupId ?? groups[0]?.id ?? ''),
  );
  const [required, setRequired] = useState(field?.required ?? false);
  const [sensitive, setSensitive] = useState(field?.sensitive ?? false);
  const [options, setOptions] = useState<CustomFieldOption[]>(field?.options ?? []);
  const [config, setConfig] = useState<CustomFieldConfig>(field?.config ?? {});
  const [error, setError] = useState<string | null>(null);
  const keyTouched = field !== null || (key !== '' && key !== slugifyKey(label));
  const hasOptions = OPTION_FIELD_TYPES.includes(type);
  const numeric = ['CURRENCY', 'DECIMAL_NUMBER', 'PERCENT', 'WHOLE_NUMBER'].includes(type);

  const save = useCrmMutation({
    mutationFn: () => {
      const cleaned = hasOptions ? cleanOptions(options) : undefined;
      const common = {
        label: label.trim(),
        group_id: groupId || null,
        required,
        sensitive,
        config,
        ...(cleaned !== undefined ? { options: cleaned } : {}),
      };
      return field
        ? api.customFields.update(entity, field.id, common)
        : api.customFields.create(entity, { ...common, key, type });
    },
    invalidate: [
      crmKeys.customFields(slug, entity),
      crmKeys.layout(slug, entity),
      crmKeys.searchFields(slug, entity === 'companies' ? 'company' : 'contact'),
    ],
    success: t('crm.common.saved'),
    onSuccess: onClose,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return setError(t('crm.validation.required'));
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(key)) return setError(t('crm.customFields.keyInvalid'));
    if (hasOptions && cleanOptions(options).length === 0)
      return setError(t('crm.customFields.optionsRequired'));
    if (config.min !== undefined && config.max !== undefined && config.min > config.max)
      return setError(t('crm.customFields.rangeInvalid'));
    setError(null);
    save.mutate(undefined);
  };
  const numberConfig = (name: 'min' | 'max' | 'decimals' | 'max_length', value: string) => {
    const next = { ...config };
    if (value.trim() === '' || !Number.isFinite(Number(value))) delete next[name];
    else next[name] = Number(value);
    setConfig(next);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {field ? t('crm.customFields.edit') : t('crm.customFields.new')}
            </DialogTitle>
            <DialogDescription>{t('crm.customFields.dialogBody')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="cf-label">{t('crm.customFields.label')}</Label>
              <Input
                id="cf-label"
                value={label}
                autoFocus
                maxLength={255}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (!keyTouched) setKey(slugifyKey(e.target.value));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cf-key">{t('crm.customFields.key')}</Label>
              <Input
                id="cf-key"
                value={key}
                disabled={field !== null}
                className="font-mono text-xs"
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('crm.customFields.type')}</Label>
              <ChoiceSelect
                value={type}
                allowEmpty={false}
                disabled={field !== null}
                ariaLabel={t('crm.customFields.type')}
                choices={CUSTOM_FIELD_TYPES.map((value) => ({
                  value,
                  label: t(`crm.fieldType.${value}`),
                }))}
                onChange={(value) => {
                  const next = value as CustomFieldType;
                  setType(next);
                  setConfig({});
                  if (next === 'SOCIAL_SECURITY_NUMBER') setSensitive(true);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('crm.customFields.group')}</Label>
              <ChoiceSelect
                value={groupId}
                ariaLabel={t('crm.customFields.group')}
                choices={groups.map((g) => ({ value: g.id, label: g.label }))}
                onChange={setGroupId}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={required} onCheckedChange={(v) => setRequired(v === true)} />
              {t('crm.customFields.required')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={sensitive} onCheckedChange={(v) => setSensitive(v === true)} />
              {t('crm.customFields.sensitive')}
            </label>
          </div>
          {type === 'CURRENCY' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="cf-currency">{t('crm.customFields.currency')}</Label>
              <CurrencySelect
                id="cf-currency"
                value={config.currency ?? ''}
                allowEmpty
                onChange={(currency) => {
                  const next = { ...config };
                  if (currency !== '') next.currency = currency;
                  else delete next.currency;
                  setConfig(next);
                }}
              />
            </div>
          ) : null}
          {numeric ? (
            <div className="grid grid-cols-3 gap-2">
              {(
                ['min', 'max', ...(type === 'WHOLE_NUMBER' ? [] : ['decimals' as const])] as const
              ).map((name) => (
                <div key={name} className="grid gap-1.5">
                  <Label htmlFor={`cf-${name}`}>{t(`crm.customFields.config.${name}`)}</Label>
                  <Input
                    id={`cf-${name}`}
                    inputMode="decimal"
                    defaultValue={config[name] === undefined ? '' : String(config[name])}
                    onChange={(e) => numberConfig(name, e.target.value)}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {type === 'TEXT' || type === 'TEXT_AREA' || type === 'NAME' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="cf-max-length">{t('crm.customFields.config.max_length')}</Label>
              <Input
                id="cf-max-length"
                inputMode="numeric"
                className="w-32"
                defaultValue={config.max_length === undefined ? '' : String(config.max_length)}
                onChange={(e) => numberConfig('max_length', e.target.value)}
              />
            </div>
          ) : null}
          {type === 'SOCIAL_SECURITY_NUMBER' ? (
            <div className="grid gap-1.5">
              <Label>{t('crm.customFields.config.format')}</Label>
              <ChoiceSelect
                value={config.format ?? 'generic'}
                allowEmpty={false}
                ariaLabel={t('crm.customFields.config.format')}
                choices={[
                  { value: 'generic', label: t('crm.customFields.format.generic') },
                  { value: 'us_ssn', label: t('crm.customFields.format.us_ssn') },
                ]}
                onChange={(format) =>
                  setConfig({ ...config, format: format as 'generic' | 'us_ssn' })
                }
              />
            </div>
          ) : null}
          {hasOptions ? (
            <div className="grid gap-1.5">
              <Label>{t('crm.customFields.options')}</Label>
              <OptionsEditor
                options={options}
                onChange={setOptions}
                depth={1}
                maxDepth={type === 'DRILLDOWN' ? 3 : 1}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
