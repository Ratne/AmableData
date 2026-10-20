import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect } from '../../../crm/components/inputs';
import { automationKeys, useAutomationApi, useAutomations } from '../../api/hooks';
import { clean } from '../../lib/clean';
import { Field } from '../form-bits';
import type { FormProps } from './shared';

export function SequenceTargetForm({
  step,
  onChange,
  disabled,
  ctx,
}: FormProps<'add_to_sequence' | 'remove_from_sequence'>) {
  const { t } = useI18n();
  const { api, slug } = useAutomationApi();
  const automations = useAutomations('all');
  const own = step.automation_id === '' || step.automation_id === ctx.automationId;
  const other = useQuery({
    queryKey: automationKeys.detail(slug, step.automation_id),
    queryFn: () => api.get(step.automation_id),
    enabled: !own,
  });
  const sequences = own
    ? ctx.sequences
    : (other.data?.draft_graph.nodes ?? [])
        .filter((n) => n.type === 'sequence')
        .map((n) => ({ id: n.id, label: n.label ?? n.id }));
  const automationChoices = [
    { value: ctx.automationId, label: t('auto.step.thisAutomation') },
    ...(automations.data ?? [])
      .filter((a) => a.id !== ctx.automationId)
      .map((a) => ({ value: a.id, label: a.name })),
  ];
  return (
    <div className="grid gap-3">
      <Field label={t('auto.step.automation')}>
        <ChoiceSelect
          value={step.automation_id === '' ? ctx.automationId : step.automation_id}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={automationChoices}
          onChange={(automation_id) =>
            step.type === 'add_to_sequence'
              ? onChange({ ...step, automation_id, node_id: '' })
              : onChange(clean({ ...step, automation_id, node_id: undefined }))
          }
        />
      </Field>
      <Field label={t('auto.step.node')}>
        <ChoiceSelect
          value={step.node_id ?? ''}
          allowEmpty={step.type === 'remove_from_sequence'}
          placeholder={
            step.type === 'remove_from_sequence' ? t('auto.step.wholeAutomation') : undefined
          }
          disabled={disabled}
          className="w-full"
          choices={sequences.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(node_id) =>
            step.type === 'add_to_sequence'
              ? onChange({
                  ...step,
                  automation_id: step.automation_id || ctx.automationId,
                  node_id,
                })
              : onChange(
                  clean({
                    ...step,
                    automation_id: step.automation_id || ctx.automationId,
                    node_id: node_id || undefined,
                  }),
                )
          }
        />
      </Field>
    </div>
  );
}
