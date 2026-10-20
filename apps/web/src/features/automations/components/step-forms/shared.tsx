import type { Step, StepOf, UserRef } from '@amable/api-types';
import { AmableEditor, type JSONContent } from '@amable/editor';
import { useMemo } from 'react';
import { useI18n } from '../../../../i18n';
import { editorLabels } from '../../../../lib/labels';
import { usePipelines } from '../../../crm/api/hooks';
import { ChoiceSelect, UserSelect } from '../../../crm/components/inputs';
import { Field } from '../form-bits';

export interface StepFormContext {
  readonly slug: string;
  readonly automationId: string;
  /** Sequences of the automation being edited (for add/remove-from-sequence). */
  readonly sequences: ReadonlyArray<{ id: string; label: string }>;
  readonly canPublish: boolean;
}

export interface FormProps<T extends Step['type']> {
  step: StepOf<T>;
  onChange: (step: Step) => void;
  disabled: boolean;
  ctx: StepFormContext;
}

export const DEFAULT_WINDOW = { start: '09:00', end: '18:00' } as const;

export function UserRefSelect({
  value,
  onChange,
  disabled,
}: {
  value: UserRef | undefined;
  onChange: (value: UserRef | undefined) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const mode = value === undefined ? '' : value === 'contact_owner' ? 'contact_owner' : 'user';
  return (
    <div className="grid gap-1.5">
      <ChoiceSelect
        value={mode}
        disabled={disabled}
        className="w-full"
        choices={[
          { value: 'contact_owner', label: t('auto.step.contactOwner') },
          { value: 'user', label: t('auto.step.users') },
        ]}
        onChange={(next) =>
          onChange(
            next === '' ? undefined : next === 'contact_owner' ? 'contact_owner' : { user_id: '' },
          )
        }
      />
      {typeof value === 'object' ? (
        <UserSelect
          value={value.user_id}
          disabled={disabled}
          onChange={(user_id) => onChange({ user_id })}
        />
      ) : null}
    </div>
  );
}

export function RichText({
  value,
  onChange,
  disabled,
  stepId,
}: {
  value: JSONContent | undefined;
  onChange: (doc: JSONContent) => void;
  disabled: boolean;
  stepId: string;
}) {
  const { t } = useI18n();
  const labels = useMemo(() => editorLabels(t), [t]);
  return (
    <div className="rounded-md border">
      <AmableEditor
        key={stepId}
        mode="rich"
        toolbar="compact"
        value={value ?? null}
        editable={!disabled}
        labels={labels}
        onChange={onChange}
        className="min-h-24"
      />
    </div>
  );
}

export function PipelineStageFields({
  pipelineId,
  stageId,
  onChange,
  disabled,
  required,
}: {
  pipelineId: string | undefined;
  stageId: string | undefined;
  onChange: (pipelineId: string | undefined, stageId: string | undefined) => void;
  disabled: boolean;
  required: boolean;
}) {
  const { t } = useI18n();
  const pipelines = usePipelines();
  const pipeline = (pipelines.data ?? []).find((p) => p.id === pipelineId);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={t('auto.goal.pipeline')}>
        <ChoiceSelect
          value={pipelineId ?? ''}
          allowEmpty={!required}
          disabled={disabled}
          className="w-full"
          choices={(pipelines.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => onChange(id || undefined, undefined)}
        />
      </Field>
      <Field label={t('auto.step.stage')}>
        <ChoiceSelect
          value={stageId ?? ''}
          allowEmpty={!required}
          disabled={disabled || pipeline === undefined}
          className="w-full"
          choices={(pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
          onChange={(id) => onChange(pipelineId, id || undefined)}
        />
      </Field>
    </div>
  );
}
