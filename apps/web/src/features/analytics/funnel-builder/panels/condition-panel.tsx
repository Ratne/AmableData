import {
  CONDITION_ATTRIBUTES,
  type ConditionGroup,
  type ConditionOperator,
  type ConditionRoute,
  type ConditionRule,
  type DEVICE_TYPES,
  type FunnelNodeOf,
} from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { useConditionValues } from '../../api-funnels';
import { Segmented } from '../../components/ui';
import {
  changeAttr,
  changeOp,
  DEFAULT_FIELD_NAME,
  FIELD_PREFIX,
  fieldNames,
  isFieldAttr,
  operatorsFor,
  staticOptions,
  valueEditorFor,
  type ValueEditor,
  type ValueOption,
} from '../condition-ui';
import { useBuilderResources } from '../resources';
import { nextId } from '../state';
import { Field, NumberInput, selectClass } from './form-bits';
import { ValueSelect } from './value-select';

type Node = FunnelNodeOf<'condition'>;

const newRule = (): ConditionRule => ({ attr: 'country', op: 'is', values: [] });
const newGroup = (): ConditionGroup => ({ match: 'all', rules: [newRule()] });

const asOptions = (values: readonly string[]): ValueOption[] =>
  values.map((value) => ({ value, label: value }));

function ValuesEditor({
  rule,
  editor,
  draftTags,
  onChange,
}: {
  rule: ConditionRule;
  editor: ValueEditor;
  draftTags: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const { t, locale } = useI18n();
  const { tenant, siteId, sources } = useBuilderResources();
  const suggest = useConditionValues(tenant, siteId, editor.kind === 'suggest' ? editor.attr : null);
  const ctx = {
    locale,
    sources,
    deviceLabel: (d: (typeof DEVICE_TYPES)[number]) => t(`analytics.funnelBuilder.value.device.${d}`),
    archivedLabel: t('analytics.funnelBuilder.value.archived'),
  };
  const label = t('analytics.funnelBuilder.panel.values');
  switch (editor.kind) {
    case 'none':
      return null;
    case 'options':
      return (
        <ValueSelect
          ariaLabel={label}
          value={rule.values}
          onChange={onChange}
          options={staticOptions(editor.set, ctx)}
          custom={editor.custom}
          single={editor.single}
        />
      );
    case 'suggest': {
      const known = editor.attr === 'tag' ? [...new Set([...draftTags, ...(suggest.data ?? [])])] : suggest.data;
      return (
        <ValueSelect
          ariaLabel={label}
          value={rule.values}
          onChange={onChange}
          options={asOptions(known ?? [])}
          loading={suggest.isPending && known === undefined}
          maxLength={editor.attr === 'tag' ? 64 : 255}
          custom
        />
      );
    }
    case 'free':
      return (
        <ValueSelect
          ariaLabel={label}
          value={rule.values}
          onChange={onChange}
          options={[]}
          placeholder={t('analytics.funnelBuilder.value.type')}
          custom
        />
      );
    case 'number':
      return (
        <ValueSelect
          ariaLabel={label}
          value={rule.values.slice(0, 1)}
          onChange={onChange}
          options={[]}
          placeholder={t('analytics.funnelBuilder.value.number')}
          custom
          numeric
          single
        />
      );
    case 'range': {
      const options = editor.set ? staticOptions(editor.set, ctx) : [];
      const bound = (i: 0 | 1, aria: string) => (
        <ValueSelect
          ariaLabel={aria}
          value={rule.values[i] ? [rule.values[i]] : []}
          onChange={([v = '']) => {
            const next = [rule.values[0] ?? '', rule.values[1] ?? ''];
            next[i] = v;
            onChange(next);
          }}
          options={options}
          placeholder={aria}
          custom={editor.set === null}
          numeric={editor.set === null}
          single
        />
      );
      return (
        <div className="grid grid-cols-2 gap-1.5">
          {bound(0, t('analytics.funnelBuilder.value.from'))}
          {bound(1, t('analytics.funnelBuilder.value.to'))}
        </div>
      );
    }
  }
}

function RuleRow({
  rule,
  draftTags,
  onChange,
  onRemove,
}: {
  rule: ConditionRule;
  draftTags: readonly string[];
  onChange: (rule: ConditionRule) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const { sources } = useBuilderResources();
  const isField = isFieldAttr(rule.attr);
  const fields = fieldNames(sources);
  return (
    <li className="grid gap-1.5 rounded-md bg-foreground/[0.03] p-2">
      <div className="flex items-center gap-1.5">
        <select
          className={selectClass}
          aria-label={t('analytics.funnelBuilder.panel.attr')}
          value={isField ? 'field' : rule.attr}
          onChange={(e) =>
            onChange(
              changeAttr(
                rule,
                e.target.value === 'field'
                  ? `${FIELD_PREFIX}${fields[0] ?? DEFAULT_FIELD_NAME}`
                  : e.target.value,
              ),
            )
          }
        >
          {CONDITION_ATTRIBUTES.map((a) => (
            <option key={a} value={a}>
              {t(`analytics.funnelBuilder.panel.attr.${a}`)}
            </option>
          ))}
          <option value="field">{t('analytics.funnelBuilder.panel.attr.field')}</option>
        </select>
        <select
          className={selectClass}
          aria-label={t('analytics.funnelBuilder.panel.op')}
          value={rule.op}
          onChange={(e) => onChange(changeOp(rule, e.target.value as ConditionOperator))}
        >
          {operatorsFor(rule.attr, rule.op).map((o) => (
            <option key={o} value={o}>
              {t(`analytics.funnelBuilder.panel.op.${o}`)}
            </option>
          ))}
        </select>
        {onRemove ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={t('analytics.funnelBuilder.panel.removeRule')}
            onClick={onRemove}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {isField ? (
        <ValueSelect
          ariaLabel={t('analytics.funnelBuilder.panel.fieldName')}
          placeholder={t('analytics.funnelBuilder.panel.fieldName')}
          value={[rule.attr.slice(FIELD_PREFIX.length)].filter(Boolean)}
          onChange={([name = DEFAULT_FIELD_NAME]) => onChange({ ...rule, attr: `${FIELD_PREFIX}${name}` })}
          options={fields.map((name) => ({
            value: name,
            label: name,
            hint: t('analytics.funnelBuilder.value.trackingField'),
          }))}
          maxLength={64}
          custom
          single
        />
      ) : null}
      <ValuesEditor
        rule={rule}
        editor={valueEditorFor(rule.attr, rule.op)}
        draftTags={draftTags}
        onChange={(values) => onChange({ ...rule, values })}
      />
    </li>
  );
}

function GroupCard({
  group,
  draftTags,
  onChange,
  onRemove,
}: {
  group: ConditionGroup;
  draftTags: readonly string[];
  onChange: (group: ConditionGroup) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5 rounded-lg border p-2">
      <div className="flex items-center gap-2">
        <Segmented
          label={t('analytics.funnelBuilder.panel.groups')}
          options={[
            { value: 'all', label: t('analytics.funnelBuilder.panel.match.all') },
            { value: 'any', label: t('analytics.funnelBuilder.panel.match.any') },
          ]}
          value={group.match}
          onChange={(match) => onChange({ ...group, match })}
        />
        <span className="flex-1" />
        {onRemove ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('analytics.funnelBuilder.panel.removeGroup')}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      <ul className="grid gap-1.5">
        {group.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            draftTags={draftTags}
            onChange={(next) =>
              onChange({ ...group, rules: group.rules.map((r, j) => (j === i ? next : r)) })
            }
            {...(group.rules.length > 1
              ? {
                  onRemove: () =>
                    onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) }),
                }
              : {})}
          />
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 justify-self-start text-xs"
        disabled={group.rules.length >= 50}
        onClick={() => onChange({ ...group, rules: [...group.rules, newRule()] })}
      >
        <Plus className="size-3.5" aria-hidden />
        {t('analytics.funnelBuilder.panel.addRule')}
      </Button>
    </div>
  );
}

export function ConditionPanel({
  node,
  draftTags,
  onChange,
}: {
  node: Node;
  /** Tags set by the tag nodes of the draft (not saved yet, so unknown to the backend). */
  draftTags: readonly string[];
  onChange: (node: Node) => void;
}) {
  const { t } = useI18n();
  const routes = [...node.config.routes].sort((a, b) => a.priority - b.priority);
  const setRoutes = (next: ConditionRoute[]) =>
    onChange({ ...node, config: { ...node.config, routes: next } });
  const updateRoute = (id: string, patch: Partial<ConditionRoute>) =>
    setRoutes(node.config.routes.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  /** Reorders the sorted list, reusing the existing priorities (1..n when they collide). */
  const move = (from: number, to: number) => {
    const order = [...routes];
    const [item] = order.splice(from, 1);
    if (!item) return;
    order.splice(to, 0, item);
    const priorities = routes.map((r) => r.priority);
    const distinct = new Set(priorities).size === priorities.length;
    const next = new Map(order.map((r, i) => [r.id, distinct ? (priorities[i] ?? i + 1) : i + 1]));
    setRoutes(node.config.routes.map((r) => ({ ...r, priority: next.get(r.id) ?? r.priority })));
  };

  return (
    <>
      <Field label={t('analytics.funnelBuilder.panel.routes')}>
        <div className="grid gap-3">
          {routes.map((route, index) => (
            <section key={route.id} className="grid gap-2 rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-8 flex-1"
                  aria-label={t('analytics.funnelBuilder.panel.routeLabel')}
                  value={route.label}
                  onChange={(e) => updateRoute(route.id, { label: e.target.value })}
                />
                <NumberInput
                  className="w-16"
                  ariaLabel={t('analytics.funnelBuilder.panel.priority')}
                  integer
                  min={0}
                  max={1000}
                  value={route.priority}
                  onChange={(priority) => updateRoute(route.id, { priority })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('analytics.common.moveUp')}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('analytics.common.moveDown')}
                  disabled={index === routes.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('analytics.funnelBuilder.panel.removeRoute')}
                  onClick={() => setRoutes(node.config.routes.filter((r) => r.id !== route.id))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('analytics.funnelBuilder.panel.groups')}
              </p>
              {route.groups.map((group, i) => (
                <GroupCard
                  key={i}
                  group={group}
                  draftTags={draftTags}
                  onChange={(next) =>
                    updateRoute(route.id, {
                      groups: route.groups.map((g, j) => (j === i ? next : g)),
                    })
                  }
                  {...(route.groups.length > 1
                    ? {
                        onRemove: () =>
                          updateRoute(route.id, { groups: route.groups.filter((_, j) => j !== i) }),
                      }
                    : {})}
                />
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 justify-self-start text-xs"
                disabled={route.groups.length >= 20}
                onClick={() => updateRoute(route.id, { groups: [...route.groups, newGroup()] })}
              >
                <Plus className="size-3.5" aria-hidden />
                {t('analytics.funnelBuilder.panel.addGroup')}
              </Button>
            </section>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 justify-self-start text-xs"
          disabled={routes.length >= 50}
          onClick={() => {
            const id = nextId(
              'r',
              node.config.routes.map((r) => r.id),
            );
            const priority = Math.min(1000, Math.max(0, ...routes.map((r) => r.priority)) + 1);
            setRoutes([
              ...node.config.routes,
              { id, label: `Route ${id.slice(1)}`, priority, groups: [newGroup()] },
            ]);
          }}
        >
          <Plus className="size-3.5" aria-hidden />
          {t('analytics.funnelBuilder.panel.addRoute')}
        </Button>
      </Field>
      <p className="rounded-md bg-foreground/[0.04] p-2 text-[11px] text-muted-foreground">
        {t('analytics.funnelBuilder.panel.defaultRoute')}
      </p>
    </>
  );
}
