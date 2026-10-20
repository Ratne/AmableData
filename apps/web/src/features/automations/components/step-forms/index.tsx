import type { Step, StepOf } from '@amable/api-types';
import type { JSONContent } from '@amable/editor';
import { Input } from '@amable/ui/ui/input';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect, UserMultiSelect, TagMultiSelect } from '../../../crm/components/inputs';
import { clean } from '../../lib/clean';
import { AppActionForm, useAppStepLabel } from '../app-forms';
import { DurationInput, Field, NumberInput, ReferenceMultiPicker, SwitchRow } from '../form-bits';
import { CreateOrderForm } from './create-order';
import { HttpForm } from './http';
import { SendEmailForm } from './send-email';
import { SequenceTargetForm } from './sequence-target';
import { SetFieldForm } from './set-field';
import { type StepFormContext, UserRefSelect, RichText, PipelineStageFields } from './shared';
import { SignatureRequestForm } from './signature';
import { DelayForm, WaitUntilForm, FieldTimerForm } from './timing';

export type { StepFormContext } from './shared';

/** Configuration form of one sequence step. */
export function StepForm({
  step,
  onChange,
  disabled,
  ctx,
}: {
  step: Step;
  onChange: (step: Step) => void;
  disabled: boolean;
  ctx: StepFormContext;
}) {
  const { t } = useI18n();
  switch (step.type) {
    case 'delay':
      return <DelayForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'wait_until':
      return <WaitUntilForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'field_timer':
      return <FieldTimerForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'send_email':
      return <SendEmailForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'apply_tag':
    case 'remove_tag':
      return (
        <Field label={t('auto.step.tags')}>
          <TagMultiSelect
            values={step.tag_ids}
            disabled={disabled}
            placeholder={t('auto.step.tags')}
            onChange={(tag_ids) => onChange({ ...step, tag_ids })}
          />
        </Field>
      );
    case 'add_note':
      return (
        <div className="grid gap-3">
          <Field label={t('auto.step.title')}>
            <Input
              value={step.title ?? ''}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange(clean({ ...step, title: e.target.value || undefined }))}
            />
          </Field>
          <Field label={t('auto.step.body')}>
            <RichText
              stepId={step.id}
              value={step.body as JSONContent}
              disabled={disabled}
              onChange={(doc) => onChange({ ...step, body: { ...doc, type: 'doc' } })}
            />
          </Field>
        </div>
      );
    case 'create_task':
      return (
        <div className="grid gap-3">
          <Field label={t('auto.step.title')}>
            <Input
              value={step.title}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange({ ...step, title: e.target.value })}
            />
          </Field>
          <Field label={t('auto.step.dueIn')}>
            <DurationInput
              value={step.due_in ?? { amount: 1, unit: 'days' }}
              disabled={disabled}
              onChange={(due_in) => onChange({ ...step, due_in })}
            />
          </Field>
          <Field label={t('auto.step.assignTo')}>
            <UserRefSelect
              value={step.assign_to}
              disabled={disabled}
              onChange={(assign_to) => onChange(clean({ ...step, assign_to }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('auto.step.priority')}>
              <ChoiceSelect
                value={step.priority ?? ''}
                disabled={disabled}
                className="w-full"
                choices={(['low', 'normal', 'high'] as const).map((p) => ({
                  value: p,
                  label: t(`auto.priority.${p}`),
                }))}
                onChange={(p) =>
                  onChange(
                    clean({
                      ...step,
                      priority: (p || undefined) as StepOf<'create_task'>['priority'],
                    }),
                  )
                }
              />
            </Field>
            <Field label={t('auto.step.taskType')}>
              <ChoiceSelect
                value={step.task_type ?? ''}
                disabled={disabled}
                className="w-full"
                choices={(['todo', 'call', 'email', 'meeting', 'other'] as const).map((p) => ({
                  value: p,
                  label: t(`auto.taskType.${p}`),
                }))}
                onChange={(p) =>
                  onChange(
                    clean({
                      ...step,
                      task_type: (p || undefined) as StepOf<'create_task'>['task_type'],
                    }),
                  )
                }
              />
            </Field>
          </div>
        </div>
      );
    case 'create_appointment':
      return (
        <div className="grid gap-3">
          <Field label={t('auto.step.title')}>
            <Input
              value={step.title}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange({ ...step, title: e.target.value })}
            />
          </Field>
          <Field label={t('auto.step.startIn')}>
            <DurationInput
              value={step.start_in}
              disabled={disabled}
              onChange={(start_in) => onChange({ ...step, start_in })}
            />
          </Field>
          <Field label={t('auto.step.durationMinutes')}>
            <NumberInput
              value={step.duration_minutes}
              min={5}
              max={1440}
              disabled={disabled}
              onChange={(n) => onChange({ ...step, duration_minutes: Math.max(5, n ?? 30) })}
            />
          </Field>
          <Field label={t('auto.step.owner')}>
            <UserRefSelect
              value={step.owner}
              disabled={disabled}
              onChange={(owner) => onChange(clean({ ...step, owner }))}
            />
          </Field>
          <Field label={t('auto.step.location')}>
            <Input
              value={step.location ?? ''}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange(clean({ ...step, location: e.target.value || undefined }))}
            />
          </Field>
          <Field label={t('auto.step.descriptionText')}>
            <Input
              value={step.description ?? ''}
              disabled={disabled}
              className="h-8"
              onChange={(e) =>
                onChange(clean({ ...step, description: e.target.value || undefined }))
              }
            />
          </Field>
        </div>
      );
    case 'set_field':
      return <SetFieldForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'assign_owner':
      return (
        <div className="grid gap-3">
          <Field label={t('auto.step.users')}>
            <UserMultiSelect
              values={step.user_ids}
              disabled={disabled}
              onChange={(user_ids) => onChange({ ...step, user_ids })}
            />
          </Field>
          <Field label={t('auto.step.strategy')}>
            <ChoiceSelect
              value={step.strategy ?? 'fixed'}
              allowEmpty={false}
              disabled={disabled}
              className="w-full"
              choices={[
                { value: 'fixed', label: t('auto.step.strategy.fixed') },
                { value: 'round_robin', label: t('auto.step.strategy.round_robin') },
              ]}
              onChange={(s) => onChange({ ...step, strategy: s as 'fixed' | 'round_robin' })}
            />
          </Field>
        </div>
      );
    case 'create_opportunity':
      return (
        <div className="grid gap-3">
          <Field label={t('auto.step.title')}>
            <Input
              value={step.title}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange({ ...step, title: e.target.value })}
            />
          </Field>
          <PipelineStageFields
            pipelineId={step.pipeline_id}
            stageId={step.stage_id}
            required={false}
            disabled={disabled}
            onChange={(pipeline_id, stage_id) =>
              onChange(clean({ ...step, pipeline_id, stage_id }))
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('auto.step.valueMinor')}>
              <NumberInput
                value={step.value_minor}
                min={0}
                disabled={disabled}
                onChange={(n) => onChange(clean({ ...step, value_minor: n ?? undefined }))}
              />
            </Field>
            <Field label={t('auto.step.currency')}>
              <Input
                value={step.currency ?? ''}
                maxLength={3}
                disabled={disabled}
                className="h-8 uppercase"
                onChange={(e) =>
                  onChange(clean({ ...step, currency: e.target.value.toUpperCase() || undefined }))
                }
              />
            </Field>
          </div>
          <Field label={t('auto.step.owner')}>
            <UserRefSelect
              value={step.owner}
              disabled={disabled}
              onChange={(owner) => onChange(clean({ ...step, owner }))}
            />
          </Field>
        </div>
      );
    case 'move_opportunity_stage':
      return (
        <div className="grid gap-3">
          <PipelineStageFields
            pipelineId={step.pipeline_id || undefined}
            stageId={step.stage_id || undefined}
            required
            disabled={disabled}
            onChange={(pipeline_id, stage_id) =>
              onChange({ ...step, pipeline_id: pipeline_id ?? '', stage_id: stage_id ?? '' })
            }
          />
          <Field label={t('auto.step.ifNoDeal')}>
            <ChoiceSelect
              value={step.if_missing ?? 'skip'}
              allowEmpty={false}
              disabled={disabled}
              className="w-full"
              choices={[
                { value: 'skip', label: t('auto.step.ifNoDeal.skip') },
                { value: 'create', label: t('auto.step.ifNoDeal.create') },
              ]}
              onChange={(v) => onChange({ ...step, if_missing: v as 'skip' | 'create' })}
            />
          </Field>
        </div>
      );
    case 'create_order':
      return <CreateOrderForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'cancel_subscription':
      return (
        <div className="grid gap-3">
          <Field label={t('auto.step.subProducts')}>
            <ReferenceMultiPicker
              path="/products"
              values={step.product_ids ?? []}
              placeholder={t('auto.step.allSubscriptions')}
              disabled={disabled}
              onChange={(ids) =>
                onChange(clean({ ...step, product_ids: ids.length > 0 ? ids : undefined }))
              }
            />
          </Field>
          <SwitchRow
            label={t('auto.step.atPeriodEnd')}
            checked={step.at_period_end !== false}
            disabled={disabled}
            onChange={(on) => onChange({ ...step, at_period_end: on })}
          />
        </div>
      );
    case 'http_request':
      return <HttpForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'app_action':
      return <AppActionForm step={step} onChange={onChange} disabled={disabled} />;
    case 'add_to_sequence':
    case 'remove_from_sequence':
      return <SequenceTargetForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'send_signature_request':
      return <SignatureRequestForm step={step} onChange={onChange} disabled={disabled} ctx={ctx} />;
    case 'end':
      return <p className="text-xs text-muted-foreground">{t('auto.step.endHint')}</p>;
  }
}

/** One-line summary of a step for the canvas and the step list. */
export function useStepSummary(): (step: Step) => string {
  const { t } = useI18n();
  const appLabel = useAppStepLabel();
  return (step: Step) => {
    switch (step.type) {
      case 'app_action':
        return step.app_id === '' ? '' : appLabel(step.app_id, step.action_key, 'action');
      case 'delay':
        return `${step.duration.amount} ${t(`auto.unit.${step.duration.unit}`)}`;
      case 'wait_until':
        return `${step.date} ${step.time}`;
      case 'field_timer':
        return step.field;
      case 'send_email':
        return step.subject ?? step.template_id ?? '';
      case 'apply_tag':
      case 'remove_tag':
        return String(step.tag_ids.length);
      case 'http_request':
        return `${step.method} ${step.url}`;
      case 'create_task':
      case 'create_appointment':
      case 'create_opportunity':
        return step.title;
      case 'set_field':
        return `${step.field} ${step.mode === 'increment' ? '+=' : '='} ${String(step.value)}`;
      default:
        return '';
    }
  };
}
