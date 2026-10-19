import type { GoalNode, GoalTrigger, GoalTriggerType } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { useCustomFields, usePipelines } from '../../crm/api/hooks';
import { ChoiceSelect, MultiChoice, TagMultiSelect } from '../../crm/components/inputs';
import { clean } from '../lib/clean';
import { defaultTrigger, GOAL_TYPES } from '../lib/defaults';
import { AppEventTriggerForm } from './app-forms';
import type { CanvasIssue } from '../lib/issues';
import { ApiTriggerSnippet } from './api-snippet';
import {
  Field,
  NumberInput,
  ReferenceMultiPicker,
  ReferenceSelect,
  SwitchRow,
  TimeInput,
  TimeZoneSelect,
} from './form-bits';
import { IssueList } from './issue-list';

type Of<T extends GoalTriggerType> = Extract<GoalTrigger, { type: T }>;

function StageMulti({
  pipelineId,
  values,
  onChange,
  placeholder,
  disabled,
}: {
  pipelineId: string | undefined;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const pipelines = usePipelines();
  const choices = useMemo(
    () =>
      (pipelines.data ?? [])
        .filter((p) => pipelineId === undefined || p.id === pipelineId)
        .flatMap((p) =>
          p.stages.map((s) => ({
            value: s.id,
            label: pipelineId === undefined ? `${p.name} · ${s.name}` : s.name,
          })),
        ),
    [pipelines.data, pipelineId],
  );
  return (
    <MultiChoice
      values={values}
      choices={choices}
      placeholder={placeholder}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function DateFieldSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const custom = useCustomFields('contacts');
  const choices = [
    { value: 'birthday', label: t('auto.field.birthday') },
    { value: 'anniversary', label: t('auto.field.anniversary') },
    { value: 'created_at', label: t('auto.field.created_at') },
    ...custom.fields
      .filter((f) => f.type === 'DATE' || f.type === 'DATE_TIME')
      .map((f) => ({ value: `custom.${f.key}`, label: f.label })),
  ];
  return (
    <ChoiceSelect
      value={value}
      allowEmpty={false}
      disabled={disabled}
      className="w-full"
      choices={choices}
      onChange={onChange}
    />
  );
}

function TriggerFields({
  trigger,
  onChange,
  disabled,
  slug,
}: {
  trigger: GoalTrigger;
  onChange: (trigger: GoalTrigger) => void;
  disabled: boolean;
  slug: string;
}) {
  const { t } = useI18n();
  const pipelines = usePipelines();
  switch (trigger.type) {
    case 'tag_applied':
    case 'tag_removed':
      return (
        <Field label={t('auto.goal.tags')}>
          <TagMultiSelect
            values={trigger.tag_ids}
            disabled={disabled}
            placeholder={t('auto.goal.tags')}
            onChange={(tag_ids) => onChange({ ...trigger, tag_ids })}
          />
        </Field>
      );
    case 'contact_created':
      return null;
    case 'form_submitted':
      return (
        <Field label={t('auto.goal.forms')}>
          <ReferenceMultiPicker
            path="/forms"
            values={trigger.form_ids ?? []}
            placeholder={t('auto.goal.anyForm')}
            disabled={disabled}
            onChange={(ids) =>
              onChange(
                clean<Of<'form_submitted'>>({ ...trigger, form_ids: ids.length ? ids : undefined }),
              )
            }
          />
        </Field>
      );
    case 'product_purchased':
      return (
        <Field label={t('auto.goal.products')}>
          <ReferenceMultiPicker
            path="/products"
            values={trigger.product_ids ?? []}
            placeholder={t('auto.goal.anyProduct')}
            disabled={disabled}
            onChange={(ids) =>
              onChange(
                clean<Of<'product_purchased'>>({
                  ...trigger,
                  product_ids: ids.length ? ids : undefined,
                }),
              )
            }
          />
        </Field>
      );
    case 'order_paid':
      return (
        <Field label={t('auto.goal.minTotal')}>
          <NumberInput
            value={trigger.min_total_minor}
            min={0}
            disabled={disabled}
            onChange={(n) =>
              onChange(clean<Of<'order_paid'>>({ ...trigger, min_total_minor: n ?? undefined }))
            }
          />
        </Field>
      );
    case 'email_opened':
    case 'email_clicked': {
      const email = trigger.email ?? {};
      const setEmail = (next: typeof email) => {
        const compact = clean(next);
        const base = { ...trigger, email: Object.keys(compact).length > 0 ? compact : undefined };
        onChange(clean(base) as GoalTrigger);
      };
      return (
        <div className="grid gap-2">
          <Field label={t('auto.goal.emailAutomation')}>
            <ReferenceSelect
              path="/automations"
              value={email.automation_id ?? ''}
              placeholder={t('auto.goal.anyEmail')}
              disabled={disabled}
              onChange={(id) => setEmail({ ...email, automation_id: id || undefined })}
            />
          </Field>
          <Field label={t('auto.goal.emailBroadcast')}>
            <ReferenceSelect
              path="/broadcasts"
              value={email.broadcast_id ?? ''}
              placeholder={t('auto.goal.anyEmail')}
              disabled={disabled}
              onChange={(id) => setEmail({ ...email, broadcast_id: id || undefined })}
            />
          </Field>
          {trigger.type === 'email_clicked' ? (
            <Field label={t('auto.goal.urlContains')}>
              <Input
                value={trigger.url_contains ?? ''}
                disabled={disabled}
                className="h-8"
                onChange={(e) =>
                  onChange(
                    clean<Of<'email_clicked'>>({
                      ...trigger,
                      url_contains: e.target.value || undefined,
                    }),
                  )
                }
              />
            </Field>
          ) : null}
        </div>
      );
    }
    case 'lead_score':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('auto.goal.threshold')}>
            <NumberInput
              value={trigger.threshold}
              disabled={disabled}
              onChange={(n) => onChange({ ...trigger, threshold: n ?? 0 })}
            />
          </Field>
          <Field label={t('auto.goal.direction')}>
            <ChoiceSelect
              value={trigger.direction ?? 'reaches'}
              allowEmpty={false}
              disabled={disabled}
              className="w-full"
              choices={[
                { value: 'reaches', label: t('auto.goal.reaches') },
                { value: 'drops_below', label: t('auto.goal.drops_below') },
              ]}
              onChange={(direction) =>
                onChange({ ...trigger, direction: direction as 'reaches' | 'drops_below' })
              }
            />
          </Field>
        </div>
      );
    case 'api':
      return (
        <div className="grid gap-2">
          <Field label={t('auto.goal.callName')}>
            <Input
              value={trigger.call_name}
              disabled={disabled}
              className="h-8 font-mono text-xs"
              onChange={(e) =>
                onChange({ ...trigger, call_name: e.target.value.toLowerCase().trim() })
              }
            />
          </Field>
          <ApiTriggerSnippet slug={slug} callName={trigger.call_name} />
        </div>
      );
    case 'web_goal':
      return (
        <div className="grid gap-2">
          <Field label={t('auto.goal.goalName')}>
            <Input
              value={trigger.goal_name}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange({ ...trigger, goal_name: e.target.value })}
            />
          </Field>
          <Field label={t('auto.goal.site')}>
            <ReferenceSelect
              path="/sites"
              value={trigger.site_id ?? ''}
              placeholder={t('auto.goal.anySite')}
              disabled={disabled}
              onChange={(id) =>
                onChange(clean<Of<'web_goal'>>({ ...trigger, site_id: id || undefined }))
              }
            />
          </Field>
        </div>
      );
    case 'appointment_booked':
      return (
        <div className="grid gap-2">
          <Field label={t('auto.goal.eventTypes')}>
            <ReferenceMultiPicker
              path="/eventTypes"
              values={trigger.event_type_ids ?? []}
              placeholder={t('auto.goal.anyEventType')}
              disabled={disabled}
              onChange={(ids) =>
                onChange(
                  clean<Of<'appointment_booked'>>({
                    ...trigger,
                    event_type_ids: ids.length ? ids : undefined,
                  }),
                )
              }
            />
          </Field>
          <SwitchRow
            label={t('auto.goal.crmAppointments')}
            checked={trigger.include_crm_appointments === true}
            disabled={disabled}
            onChange={(on) =>
              onChange(
                clean<Of<'appointment_booked'>>({
                  ...trigger,
                  include_crm_appointments: on || undefined,
                }),
              )
            }
          />
        </div>
      );
    case 'document_completed':
    case 'document_declined':
      return (
        <Field label={t('auto.goal.signatureTemplates')}>
          <ReferenceMultiPicker
            path="/esignTemplates"
            values={trigger.template_ids ?? []}
            placeholder={t('auto.goal.anySignatureTemplate')}
            disabled={disabled}
            onChange={(ids) => onChange({ type: trigger.type, ...(ids.length > 0 ? { template_ids: ids } : {}) })}
          />
        </Field>
      );
    case 'opportunity_stage_changed':
      return (
        <div className="grid gap-2">
          <Field label={t('auto.goal.pipeline')}>
            <ChoiceSelect
              value={trigger.pipeline_id ?? ''}
              placeholder={t('auto.goal.anyPipeline')}
              disabled={disabled}
              className="w-full"
              choices={(pipelines.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              onChange={(id) =>
                onChange(
                  clean<Of<'opportunity_stage_changed'>>({
                    ...trigger,
                    pipeline_id: id || undefined,
                    to_stage_ids: undefined,
                    from_stage_ids: undefined,
                  }),
                )
              }
            />
          </Field>
          <Field label={t('auto.goal.toStages')}>
            <StageMulti
              pipelineId={trigger.pipeline_id}
              values={trigger.to_stage_ids ?? []}
              placeholder={t('auto.goal.anyStage')}
              disabled={disabled}
              onChange={(ids) =>
                onChange(
                  clean<Of<'opportunity_stage_changed'>>({
                    ...trigger,
                    to_stage_ids: ids.length ? ids : undefined,
                  }),
                )
              }
            />
          </Field>
          <Field label={t('auto.goal.fromStages')}>
            <StageMulti
              pipelineId={trigger.pipeline_id}
              values={trigger.from_stage_ids ?? []}
              placeholder={t('auto.goal.anyStage')}
              disabled={disabled}
              onChange={(ids) =>
                onChange(
                  clean<Of<'opportunity_stage_changed'>>({
                    ...trigger,
                    from_stage_ids: ids.length ? ids : undefined,
                  }),
                )
              }
            />
          </Field>
        </div>
      );
    case 'date_anniversary':
      return (
        <div className="grid gap-2">
          <Field label={t('auto.goal.field')}>
            <DateFieldSelect
              value={trigger.field}
              disabled={disabled}
              onChange={(field) => onChange({ ...trigger, field })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('auto.goal.offsetDays')}>
              <NumberInput
                value={trigger.offset_days ?? 0}
                min={-365}
                max={365}
                disabled={disabled}
                onChange={(n) => onChange({ ...trigger, offset_days: n ?? 0 })}
              />
            </Field>
            <Field label={t('auto.goal.time')}>
              <TimeInput
                value={trigger.time ?? '09:00'}
                disabled={disabled}
                onChange={(time) => onChange({ ...trigger, time })}
              />
            </Field>
          </div>
          <Field label={t('auto.goal.timeZone')}>
            <TimeZoneSelect
              value={trigger.time_zone}
              emptyLabel={t('auto.goal.tenantZone')}
              disabled={disabled}
              onChange={(zone) =>
                onChange(clean<Of<'date_anniversary'>>({ ...trigger, time_zone: zone }))
              }
            />
          </Field>
        </div>
      );
    case 'app_event':
      return <AppEventTriggerForm trigger={trigger} onChange={onChange} disabled={disabled} />;
  }
}

export function GoalPanel({
  node,
  onChange,
  disabled,
  slug,
  issues,
}: {
  node: GoalNode;
  onChange: (node: GoalNode) => void;
  disabled: boolean;
  slug: string;
  issues: readonly CanvasIssue[];
}) {
  const { t } = useI18n();
  const setTrigger = (index: number, trigger: GoalTrigger) =>
    onChange({ ...node, triggers: node.triggers.map((tr, i) => (i === index ? trigger : tr)) });
  return (
    <div className="grid gap-4">
      <IssueList issues={issues} />
      <Field label={t('auto.goal.label')}>
        <Input
          value={node.label ?? ''}
          disabled={disabled}
          className="h-8"
          onChange={(e) => onChange(clean({ ...node, label: e.target.value || undefined }))}
        />
      </Field>
      <div className="grid gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t('auto.goal.triggers')}</p>
        {node.triggers.map((trigger, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-lg border bg-card p-2.5"
            data-testid="goal-trigger"
          >
            <div className="flex items-center gap-2">
              <ChoiceSelect
                value={trigger.type}
                allowEmpty={false}
                disabled={disabled}
                className="flex-1"
                ariaLabel={t('auto.node.goal')}
                choices={GOAL_TYPES.map((type) => ({ value: type, label: t(`auto.goal.${type}`) }))}
                onChange={(type) => setTrigger(index, defaultTrigger(type as GoalTriggerType))}
              />
              {node.triggers.length > 1 && !disabled ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('auto.remove')}
                  onClick={() =>
                    onChange({ ...node, triggers: node.triggers.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
            <TriggerFields
              trigger={trigger}
              disabled={disabled}
              slug={slug}
              onChange={(next) => setTrigger(index, next)}
            />
          </div>
        ))}
        {!disabled && node.triggers.length < 10 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 justify-self-start"
            onClick={() =>
              onChange({ ...node, triggers: [...node.triggers, defaultTrigger('tag_applied')] })
            }
          >
            <Plus className="size-3.5" aria-hidden /> {t('auto.goal.addTrigger')}
          </Button>
        ) : null}
      </div>
      <Field label={t('auto.goal.accept')}>
        <ChoiceSelect
          value={node.accept ?? 'anyone'}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={[
            { value: 'anyone', label: t('auto.goal.accept.anyone') },
            { value: 'enrolled_only', label: t('auto.goal.accept.enrolled_only') },
          ]}
          onChange={(accept) => onChange({ ...node, accept: accept as 'anyone' | 'enrolled_only' })}
        />
      </Field>
    </div>
  );
}
