import type { CustomField } from '@amable/api-types';
import {
  CONDITION_OPS,
  CONTACT_MAP_TARGETS,
  type ConditionOp,
  type FieldKind,
  type FormDefinition,
  type FormField,
} from '@amable/forms';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@amable/ui/ui/dropdown-menu';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { ADDABLE_KINDS, collectsValue, newField, OPTION_KINDS } from '../lib/fields';
import { Choice, FormField as Field, Pill } from './common';

type Patch = (patch: Partial<FormField>) => void;

/** Ordered field list with add / move / remove; selecting a row opens its properties. */
export function FieldList({
  definition,
  selectedId,
  onSelect,
  onChange,
  disabled,
}: {
  definition: FormDefinition;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (fields: FormField[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const fields = definition.fields;
  const move = (index: number, delta: number) => {
    const next = [...fields];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  const add = (kind: FieldKind) => {
    const field = newField(kind, definition, t(`forms.kind.${kind}`));
    onChange([...fields, field]);
    onSelect(field.id);
  };
  return (
    <div className="grid gap-2">
      <ol className="grid gap-1.5" aria-label={t('forms.builder.fields')}>
        {fields.map((field, index) => (
          <li key={field.id}>
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm',
                selectedId === field.id && 'border-primary ring-1 ring-primary',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start text-left"
                onClick={() => onSelect(field.id)}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate font-medium">
                    {field.kind === 'page_break' ? `— ${field.label || t('forms.kind.page_break')} —` : field.label || field.key}
                  </span>
                  {field.required ? <span className="text-destructive">*</span> : null}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t(`forms.kind.${field.kind}`)}</span>
                  {collectsValue(field.kind) ? <code>{field.key}</code> : null}
                  {field.map_to !== null ? <Pill tone="info">→ {field.map_to}</Pill> : null}
                  {field.visible_if.length > 0 ? <Pill tone="neutral">{t('forms.builder.conditional')}</Pill> : null}
                </span>
              </button>
              <Button type="button" size="icon" variant="ghost" aria-label={t('forms.builder.moveUp')} disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                <ArrowUp aria-hidden />
              </Button>
              <Button type="button" size="icon" variant="ghost" aria-label={t('forms.builder.moveDown')} disabled={disabled || index === fields.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('forms.builder.removeField')}
                disabled={disabled}
                onClick={() => onChange(fields.filter((f) => f.id !== field.id))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {fields.length === 0 ? <p className="text-sm text-muted-foreground">{t('forms.builder.noFields')}</p> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" disabled={disabled} className="justify-self-start">
            <Plus aria-hidden /> {t('forms.builder.addField')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          {ADDABLE_KINDS.map((kind) => (
            <DropdownMenuItem key={kind} onSelect={() => add(kind)}>
              {t(`forms.kind.${kind}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OptionsEditor({ field, onPatch, disabled }: { field: FormField; onPatch: Patch; disabled: boolean }) {
  const { t } = useI18n();
  const update = (index: number, key: 'label' | 'value', value: string) =>
    onPatch({ options: field.options.map((o, i) => (i === index ? { ...o, [key]: value } : o)) });
  return (
    <div className="grid gap-1.5">
      {field.options.map((option, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <Input aria-label={t('forms.builder.optionLabel')} value={option.label} disabled={disabled} onChange={(e) => update(index, 'label', e.target.value)} />
          <Input aria-label={t('forms.builder.optionValue')} value={option.value} disabled={disabled} className="font-mono" onChange={(e) => update(index, 'value', e.target.value)} />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={t('forms.builder.removeOption')}
            disabled={disabled}
            onClick={() => onPatch({ options: field.options.filter((_, i) => i !== index) })}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start"
        disabled={disabled}
        onClick={() => {
          const n = field.options.length + 1;
          onPatch({ options: [...field.options, { label: `${t('forms.builder.option')} ${String(n)}`, value: `option_${String(n)}` }] });
        }}
      >
        <Plus aria-hidden /> {t('forms.builder.addOption')}
      </Button>
    </div>
  );
}

function ConditionsEditor({
  field,
  fields,
  onPatch,
  disabled,
}: {
  field: FormField;
  fields: readonly FormField[];
  onPatch: Patch;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const sources = fields.filter((f) => f.id !== field.id && collectsValue(f.kind));
  const rules = field.visible_if;
  return (
    <div className="grid gap-1.5">
      {rules.map((rule, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5">
          <Choice
            value={rule.field_key}
            options={sources.map((f) => ({ value: f.key, label: f.label || f.key }))}
            disabled={disabled}
            onChange={(value) => onPatch({ visible_if: rules.map((r, i) => (i === index ? { ...r, field_key: value ?? r.field_key } : r)) })}
          />
          <Choice
            value={rule.op}
            options={CONDITION_OPS.map((op) => ({ value: op, label: t(`forms.op.${op}`) }))}
            disabled={disabled}
            onChange={(value) => onPatch({ visible_if: rules.map((r, i) => (i === index ? { ...r, op: (value ?? r.op) as ConditionOp } : r)) })}
          />
          <Input
            aria-label={t('forms.builder.conditionValue')}
            value={rule.value}
            disabled={disabled || rule.op === 'filled' || rule.op === 'empty'}
            onChange={(e) => onPatch({ visible_if: rules.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)) })}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={t('forms.builder.removeCondition')}
            disabled={disabled}
            onClick={() => onPatch({ visible_if: rules.filter((_, i) => i !== index) })}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start"
        disabled={disabled || sources.length === 0}
        onClick={() => {
          const first = sources[0];
          if (first !== undefined) onPatch({ visible_if: [...rules, { field_key: first.key, op: 'filled', value: '' }] });
        }}
      >
        <Plus aria-hidden /> {t('forms.builder.addCondition')}
      </Button>
    </div>
  );
}

const num = (text: string): number | undefined => {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

/** Properties of the selected field, including its CRM mapping. */
export function FieldProperties({
  field,
  fields,
  customFields,
  onPatch,
  disabled,
}: {
  field: FormField;
  fields: readonly FormField[];
  customFields: readonly CustomField[];
  onPatch: Patch;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const valueKind = collectsValue(field.kind);
  const usedTargets = new Set(fields.filter((f) => f.id !== field.id).map((f) => f.map_to));
  const targets = [
    ...CONTACT_MAP_TARGETS.map((target) => ({ value: target, label: t(`forms.map.${target}`) })),
    ...customFields.map((cf) => ({ value: `custom.${cf.key}`, label: `${t('forms.map.custom')}: ${cf.label}` })),
  ].filter((option) => !usedTargets.has(option.value));

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={field.kind === 'page_break' ? t('forms.builder.stepTitle') : t('forms.builder.label')}>
          {(id) => <Input id={id} value={field.label} disabled={disabled} onChange={(e) => onPatch({ label: e.target.value })} />}
        </Field>
        {valueKind ? (
          <Field label={t('forms.builder.key')} hint={t('forms.builder.keyHint')}>
            {(id) => (
              <Input
                id={id}
                value={field.key}
                className="font-mono"
                disabled={disabled}
                onChange={(e) => onPatch({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63) })}
              />
            )}
          </Field>
        ) : null}
      </div>
      {field.kind !== 'page_break' && field.kind !== 'html' && field.kind !== 'hidden' ? (
        <Field label={t('forms.builder.description')}>
          {(id) => <Textarea id={id} rows={2} value={field.description} disabled={disabled} onChange={(e) => onPatch({ description: e.target.value })} />}
        </Field>
      ) : null}
      {field.kind === 'html' ? (
        <Field label={t('forms.kind.html')} hint={t('forms.builder.htmlHint')}>
          {(id) => <Textarea id={id} rows={5} className="font-mono text-xs" value={field.html} disabled={disabled} onChange={(e) => onPatch({ html: e.target.value })} />}
        </Field>
      ) : null}
      {['text', 'email', 'phone', 'textarea', 'number', 'select'].includes(field.kind) ? (
        <Field label={t('forms.builder.placeholder')}>
          {(id) => <Input id={id} value={field.placeholder} disabled={disabled} onChange={(e) => onPatch({ placeholder: e.target.value })} />}
        </Field>
      ) : null}
      {OPTION_KINDS.has(field.kind) ? (
        <Field label={t('forms.builder.options')}>{() => <OptionsEditor field={field} onPatch={onPatch} disabled={disabled} />}</Field>
      ) : null}
      {field.kind === 'number' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('forms.builder.min')}>
            {(id) => <Input id={id} type="number" value={field.min ?? ''} disabled={disabled} onChange={(e) => onPatch({ min: num(e.target.value) })} />}
          </Field>
          <Field label={t('forms.builder.max')}>
            {(id) => <Input id={id} type="number" value={field.max ?? ''} disabled={disabled} onChange={(e) => onPatch({ max: num(e.target.value) })} />}
          </Field>
        </div>
      ) : null}
      {field.kind === 'rating' ? (
        <Field label={t('forms.builder.maxRating')}>
          {(id) => (
            <Input id={id} type="number" min={1} max={10} value={field.max_rating} disabled={disabled} onChange={(e) => onPatch({ max_rating: Math.min(10, Math.max(1, Math.round(num(e.target.value) ?? 5))) })} />
          )}
        </Field>
      ) : null}
      {field.kind === 'consent' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('forms.builder.linkUrl')}>
            {(id) => <Input id={id} type="url" value={field.link_url} disabled={disabled} onChange={(e) => onPatch({ link_url: e.target.value.trim() })} />}
          </Field>
          <Field label={t('forms.builder.linkText')}>
            {(id) => <Input id={id} value={field.link_text} disabled={disabled} onChange={(e) => onPatch({ link_text: e.target.value })} />}
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Switch checked={field.marketing} disabled={disabled} onCheckedChange={(marketing) => onPatch({ marketing })} />
            {t('forms.builder.marketingConsent')}
          </label>
        </div>
      ) : null}
      {valueKind ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={field.kind === 'hidden' ? t('forms.builder.urlParam') : t('forms.builder.prefillParam')} hint={t('forms.builder.prefillHint')}>
            {(id) => <Input id={id} className="font-mono" value={field.prefill_param} disabled={disabled} onChange={(e) => onPatch({ prefill_param: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) })} />}
          </Field>
          <Field label={t('forms.builder.defaultValue')}>
            {(id) => <Input id={id} value={field.default_value} disabled={disabled} onChange={(e) => onPatch({ default_value: e.target.value })} />}
          </Field>
        </div>
      ) : null}
      {valueKind ? (
        <Field label={t('forms.builder.mapTo')} hint={t('forms.builder.mapToHint')}>
          {(id) => (
            <Choice
              id={id}
              value={field.map_to}
              noneLabel={t('forms.map.none')}
              options={field.map_to !== null && !targets.some((o) => o.value === field.map_to) ? [{ value: field.map_to, label: field.map_to }, ...targets] : targets}
              disabled={disabled}
              onChange={(map_to) => onPatch({ map_to: map_to as FormField['map_to'] })}
            />
          )}
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-4">
        {valueKind && field.kind !== 'hidden' ? (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={field.required} disabled={disabled} onCheckedChange={(required) => onPatch({ required })} />
            {t('forms.builder.required')}
          </label>
        ) : null}
        {field.kind !== 'page_break' && field.kind !== 'hidden' ? (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={field.width === 'half'} disabled={disabled} onCheckedChange={(half) => onPatch({ width: half ? 'half' : 'full' })} />
            {t('forms.builder.halfWidth')}
          </label>
        ) : null}
        {valueKind ? (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={field.sensitive} disabled={disabled} onCheckedChange={(sensitive) => onPatch({ sensitive })} />
            {t('forms.builder.sensitive')}
          </label>
        ) : null}
      </div>
      {field.kind !== 'page_break' ? (
        <Field label={t('forms.builder.visibleIf')} hint={t('forms.builder.visibleIfHint')}>
          {() => <ConditionsEditor field={field} fields={fields} onPatch={onPatch} disabled={disabled} />}
        </Field>
      ) : null}
    </div>
  );
}
