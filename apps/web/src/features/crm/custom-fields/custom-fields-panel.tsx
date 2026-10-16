import type {
  CustomField,
  CustomFieldLayout,
  CustomFieldValueInput,
  CustomFieldValues,
} from '@amable/api-types/crm';
import { cn } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { Check, Lock, Pencil, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useDirectory } from '../api/hooks';
import { CustomFieldInput } from './field-input';
import { formatCustomValue, isMaskedValue } from './display';
import { toWidgetValue, validateCustomFieldValue, type WidgetValue } from './validation';

export interface CustomFieldsPanelProps {
  readonly layout: CustomFieldLayout;
  readonly values: CustomFieldValues;
  readonly canEdit: boolean;
  readonly canReadSensitive: boolean;
  readonly onSave: (key: string, value: CustomFieldValueInput) => Promise<unknown>;
}

/** One custom field, read-only until "edit"; validated client-side before saving. */
export function CustomFieldRow({
  field,
  value,
  canEdit,
  canReadSensitive,
  onSave,
}: {
  field: CustomField;
  value: CustomFieldValueInput | undefined;
  canEdit: boolean;
  canReadSensitive: boolean;
  onSave: (key: string, value: CustomFieldValueInput) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const { nameOf } = useDirectory();
  const [draft, setDraft] = useState<WidgetValue | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const masked = field.sensitive && (!canReadSensitive || isMaskedValue(value));
  const editing = draft !== undefined;
  const display = formatCustomValue(field, value, {
    locale,
    nameOf,
    yes: t('crm.common.yes'),
    no: t('crm.common.no'),
  });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (draft === undefined) return;
    const result = validateCustomFieldValue(field, draft);
    if (!result.ok) {
      setError(t(`crm.validation.${result.error}`, result.vars));
      return;
    }
    setSaving(true);
    try {
      await onSave(field.key, result.value);
      setDraft(undefined);
      setError(null);
    } catch {
      // the mutation already reported the failure
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[minmax(8rem,14rem)_1fr] sm:items-start sm:gap-3">
      <div className="flex items-center gap-1.5 pt-1.5 text-xs text-muted-foreground">
        <span>{field.label}</span>
        {field.required ? <span aria-hidden>*</span> : null}
        {field.sensitive ? <Lock className="size-3" aria-label={t('crm.field.sensitive')} /> : null}
      </div>
      {editing ? (
        <form className="flex flex-col gap-1.5" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-wrap items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <CustomFieldInput
                field={field}
                value={draft}
                onChange={(next) => {
                  setDraft(next);
                  setError(null);
                }}
                invalid={error !== null}
                disabled={saving}
                autoFocus
              />
            </div>
            <Button
              type="submit"
              size="icon"
              className="size-8"
              disabled={saving}
              aria-label={t('common.save')}
            >
              <Check className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('common.cancel')}
              onClick={() => {
                setDraft(undefined);
                setError(null);
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          {error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="group flex min-h-8 items-center gap-2">
          <span className={cn('text-sm break-words', display === '' && 'text-muted-foreground')}>
            {masked ? (
              <span className="font-mono">{typeof value === 'string' ? value : '••••'}</span>
            ) : display === '' ? (
              '—'
            ) : (
              display
            )}
          </span>
          {canEdit && !masked ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-60 group-hover:opacity-100"
              aria-label={t('crm.field.editNamed', { name: field.label })}
              onClick={() => setDraft(toWidgetValue(field.type, value))}
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Custom fields rendered by layout: tabs → groups → fields, plus the ungrouped ones. */
export function CustomFieldsPanel({
  layout,
  values,
  canEdit,
  canReadSensitive,
  onSave,
}: CustomFieldsPanelProps) {
  const { t } = useI18n();
  const tabs = layout.tabs.filter((tab) => tab.groups.some((group) => group.fields.length > 0));
  const row = (field: CustomField) => (
    <CustomFieldRow
      key={field.id}
      field={field}
      value={values[field.key]}
      canEdit={canEdit}
      canReadSensitive={canReadSensitive}
      onSave={onSave}
    />
  );
  if (tabs.length === 0 && layout.ungrouped.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{t('crm.customFields.none')}</p>;
  }
  const ungroupedValue = '__ungrouped__';
  const first = tabs[0]?.id ?? ungroupedValue;
  return (
    <Tabs defaultValue={first}>
      <TabsList className="flex-wrap">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.name}
          </TabsTrigger>
        ))}
        {layout.ungrouped.length > 0 ? (
          <TabsTrigger value={ungroupedValue}>
            {t('crm.customFields.other')}{' '}
            <Badge variant="secondary" className="ml-1">
              {layout.ungrouped.length}
            </Badge>
          </TabsTrigger>
        ) : null}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="space-y-4 pt-2">
          {tab.groups
            .filter((group) => group.fields.length > 0)
            .map((group) => (
              <section key={group.id} aria-label={group.name}>
                <h4 className="border-b pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.name}
                </h4>
                <div className="divide-y">{group.fields.map(row)}</div>
              </section>
            ))}
        </TabsContent>
      ))}
      {layout.ungrouped.length > 0 ? (
        <TabsContent value={ungroupedValue} className="divide-y pt-2">
          {layout.ungrouped.map(row)}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

/** Layout tabs that have at least one field, for pages that show each as its own tab. */
export function customFieldTabsOf(layout: CustomFieldLayout) {
  return layout.tabs.filter((tab) => tab.groups.some((group) => group.fields.length > 0));
}

/**
 * The groups of one layout tab (`tabId`), or the ungrouped fields when
 * `tabId` is `null`.
 */
export function CustomFieldsSection({
  layout,
  tabId,
  values,
  canEdit,
  canReadSensitive,
  onSave,
}: CustomFieldsPanelProps & { readonly tabId: string | null }) {
  const { t } = useI18n();
  const row = (field: CustomField) => (
    <CustomFieldRow
      key={field.id}
      field={field}
      value={values[field.key]}
      canEdit={canEdit}
      canReadSensitive={canReadSensitive}
      onSave={onSave}
    />
  );
  if (tabId === null) {
    return layout.ungrouped.length === 0 ? (
      <p className="py-4 text-sm text-muted-foreground">{t('crm.customFields.none')}</p>
    ) : (
      <div className="divide-y">{layout.ungrouped.map(row)}</div>
    );
  }
  const groups = (layout.tabs.find((tab) => tab.id === tabId)?.groups ?? []).filter(
    (group) => group.fields.length > 0,
  );
  if (groups.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{t('crm.customFields.none')}</p>;
  }
  return (
    <div className="grid gap-x-8 gap-y-4 xl:grid-cols-2">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.name}>
          <h4 className="border-b pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.name}
          </h4>
          <div className="divide-y">{group.fields.map(row)}</div>
        </section>
      ))}
    </div>
  );
}
