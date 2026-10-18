import type { GoalTrigger, Step, StepOf } from '@amable/api-types';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useI18n } from '../../../i18n';
import {
  text,
  useAppInputOptions,
  useInstalledExtensions,
  type AppInputProperty,
  type AppInputSchema,
  type AppInputSource,
  type InstalledExtensions,
} from '../../apps/api';
import { ChoiceSelect } from '../../crm/components/inputs';
import { Field, SwitchRow } from './form-bits';

/**
 * Editors of the app extension points: the `app_action` step (form generated
 * from the action's input schema) and the `app_event` goal trigger.
 */

function appChoices(apps: readonly InstalledExtensions[], has: (app: InstalledExtensions) => boolean) {
  return apps.filter(has).map((app) => ({ value: app.app_id, label: app.status === 'paused' ? `${app.name} (⏸)` : app.name }));
}

function InputField({
  name,
  property,
  required,
  value,
  onChange,
  disabled,
  source,
}: {
  name: string;
  property: AppInputProperty;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  source: AppInputSource | undefined;
}) {
  const { t, locale } = useI18n();
  const dynamic = property.options_endpoint !== undefined && source !== undefined;
  const options = useAppInputOptions(source, name, dynamic);
  const label = `${text(property.title, locale)}${required ? ' *' : ''}`;
  const hint = [
    property.description === undefined ? null : text(property.description, locale),
    property.merge_tags === true ? t('auto.app.mergeTags') : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (property.type === 'boolean') {
    return <SwitchRow label={label} checked={value === true} disabled={disabled} onChange={(on) => onChange(on)} />;
  }
  if (dynamic) {
    const current = typeof value === 'string' ? value : '';
    const list = options.data?.data ?? [];
    const choices = list.map((o) => ({ value: o.value, label: o.label }));
    // A saved value the app no longer lists stays visible (and editable away).
    if (current !== '' && !list.some((o) => o.value === current)) choices.unshift({ value: current, label: current });
    const selected = list.find((o) => o.value === current);
    const status = options.isPending
      ? t('auto.app.optionsLoading')
      : options.isError || options.data?.unavailable === true
        ? t('auto.app.optionsUnavailable')
        : list.length === 0
          ? t('auto.app.optionsEmpty')
          : null;
    return (
      <Field label={label} hint={[selected?.description, status, hint].filter(Boolean).join(' ') || undefined}>
        <ChoiceSelect
          value={current}
          allowEmpty={!required}
          disabled={disabled}
          className="w-full"
          choices={choices}
          onChange={(v) => onChange(v === '' ? undefined : v)}
        />
      </Field>
    );
  }
  if (property.enum !== undefined) {
    return (
      <Field label={label} hint={hint || undefined}>
        <ChoiceSelect
          value={typeof value === 'string' ? value : ''}
          allowEmpty={!required}
          disabled={disabled}
          className="w-full"
          choices={property.enum.map((v) => ({ value: v, label: v }))}
          onChange={(v) => onChange(v === '' ? undefined : v)}
        />
      </Field>
    );
  }
  if (property.type === 'number' || property.type === 'integer') {
    return (
      <Field label={label} hint={hint || undefined}>
        <Input
          type="number"
          className="h-8"
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          min={property.minimum}
          max={property.maximum}
          step={property.type === 'integer' ? 1 : 'any'}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </Field>
    );
  }
  const common = {
    disabled,
    value: typeof value === 'string' ? value : '',
    maxLength: property.merge_tags === true ? undefined : property.max_length,
    'aria-label': label,
  };
  return (
    <Field label={label} hint={hint || undefined}>
      {property.format === 'textarea' ? (
        <Textarea {...common} rows={4} className="text-sm" onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
      ) : (
        <Input
          {...common}
          name={name}
          type={property.format === 'email' ? 'email' : property.format === 'url' ? 'url' : 'text'}
          className="h-8"
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      )}
    </Field>
  );
}

/** Form generated from an app input schema (action inputs, connector settings). */
export function AppSchemaInputs({
  schema,
  input,
  onChange,
  disabled = false,
  source,
}: {
  schema: AppInputSchema;
  input: Readonly<Record<string, unknown>>;
  onChange: (input: Record<string, unknown>) => void;
  disabled?: boolean;
  /** The app extension the schema belongs to, for inputs with dynamic options. */
  source?: AppInputSource;
}) {
  const required = new Set(schema.required ?? []);
  return (
    <div className="grid gap-3">
      {Object.entries(schema.properties).map(([key, property]) => (
        <InputField
          key={key}
          name={key}
          property={property}
          required={required.has(key)}
          value={input[key] ?? property.default}
          disabled={disabled}
          source={source}
          onChange={(value) => {
            const next: Record<string, unknown> = { ...input };
            if (value === undefined) delete next[key];
            else next[key] = value;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

export function AppActionForm({
  step,
  onChange,
  disabled,
}: {
  step: StepOf<'app_action'>;
  onChange: (step: Step) => void;
  disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const installed = useInstalledExtensions();
  const apps = installed.data?.data ?? [];
  const app = apps.find((a) => a.app_id === step.app_id);
  const actions = app?.extensions.automation_actions ?? [];
  const action = actions.find((a) => a.key === step.action_key);
  if (!installed.isPending && apps.every((a) => (a.extensions.automation_actions ?? []).length === 0)) {
    return <p className="text-xs text-muted-foreground">{t('auto.app.noApps')}</p>;
  }
  return (
    <div className="grid gap-3">
      <Field label={t('auto.app.app')}>
        <ChoiceSelect
          value={step.app_id}
          allowEmpty={false}
          placeholder={t('auto.app.pickApp')}
          disabled={disabled}
          className="w-full"
          choices={appChoices(apps, (a) => (a.extensions.automation_actions ?? []).length > 0)}
          onChange={(appId) => onChange({ ...step, app_id: appId, action_key: '', input: {} })}
        />
      </Field>
      {app !== undefined ? (
        <Field label={t('auto.app.action')} hint={action?.description === undefined ? undefined : text(action.description, locale)}>
          <ChoiceSelect
            value={step.action_key}
            allowEmpty={false}
            placeholder={t('auto.app.pickAction')}
            disabled={disabled}
            className="w-full"
            choices={actions.map((a) => ({ value: a.key, label: text(a.name, locale) }))}
            onChange={(key) => onChange({ ...step, action_key: key, input: {} })}
          />
        </Field>
      ) : step.app_id !== '' && !installed.isPending ? (
        <p className="text-xs text-destructive">{t('auto.app.notInstalled', { app: step.app_id })}</p>
      ) : null}
      {app?.status === 'paused' ? <p className="text-xs text-muted-foreground">{t('auto.app.paused')}</p> : null}
      {action !== undefined ? (
        <AppSchemaInputs
          schema={action.input_schema}
          input={step.input}
          disabled={disabled}
          source={{ appId: step.app_id, kind: 'action', key: action.key }}
          onChange={(input) => onChange({ ...step, input })}
        />
      ) : null}
      {action?.output_keys !== undefined && action.output_keys.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('auto.app.outputs', { keys: action.output_keys.join(', ') })}</p>
      ) : null}
    </div>
  );
}

export function AppEventTriggerForm({
  trigger,
  onChange,
  disabled,
}: {
  trigger: Extract<GoalTrigger, { type: 'app_event' }>;
  onChange: (trigger: GoalTrigger) => void;
  disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const installed = useInstalledExtensions();
  const apps = installed.data?.data ?? [];
  const app = apps.find((a) => a.app_id === trigger.app_id);
  const triggers = app?.extensions.automation_triggers ?? [];
  const selected = triggers.find((tr) => tr.key === trigger.key);
  if (!installed.isPending && apps.every((a) => (a.extensions.automation_triggers ?? []).length === 0)) {
    return <p className="text-xs text-muted-foreground">{t('auto.app.noTriggers')}</p>;
  }
  return (
    <div className="grid gap-3">
      <Field label={t('auto.app.app')}>
        <ChoiceSelect
          value={trigger.app_id}
          allowEmpty={false}
          placeholder={t('auto.app.pickApp')}
          disabled={disabled}
          className="w-full"
          choices={appChoices(apps, (a) => (a.extensions.automation_triggers ?? []).length > 0)}
          onChange={(appId) => onChange({ ...trigger, app_id: appId, key: '' })}
        />
      </Field>
      {app !== undefined ? (
        <Field label={t('auto.app.trigger')} hint={selected?.description === undefined ? undefined : text(selected.description, locale)}>
          <ChoiceSelect
            value={trigger.key}
            allowEmpty={false}
            placeholder={t('auto.app.pickTrigger')}
            disabled={disabled}
            className="w-full"
            choices={triggers.map((tr) => ({ value: tr.key, label: text(tr.name, locale) }))}
            onChange={(key) => onChange({ ...trigger, key })}
          />
        </Field>
      ) : trigger.app_id !== '' && !installed.isPending ? (
        <p className="text-xs text-destructive">{t('auto.app.notInstalled', { app: trigger.app_id })}</p>
      ) : null}
    </div>
  );
}

/** "App name · Action name" for the canvas summary; ids while the app list loads. */
export function useAppStepLabel(): (appId: string, key: string, kind: 'action' | 'trigger') => string {
  const { locale } = useI18n();
  const installed = useInstalledExtensions();
  return (appId, key, kind) => {
    const app = installed.data?.data.find((a) => a.app_id === appId);
    const list = kind === 'action' ? app?.extensions.automation_actions : app?.extensions.automation_triggers;
    const item = list?.find((a) => a.key === key);
    return `${app?.name ?? appId}${key === '' ? '' : ` · ${item === undefined ? key : text(item.name, locale)}`}`;
  };
}
