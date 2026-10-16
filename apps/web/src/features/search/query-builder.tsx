import type { FieldOperator } from '@amable/api-types/crm';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Brackets, Plus, Tag, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  ChoiceSelect,
  DatePicker,
  MultiChoice,
  TagMultiSelect,
  type Choice,
} from '../crm/components/inputs';
import { CompanyIdSelect, CompanyIdsSelect } from '../crm/components/company-picker';
import type { FieldMeta } from '../crm/field-catalog';
import {
  appendNode,
  emptyGroup,
  fieldCondition,
  MAX_GROUP_DEPTH,
  OPERATORS_BY_KIND,
  operatorForKind,
  removeNode,
  tagCondition,
  updateNode,
  valueShape,
  type UiFieldCondition,
  type UiGroup,
  type UiNode,
} from './query-model';

export interface QueryBuilderProps {
  readonly root: UiGroup;
  readonly onChange: (root: UiGroup) => void;
  readonly fields: readonly FieldMeta[];
  /** Tag conditions only exist for contacts. */
  readonly allowTags: boolean;
}

function ValueEditor({
  condition,
  meta,
  onChange,
}: {
  condition: UiFieldCondition;
  meta: FieldMeta | undefined;
  onChange: (next: UiFieldCondition) => void;
}) {
  const { t } = useI18n();
  const shape = valueShape(condition.operator);
  if (shape === 'none' || meta === undefined) return null;
  const kind = meta.kind;
  const label = t('search.value');
  const choices: readonly Choice[] | null =
    kind === 'boolean'
      ? [
          { value: 'true', label: t('crm.common.yes') },
          { value: 'false', label: t('crm.common.no') },
        ]
      : meta.choices;

  if (
    choices !== null &&
    (kind === 'enum' || kind === 'multi' || kind === 'id' || kind === 'boolean')
  ) {
    if (shape === 'list') {
      return (
        <MultiChoice
          values={condition.values}
          choices={choices}
          ariaLabel={label}
          onChange={(values) => onChange({ ...condition, values })}
        />
      );
    }
    return (
      <ChoiceSelect
        value={condition.value}
        choices={choices}
        allowEmpty={false}
        ariaLabel={label}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }

  if (meta.field === 'company_id') {
    return shape === 'list' ? (
      <CompanyIdsSelect
        values={condition.values}
        ariaLabel={label}
        onChange={(values) => onChange({ ...condition, values, value: '' })}
      />
    ) : (
      <CompanyIdSelect
        value={condition.value}
        ariaLabel={label}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }

  const isDate = kind === 'date' || kind === 'datetime_ms' || kind === 'datetime_iso';
  const single = (value: string, set: (v: string) => void, aria: string) =>
    isDate ? (
      <DatePicker value={value} onChange={set} ariaLabel={aria} />
    ) : (
      <Input
        value={value}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        onChange={(event) => set(event.target.value)}
        aria-label={aria}
        className="h-8 w-44"
      />
    );

  if (shape === 'range') {
    return (
      <div className="flex items-center gap-1.5">
        {single(condition.value, (value) => onChange({ ...condition, value }), t('search.from'))}
        <span className="text-xs text-muted-foreground">{t('search.and')}</span>
        {single(
          condition.valueTo,
          (valueTo) => onChange({ ...condition, valueTo }),
          t('search.to'),
        )}
      </div>
    );
  }
  if (shape === 'list') {
    return (
      <Input
        value={condition.values.length > 0 ? condition.values.join(', ') : condition.value}
        onChange={(event) => onChange({ ...condition, values: [], value: event.target.value })}
        placeholder={t('search.listHint')}
        aria-label={label}
        className="h-8 w-56"
      />
    );
  }
  return single(condition.value, (value) => onChange({ ...condition, value }), label);
}

function FieldRow({
  condition,
  fields,
  byField,
  onChange,
  onRemove,
}: {
  condition: UiFieldCondition;
  fields: readonly FieldMeta[];
  byField: ReadonlyMap<string, FieldMeta>;
  onChange: (next: UiFieldCondition) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const meta = byField.get(condition.field);
  const operators = meta ? OPERATORS_BY_KIND[meta.kind] : [];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="qb-field-row">
      <ChoiceSelect
        value={condition.field}
        allowEmpty={false}
        placeholder={t('search.chooseField')}
        ariaLabel={t('search.field')}
        className="w-48"
        choices={fields
          .filter((f) => f.operators.length > 0)
          .map((f) => ({ value: f.field, label: f.label }))}
        onChange={(field) => {
          const kind = byField.get(field)?.kind ?? 'text';
          onChange({
            ...condition,
            field,
            operator: operatorForKind(kind, condition.operator),
            value: '',
            valueTo: '',
            values: [],
          });
        }}
      />
      {meta ? (
        <ChoiceSelect
          value={condition.operator}
          allowEmpty={false}
          ariaLabel={t('search.operator')}
          className="w-40"
          choices={operators.map((op) => ({ value: op, label: t(`search.op.${op}`) }))}
          onChange={(operator) => onChange({ ...condition, operator: operator as FieldOperator })}
        />
      ) : null}
      <ValueEditor condition={condition} meta={meta} onChange={onChange} />
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={t('search.removeCondition')}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function GroupEditor({
  group,
  depth,
  props,
  onRemove,
}: {
  group: UiGroup;
  depth: number;
  props: QueryBuilderProps;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const { root, onChange, fields, allowTags } = props;
  const byField = new Map(fields.map((f) => [f.field, f]));
  const replace = (id: string, next: UiNode) => onChange(updateNode(root, id, () => next));
  const add = (node: UiNode) => onChange(appendNode(root, group.id, node));

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg',
        depth > 1 && 'border border-dashed border-border bg-muted/30 p-2.5',
      )}
      data-testid={`qb-group-depth-${String(depth)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('search.match')}</span>
        <ChoiceSelect
          value={group.op}
          allowEmpty={false}
          ariaLabel={t('search.groupOperator')}
          className="w-32 min-w-0"
          choices={[
            { value: 'and', label: t('search.all') },
            { value: 'or', label: t('search.any') },
          ]}
          onChange={(op) =>
            onChange(
              updateNode(
                root,
                group.id,
                (node) => ({ ...node, op: op as 'and' | 'or' }) as UiGroup,
              ),
            )
          }
        />
        <span className="text-xs text-muted-foreground">{t('search.ofConditions')}</span>
        {onRemove ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            onClick={onRemove}
            aria-label={t('search.removeGroup')}
          >
            <Trash2 className="size-3.5" aria-hidden /> {t('search.removeGroup')}
          </Button>
        ) : null}
      </div>

      {group.conditions.map((node) => {
        if (node.type === 'group') {
          return (
            <GroupEditor
              key={node.id}
              group={node}
              depth={depth + 1}
              props={props}
              onRemove={() => onChange(removeNode(root, node.id))}
            />
          );
        }
        if (node.type === 'tags') {
          return (
            <div
              key={node.id}
              className="flex flex-wrap items-center gap-1.5"
              data-testid="qb-tag-row"
            >
              <Tag className="size-3.5 text-muted-foreground" aria-hidden />
              <ChoiceSelect
                value={node.match}
                allowEmpty={false}
                ariaLabel={t('search.tagMatch')}
                className="w-44"
                choices={[
                  { value: 'any', label: t('search.tags.any') },
                  { value: 'all', label: t('search.tags.all') },
                  { value: 'none', label: t('search.tags.none') },
                ]}
                onChange={(match) =>
                  replace(node.id, { ...node, match: match as typeof node.match })
                }
              />
              <TagMultiSelect
                values={node.tagIds}
                ariaLabel={t('crm.field.tags')}
                placeholder={t('search.chooseTags')}
                allowCreate={false}
                onChange={(tagIds) => replace(node.id, { ...node, tagIds })}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('search.removeCondition')}
                onClick={() => onChange(removeNode(root, node.id))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          );
        }
        return (
          <FieldRow
            key={node.id}
            condition={node}
            fields={fields}
            byField={byField}
            onChange={(next) => replace(node.id, next)}
            onRemove={() => onChange(removeNode(root, node.id))}
          />
        );
      })}

      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" className="h-7" onClick={() => add(fieldCondition())}>
          <Plus className="size-3.5" aria-hidden /> {t('search.addCondition')}
        </Button>
        {allowTags ? (
          <Button variant="outline" size="sm" className="h-7" onClick={() => add(tagCondition())}>
            <Tag className="size-3.5" aria-hidden /> {t('search.addTags')}
          </Button>
        ) : null}
        {depth < MAX_GROUP_DEPTH ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() =>
              add({
                ...emptyGroup(group.op === 'and' ? 'or' : 'and'),
                conditions: [fieldCondition()],
              })
            }
          >
            <Brackets className="size-3.5" aria-hidden /> {t('search.addGroup')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Visual editor of the filter tree; serialize with `toFilterGroup`. */
export function QueryBuilder(props: QueryBuilderProps) {
  return <GroupEditor group={props.root} depth={1} props={props} />;
}
