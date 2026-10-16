import type { LiquidSchema, LiquidSchemaField } from '@amable/api-types';
import {
  BUILDER_OPERATORS,
  caseBlock,
  DATE_FORMAT_PRESETS,
  dateExpression,
  fallbackExpression,
  hasTagBlock,
  ifElseBlock,
  loopBlock,
  operatorTakesField,
  operatorTakesValue,
  type BuilderBranch,
  type BuilderCondition,
  type BuilderOperator,
  type DateTimezone,
} from '@amable/email-render';
import type { MessageKey } from '@amable/i18n';
import { toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { Copy, CornerDownLeft, Play, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { emailKeys, useEmailApi } from '../api';
import { LiquidCode } from './code-editor';
import { conditionFields, fieldLabel } from './schema';

export type BuilderId = 'fallback' | 'date' | 'if' | 'tag' | 'loop' | 'case';
export const BUILDERS: readonly BuilderId[] = ['fallback', 'date', 'if', 'tag', 'loop', 'case'];

const OPERATOR_LABELS: Readonly<Record<BuilderOperator, MessageKey>> = {
  equals: 'email.liquid.op.equals',
  not_equals: 'email.liquid.op.not_equals',
  contains: 'email.liquid.op.contains',
  greater_than: 'email.liquid.op.greater_than',
  less_than: 'email.liquid.op.less_than',
  greater_or_equal: 'email.liquid.op.greater_or_equal',
  less_or_equal: 'email.liquid.op.less_or_equal',
  is_empty: 'email.liquid.op.is_empty',
  is_not_empty: 'email.liquid.op.is_not_empty',
  has_tag: 'email.liquid.op.has_tag',
};

const SELECT_CLASS =
  'h-9 w-full min-w-0 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-(--obsidian-dashboard-shell-ring)';

function NativeSelect({
  value,
  onChange,
  children,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <select className={SELECT_CLASS} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );
}

function FieldOptions({ fields }: { fields: readonly LiquidSchemaField[] }) {
  const { t } = useI18n();
  return (
    <>
      {fields.map((field) => (
        <option key={field.path} value={field.path}>
          {fieldLabel(t, field)} — {field.path}
        </option>
      ))}
    </>
  );
}

function Body({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Textarea id={id} rows={2} className="font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </div>
  );
}

export interface GeneratedActions {
  readonly onInsert: (code: string) => void;
  readonly onTry: (code: string) => void;
}

/** The generated Liquid with copy / insert / try-in-preview. */
export function GeneratedCode({ code, onInsert, onTry }: { code: string | null } & GeneratedActions) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 rounded-md border p-2" data-testid="liquid-generated">
      <span className="text-xs font-medium">{t('email.liquid.build.generated')}</span>
      {code === null ? (
        <p className="text-xs text-(--obsidian-dashboard-shell-danger)">{t('email.liquid.build.incomplete')}</p>
      ) : (
        <LiquidCode code={code} className="rounded bg-(--obsidian-dashboard-shell-muted) p-2" />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={code === null}
          onClick={() => {
            if (code === null) return;
            void navigator.clipboard.writeText(code).then(() => toast.success(t('email.liquid.copied')));
          }}
        >
          <Copy className="size-3.5" />
          {t('email.liquid.copy')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={code === null} onClick={() => code !== null && onTry(code)}>
          <Play className="size-3.5" />
          {t('email.liquid.build.try')}
        </Button>
        <Button type="button" size="sm" disabled={code === null} onClick={() => code !== null && onInsert(code)}>
          <CornerDownLeft className="size-3.5" />
          {t('email.liquid.insert')}
        </Button>
      </div>
    </div>
  );
}

function FallbackBuilder({ schema, ...actions }: { schema: LiquidSchema | undefined } & GeneratedActions) {
  const { t } = useI18n();
  const fields = conditionFields(schema);
  const [path, setPath] = useState('contact.first_name');
  const [fallback, setFallback] = useState('');
  const [transform, setTransform] = useState('');
  const [truncate, setTruncate] = useState('');
  const filters = [transform, truncate !== '' ? `truncate: ${truncate}` : ''].filter((f) => f !== '');
  const code = fallbackExpression({ path, fallback, filters });
  return (
    <div className="grid gap-3">
      <Row label={t('email.liquid.build.field')}>
        <NativeSelect label={t('email.liquid.build.field')} value={path} onChange={setPath}>
          <FieldOptions fields={fields} />
        </NativeSelect>
      </Row>
      <Row label={t('email.liquid.build.fallback')}>
        <Input value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder={t('email.liquid.fields.fallbackPlaceholder')} />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t('email.liquid.build.transform')}>
          <NativeSelect label={t('email.liquid.build.transform')} value={transform} onChange={setTransform}>
            <option value="">{t('email.liquid.build.none')}</option>
            <option value="capitalize">capitalize</option>
            <option value="upcase">upcase</option>
            <option value="downcase">downcase</option>
          </NativeSelect>
        </Row>
        <Row label={t('email.liquid.build.truncate')}>
          <Input type="number" min={1} value={truncate} onChange={(e) => setTruncate(e.target.value.replace(/\D/g, ''))} />
        </Row>
      </div>
      <GeneratedCode code={code} {...actions} />
    </div>
  );
}

function DateBuilder({ schema, ...actions }: { schema: LiquidSchema | undefined } & GeneratedActions) {
  const { t } = useI18n();
  const all = schema?.fields ?? [];
  const dateFields = [
    ...all.filter((f) => f.kind === 'date'),
    ...all.filter((f) => f.kind !== 'date' && f.group === 'custom'),
  ];
  const [path, setPath] = useState('now');
  const [preset, setPreset] = useState(DATE_FORMAT_PRESETS[0]?.format ?? '%d/%m/%Y');
  const [custom, setCustom] = useState('');
  const [zoneKind, setZoneKind] = useState<DateTimezone['kind']>('contact');
  const [zone, setZone] = useState('Europe/Rome');
  const [fallback, setFallback] = useState('');
  const timezone: DateTimezone = zoneKind === 'fixed' ? { kind: 'fixed', zone } : { kind: zoneKind };
  const code = dateExpression({ path, format: custom.trim() !== '' ? custom : preset, timezone, fallback: path === 'now' ? null : fallback });
  return (
    <div className="grid gap-3">
      <Row label={t('email.liquid.build.field')}>
        <NativeSelect label={t('email.liquid.build.field')} value={path} onChange={setPath}>
          <FieldOptions fields={dateFields} />
        </NativeSelect>
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t('email.liquid.build.format')}>
          <NativeSelect label={t('email.liquid.build.format')} value={preset} onChange={setPreset}>
            {DATE_FORMAT_PRESETS.map((p) => (
              <option key={p.id} value={p.format}>
                {p.format}
              </option>
            ))}
          </NativeSelect>
        </Row>
        <Row label={t('email.liquid.build.customFormat')}>
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="%A %-d %B" className="font-mono" />
        </Row>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t('email.liquid.build.timezone')}>
          <NativeSelect
            label={t('email.liquid.build.timezone')}
            value={zoneKind}
            onChange={(v) => setZoneKind(v === 'fixed' ? 'fixed' : v === 'default' ? 'default' : 'contact')}
          >
            <option value="contact">{t('email.liquid.build.tzContact')}</option>
            <option value="default">{t('email.liquid.build.tzDefault')}</option>
            <option value="fixed">{t('email.liquid.build.tzFixed')}</option>
          </NativeSelect>
        </Row>
        {zoneKind === 'fixed' ? (
          <Row label={t('email.liquid.build.zone')}>
            <Input value={zone} onChange={(e) => setZone(e.target.value)} className="font-mono" />
          </Row>
        ) : path !== 'now' ? (
          <Row label={t('email.liquid.build.fallback')}>
            <Input value={fallback} onChange={(e) => setFallback(e.target.value)} />
          </Row>
        ) : null}
      </div>
      <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('email.liquid.build.dateHint')}</p>
      <GeneratedCode code={code} {...actions} />
    </div>
  );
}

const newCondition = (field = 'contact.first_name'): BuilderCondition => ({ field, operator: 'is_not_empty', value: '' });

function ConditionEditor({
  condition,
  fields,
  tags,
  onChange,
  onRemove,
}: {
  condition: BuilderCondition;
  fields: readonly LiquidSchemaField[];
  tags: readonly string[];
  onChange: (next: BuilderCondition) => void;
  onRemove: (() => void) | null;
}) {
  const { t } = useI18n();
  const listId = useId();
  const field = fields.find((f) => f.path === condition.field);
  const numeric = field?.kind === 'number';
  return (
    <div className="grid gap-1.5 rounded-md border border-dashed p-2" data-testid="liquid-condition">
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <NativeSelect
          label={t('email.liquid.build.operator')}
          value={condition.operator}
          onChange={(v) => onChange({ ...condition, operator: v as BuilderOperator })}
        >
          {BUILDER_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {t(OPERATOR_LABELS[op])}
            </option>
          ))}
        </NativeSelect>
        {onRemove !== null ? (
          <Button type="button" size="icon" variant="ghost" className="size-9" onClick={onRemove} aria-label={t('email.liquid.build.removeCondition')}>
            <Trash2 className="size-3.5" />
          </Button>
        ) : (
          <span />
        )}
      </div>
      {operatorTakesField(condition.operator) ? (
        <NativeSelect label={t('email.liquid.build.field')} value={condition.field} onChange={(v) => onChange({ ...condition, field: v })}>
          <FieldOptions fields={fields} />
        </NativeSelect>
      ) : null}
      {operatorTakesValue(condition.operator) ? (
        <>
          <Input
            value={condition.value ?? ''}
            list={listId}
            aria-label={t('email.liquid.build.value')}
            placeholder={condition.operator === 'has_tag' ? t('email.liquid.build.tag') : t('email.liquid.build.value')}
            onChange={(e) =>
              onChange({
                ...condition,
                value: e.target.value,
                ...(numeric && condition.operator !== 'contains' ? { valueType: 'number' as const } : {}),
              })
            }
          />
          <datalist id={listId}>
            {(condition.operator === 'has_tag' ? tags : (field?.options ?? [])).map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </>
      ) : null}
    </div>
  );
}

function useTagNames(): string[] {
  const { slug, api } = useEmailApi();
  const tags = useQuery({ queryKey: emailKeys.crm(slug, 'tags'), queryFn: api.crm.tags, staleTime: 60_000 });
  return (tags.data?.data ?? []).map((tag) => tag.name);
}

function IfElseBuilder({ schema, ...actions }: { schema: LiquidSchema | undefined } & GeneratedActions) {
  const { t } = useI18n();
  const fields = conditionFields(schema);
  const tags = useTagNames();
  const [branches, setBranches] = useState<BuilderBranch[]>([
    { join: 'and', conditions: [newCondition()], body: 'Hi {{ contact.first_name }}!' },
  ]);
  const [elseBody, setElseBody] = useState('Hi there!');
  const update = (index: number, next: Partial<BuilderBranch>) =>
    setBranches((current) => current.map((b, i) => (i === index ? { ...b, ...next } : b)));
  const code = ifElseBlock({ branches, elseBody });
  return (
    <div className="grid gap-3">
      {branches.map((branch, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-2" data-testid="liquid-branch">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-xs">{index === 0 ? t('email.liquid.build.if') : t('email.liquid.build.elsif')}</strong>
            <div className="flex items-center gap-1">
              {branch.conditions.length > 1 ? (
                <NativeSelect label={t('email.liquid.build.join')} value={branch.join} onChange={(v) => update(index, { join: v === 'or' ? 'or' : 'and' })}>
                  <option value="and">{t('email.liquid.build.and')}</option>
                  <option value="or">{t('email.liquid.build.or')}</option>
                </NativeSelect>
              ) : null}
              {index > 0 ? (
                <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setBranches((c) => c.filter((_, i) => i !== index))} aria-label={t('email.liquid.build.removeBranch')}>
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
          {branch.conditions.map((condition, ci) => (
            <ConditionEditor
              key={ci}
              condition={condition}
              fields={fields}
              tags={tags}
              onChange={(next) => update(index, { conditions: branch.conditions.map((c, k) => (k === ci ? next : c)) })}
              onRemove={branch.conditions.length > 1 ? () => update(index, { conditions: branch.conditions.filter((_, k) => k !== ci) }) : null}
            />
          ))}
          <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => update(index, { conditions: [...branch.conditions, newCondition()] })}>
            <Plus className="size-3.5" />
            {t('email.liquid.build.addCondition')}
          </Button>
          <Body label={t('email.liquid.build.then')} value={branch.body} onChange={(body) => update(index, { body })} />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="justify-self-start"
        onClick={() => setBranches((c) => [...c, { join: 'and', conditions: [newCondition()], body: '' }])}
      >
        <Plus className="size-3.5" />
        {t('email.liquid.build.addElsif')}
      </Button>
      <Body label={t('email.liquid.build.else')} value={elseBody} onChange={setElseBody} />
      <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('email.liquid.build.ifHint')}</p>
      <GeneratedCode code={code} {...actions} />
    </div>
  );
}

function TagBuilder(actions: GeneratedActions) {
  const { t } = useI18n();
  const tags = useTagNames();
  const listId = useId();
  const [tag, setTag] = useState(tags[0] ?? 'VIP');
  const [negate, setNegate] = useState(false);
  const [body, setBody] = useState('');
  const [elseBody, setElseBody] = useState('');
  const code = hasTagBlock({ tag, negate, body, elseBody });
  return (
    <div className="grid gap-3">
      <Row label={t('email.liquid.build.tag')}>
        <Input value={tag} list={listId} onChange={(e) => setTag(e.target.value)} />
        <datalist id={listId}>
          {tags.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Row>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={negate} onCheckedChange={setNegate} />
        {t('email.liquid.build.negateTag')}
      </label>
      <Body label={t('email.liquid.build.then')} value={body} onChange={setBody} />
      <Body label={t('email.liquid.build.else')} value={elseBody} onChange={setElseBody} />
      <GeneratedCode code={code} {...actions} />
    </div>
  );
}

function LoopBuilder({ schema, ...actions }: { schema: LiquidSchema | undefined } & GeneratedActions) {
  const { t } = useI18n();
  const lists = (schema?.fields ?? []).filter((f) => f.kind === 'list');
  const [collection, setCollection] = useState('contact.tags');
  const [item, setItem] = useState('item');
  const [limit, setLimit] = useState('3');
  const [separator, setSeparator] = useState(', ');
  const [body, setBody] = useState('{{ item }}');
  const [emptyBody, setEmptyBody] = useState('');
  const code = loopBlock({
    collection,
    item,
    limit: limit === '' ? null : Number(limit),
    body,
    separator,
    emptyBody,
  });
  return (
    <div className="grid gap-3">
      <Row label={t('email.liquid.build.collection')}>
        <NativeSelect label={t('email.liquid.build.collection')} value={collection} onChange={setCollection}>
          <FieldOptions fields={lists} />
        </NativeSelect>
      </Row>
      <div className="grid grid-cols-3 gap-2">
        <Row label={t('email.liquid.build.item')}>
          <Input value={item} onChange={(e) => setItem(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} className="font-mono" />
        </Row>
        <Row label={t('email.liquid.build.limit')}>
          <Input type="number" min={0} max={1000} value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />
        </Row>
        <Row label={t('email.liquid.build.separator')}>
          <Input value={separator} onChange={(e) => setSeparator(e.target.value)} />
        </Row>
      </div>
      <Body label={t('email.liquid.build.loopBody')} value={body} onChange={setBody} />
      <Body label={t('email.liquid.build.emptyBody')} value={emptyBody} onChange={setEmptyBody} />
      <GeneratedCode code={code} {...actions} />
    </div>
  );
}

function CaseBuilder({ schema, ...actions }: { schema: LiquidSchema | undefined } & GeneratedActions) {
  const { t } = useI18n();
  const fields = conditionFields(schema);
  const firstWithOptions = fields.find((f) => f.options.length > 0);
  const [field, setField] = useState(firstWithOptions?.path ?? 'contact.country');
  const selected = fields.find((f) => f.path === field);
  const [whens, setWhens] = useState<{ values: string; body: string }[]>(
    (selected?.options.slice(0, 2) ?? ['IT', 'US']).map((value) => ({ values: value, body: '' })),
  );
  const [elseBody, setElseBody] = useState('');
  const code = caseBlock({
    field,
    whens: whens.map((w) => ({ values: w.values.split(','), body: w.body })),
    elseBody,
    ...(selected?.kind === 'number' ? { valueType: 'number' as const } : {}),
  });
  return (
    <div className="grid gap-3">
      <Row label={t('email.liquid.build.field')}>
        <NativeSelect label={t('email.liquid.build.field')} value={field} onChange={setField}>
          <FieldOptions fields={fields} />
        </NativeSelect>
      </Row>
      {selected !== undefined && selected.options.length > 0 ? (
        <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
          {t('email.liquid.build.options')}: <code>{selected.options.join(', ')}</code>
        </p>
      ) : null}
      {whens.map((when, index) => (
        <div key={index} className="grid gap-1.5 rounded-md border p-2">
          <div className="grid grid-cols-[1fr_auto] gap-1.5">
            <Input
              value={when.values}
              aria-label={t('email.liquid.build.whenValues')}
              placeholder={t('email.liquid.build.whenValues')}
              onChange={(e) => setWhens((c) => c.map((w, i) => (i === index ? { ...w, values: e.target.value } : w)))}
            />
            <Button type="button" size="icon" variant="ghost" className="size-9" onClick={() => setWhens((c) => c.filter((_, i) => i !== index))} aria-label={t('email.liquid.build.removeBranch')}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <Body label={t('email.liquid.build.then')} value={when.body} onChange={(body) => setWhens((c) => c.map((w, i) => (i === index ? { ...w, body } : w)))} />
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setWhens((c) => [...c, { values: '', body: '' }])}>
        <Plus className="size-3.5" />
        {t('email.liquid.build.addWhen')}
      </Button>
      <Body label={t('email.liquid.build.else')} value={elseBody} onChange={setElseBody} />
      <GeneratedCode code={code} {...actions} />
    </div>
  );
}

const BUILDER_LABELS: Readonly<Record<BuilderId, MessageKey>> = {
  fallback: 'email.liquid.build.kind.fallback',
  date: 'email.liquid.build.kind.date',
  if: 'email.liquid.build.kind.if',
  tag: 'email.liquid.build.kind.tag',
  loop: 'email.liquid.build.kind.loop',
  case: 'email.liquid.build.kind.case',
};

/** Guided forms that generate Liquid (one at a time). */
export function Builders({ schema, ...actions }: { schema: LiquidSchema | undefined } & GeneratedActions) {
  const { t } = useI18n();
  const [kind, setKind] = useState<BuilderId>('if');
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1" role="tablist">
        {BUILDERS.map((id) => (
          <Button key={id} type="button" size="sm" role="tab" aria-selected={kind === id} variant={kind === id ? 'default' : 'outline'} onClick={() => setKind(id)}>
            {t(BUILDER_LABELS[id])}
          </Button>
        ))}
      </div>
      {kind === 'fallback' ? <FallbackBuilder schema={schema} {...actions} /> : null}
      {kind === 'date' ? <DateBuilder schema={schema} {...actions} /> : null}
      {kind === 'if' ? <IfElseBuilder schema={schema} {...actions} /> : null}
      {kind === 'tag' ? <TagBuilder {...actions} /> : null}
      {kind === 'loop' ? <LoopBuilder schema={schema} {...actions} /> : null}
      {kind === 'case' ? <CaseBuilder schema={schema} {...actions} /> : null}
    </div>
  );
}
