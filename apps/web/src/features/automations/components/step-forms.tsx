import { SETTABLE_CONTACT_FIELDS, type Step, type StepOf, type UserRef } from '@amable/api-types';
import { AmableEditor, type JSONContent } from '@amable/editor';
import { toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Mail, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { editorLabels } from '../../../lib/labels';
import { useCustomFields, usePipelines } from '../../crm/api/hooks';
import {
  ChoiceSelect,
  DatePicker,
  UserMultiSelect,
  UserSelect,
  TagMultiSelect,
} from '../../crm/components/inputs';
import { STANDARD_FIELD_LABELS } from '../../crm/field-catalog';
import { useTemplates } from '../../esign/api/hooks';
import {
  automationKeys,
  useAutomationApi,
  useAutomationMutation,
  useAutomations,
  useReferences,
} from '../api/hooks';
import { clean } from '../lib/clean';
import { SendingDomainBanner, useStepUp } from '../../developers/components';
import { CopyBlock } from './api-snippet';
import { AppActionForm, useAppStepLabel } from './app-forms';
import { EmailDialog } from './email-dialog';
import {
  DurationInput,
  Field,
  NumberInput,
  ReferenceMultiPicker,
  ReferenceSelect,
  SendWindowEditor,
  SwitchRow,
  TimeInput,
  TimeZoneSelect,
} from './form-bits';
import { DateFieldSelect } from './goal-panel';

export interface StepFormContext {
  readonly slug: string;
  readonly automationId: string;
  /** Sequences of the automation being edited (for add/remove-from-sequence). */
  readonly sequences: ReadonlyArray<{ id: string; label: string }>;
  readonly canPublish: boolean;
}

interface FormProps<T extends Step['type']> {
  step: StepOf<T>;
  onChange: (step: Step) => void;
  disabled: boolean;
  ctx: StepFormContext;
}

const DEFAULT_WINDOW = { start: '09:00', end: '18:00' } as const;

function UserRefSelect({
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

function RichText({
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

function DelayForm({ step, onChange, disabled }: FormProps<'delay'>) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <DurationInput
        value={step.duration}
        disabled={disabled}
        onChange={(duration) => onChange({ ...step, duration })}
      />
      <SwitchRow
        label={t('auto.step.window')}
        checked={step.window !== undefined}
        disabled={disabled}
        onChange={(on) =>
          onChange(clean({ ...step, window: on ? { ...DEFAULT_WINDOW } : undefined }))
        }
      />
      {step.window ? (
        <SendWindowEditor
          value={step.window}
          disabled={disabled}
          onChange={(window) => onChange({ ...step, window })}
        />
      ) : null}
    </div>
  );
}

function WaitUntilForm({ step, onChange, disabled }: FormProps<'wait_until'>) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('auto.step.date')}>
          <DatePicker
            value={step.date}
            disabled={disabled}
            onChange={(date) => onChange({ ...step, date })}
          />
        </Field>
        <Field label={t('auto.step.time')}>
          <TimeInput
            value={step.time}
            disabled={disabled}
            onChange={(time) => onChange({ ...step, time })}
          />
        </Field>
      </div>
      <Field label={t('auto.step.timeZone')}>
        <TimeZoneSelect
          value={step.time_zone}
          emptyLabel={t('auto.step.contactZone')}
          disabled={disabled}
          onChange={(time_zone) => onChange(clean({ ...step, time_zone }))}
        />
      </Field>
    </div>
  );
}

function FieldTimerForm({ step, onChange, disabled }: FormProps<'field_timer'>) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <Field label={t('auto.step.field')}>
        <DateFieldSelect
          value={step.field}
          disabled={disabled}
          onChange={(field) => onChange({ ...step, field })}
        />
      </Field>
      <SwitchRow
        label={t('auto.step.offset')}
        checked={step.offset !== undefined}
        disabled={disabled}
        onChange={(on) =>
          onChange(
            clean({
              ...step,
              offset: on
                ? { amount: 1, unit: 'days' as const, direction: 'before' as const }
                : undefined,
            }),
          )
        }
      />
      {step.offset ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <DurationInput
            value={{ amount: step.offset.amount, unit: step.offset.unit }}
            disabled={disabled}
            onChange={(d) => step.offset && onChange({ ...step, offset: { ...step.offset, ...d } })}
          />
          <ChoiceSelect
            value={step.offset.direction}
            allowEmpty={false}
            disabled={disabled}
            className="w-28"
            choices={[
              { value: 'before', label: t('auto.step.before') },
              { value: 'after', label: t('auto.step.after') },
            ]}
            onChange={(direction) =>
              step.offset &&
              onChange({
                ...step,
                offset: { ...step.offset, direction: direction as 'before' | 'after' },
              })
            }
          />
        </div>
      ) : null}
      <Field label={t('auto.step.time')}>
        <TimeInput
          value={step.time ?? '09:00'}
          disabled={disabled}
          onChange={(time) => onChange({ ...step, time })}
        />
      </Field>
      <SwitchRow
        label={t('auto.step.yearly')}
        checked={step.yearly === true}
        disabled={disabled}
        onChange={(yearly) => onChange(clean({ ...step, yearly: yearly || undefined }))}
      />
      <Field label={t('auto.step.ifMissing')}>
        <ChoiceSelect
          value={step.if_missing ?? 'skip'}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={[
            { value: 'skip', label: t('auto.step.ifMissing.skip') },
            { value: 'stop', label: t('auto.step.ifMissing.stop') },
          ]}
          onChange={(v) => onChange({ ...step, if_missing: v as 'skip' | 'stop' })}
        />
      </Field>
      <Field label={t('auto.step.timeZone')}>
        <TimeZoneSelect
          value={step.time_zone}
          emptyLabel={t('auto.step.contactZone')}
          disabled={disabled}
          onChange={(time_zone) => onChange(clean({ ...step, time_zone }))}
        />
      </Field>
    </div>
  );
}

function SendEmailForm({ step, onChange, disabled }: FormProps<'send_email'>) {
  const { t } = useI18n();
  const { slug } = useAutomationApi();
  const [editing, setEditing] = useState(false);
  const source = step.template_id !== undefined ? 'template' : 'inline';
  return (
    <div className="grid gap-3">
      <SendingDomainBanner slug={slug} compact />
      <ChoiceSelect
        value={source}
        allowEmpty={false}
        disabled={disabled}
        className="w-full"
        choices={[
          { value: 'inline', label: t('auto.step.inline') },
          { value: 'template', label: t('auto.step.template') },
        ]}
        onChange={(next) => {
          if (next === 'template') {
            const { body: _b, ...rest } = step;
            onChange({ ...rest, template_id: '' });
          } else {
            const { template_id: _t, ...rest } = step;
            onChange({
              ...rest,
              body: rest.body ?? { type: 'doc', content: [{ type: 'paragraph' }] },
            });
          }
        }}
      />
      {source === 'template' ? (
        <Field label={t('auto.step.template')}>
          <ReferenceSelect
            path="/emailTemplates"
            value={step.template_id ?? ''}
            allowEmpty={false}
            disabled={disabled}
            onChange={(template_id) => onChange({ ...step, template_id })}
          />
        </Field>
      ) : (
        <>
          <Field label={t('auto.step.subject')}>
            <Input
              value={step.subject ?? ''}
              disabled={disabled}
              className="h-8"
              onChange={(e) => onChange(clean({ ...step, subject: e.target.value || undefined }))}
            />
          </Field>
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => setEditing(true)}
          >
            <Mail className="size-3.5" aria-hidden /> {t('auto.step.editEmail')}
          </Button>
          {editing ? (
            <EmailDialog
              step={step}
              open={editing}
              onOpenChange={setEditing}
              onSave={onChange}
              disabled={disabled}
            />
          ) : null}
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('auto.step.fromName')}>
          <Input
            value={step.from_name ?? ''}
            disabled={disabled}
            className="h-8"
            onChange={(e) => onChange(clean({ ...step, from_name: e.target.value || undefined }))}
          />
        </Field>
        <Field label={t('auto.step.replyTo')}>
          <Input
            type="email"
            value={step.reply_to ?? ''}
            disabled={disabled}
            className="h-8"
            onChange={(e) =>
              onChange(clean({ ...step, reply_to: e.target.value.trim() || undefined }))
            }
          />
        </Field>
      </div>
      <SwitchRow
        label={t('auto.step.window')}
        checked={step.window !== undefined}
        disabled={disabled}
        onChange={(on) =>
          onChange(clean({ ...step, window: on ? { ...DEFAULT_WINDOW } : undefined }))
        }
      />
      {step.window ? (
        <SendWindowEditor
          value={step.window}
          disabled={disabled}
          onChange={(window) => onChange({ ...step, window })}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">{t('auto.step.useDefaultWindow')}</p>
      )}
    </div>
  );
}

function SetFieldForm({ step, onChange, disabled }: FormProps<'set_field'>) {
  const { t } = useI18n();
  const custom = useCustomFields('contacts');
  const choices = [
    ...SETTABLE_CONTACT_FIELDS.map((field) => {
      const key = STANDARD_FIELD_LABELS[field];
      return { value: field, label: key ? t(key) : field };
    }),
    ...custom.fields.map((f) => ({ value: `custom.${f.key}`, label: f.label })),
  ];
  const increment = step.mode === 'increment';
  return (
    <div className="grid gap-3">
      <Field label={t('auto.step.field')}>
        <ChoiceSelect
          value={step.field}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={choices}
          onChange={(field) => onChange({ ...step, field })}
        />
      </Field>
      <Field label={t('auto.step.mode')}>
        <ChoiceSelect
          value={step.mode ?? 'set'}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={[
            { value: 'set', label: t('auto.step.mode.set') },
            { value: 'increment', label: t('auto.step.mode.increment') },
          ]}
          onChange={(mode) =>
            onChange({
              ...step,
              mode: mode as 'set' | 'increment',
              value: mode === 'increment' ? Number(step.value) || 0 : step.value,
            })
          }
        />
      </Field>
      <Field label={t('auto.step.value')}>
        {increment || step.field === 'score_value' ? (
          <NumberInput
            value={typeof step.value === 'number' ? step.value : Number(step.value) || 0}
            disabled={disabled}
            onChange={(n) => onChange({ ...step, value: n ?? 0 })}
          />
        ) : (
          <Input
            value={step.value === null ? '' : String(step.value)}
            disabled={disabled || step.value === null}
            className="h-8"
            onChange={(e) => onChange({ ...step, value: e.target.value })}
          />
        )}
      </Field>
      {!increment ? (
        <SwitchRow
          label={t('auto.step.clear')}
          checked={step.value === null}
          disabled={disabled}
          onChange={(on) => onChange({ ...step, value: on ? null : '' })}
        />
      ) : null}
    </div>
  );
}

function PipelineStageFields({
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

function SignatureRequestForm({ step, onChange, disabled }: FormProps<'send_signature_request'>) {
  const { t } = useI18n();
  const templates = useTemplates();
  const list = (templates.data ?? []).filter((tpl) => tpl.status !== 'archived' || tpl.id === step.template_id);
  const template = list.find((tpl) => tpl.id === step.template_id);
  const contactParty = step.party_id ?? template?.parties[0]?.id;
  const others = template?.parties.filter((p) => p.id !== contactParty) ?? [];
  const otherOf = (partyId: string) => step.others?.find((o) => o.party_id === partyId);
  const setOther = (partyId: string, patch: { email?: string; name?: string }) => {
    const current = otherOf(partyId) ?? { party_id: partyId, email: '' };
    const next = { ...current, ...patch };
    const updated = [
      ...(step.others ?? []).filter((o) => o.party_id !== partyId),
      clean({ ...next, name: next.name?.trim() ? next.name : undefined }),
    ].filter((o) => others.some((p) => p.id === o.party_id));
    onChange(clean({ ...step, others: updated.length > 0 ? updated : undefined }));
  };
  return (
    <div className="grid gap-3">
      <p className="text-[11px] text-muted-foreground">{t('auto.step.signatureHint')}</p>
      <Field label={t('auto.step.signatureTemplate')}>
        <ChoiceSelect
          value={step.template_id}
          allowEmpty={false}
          placeholder={t('auto.step.pickSignatureTemplate')}
          disabled={disabled}
          className="w-full"
          choices={list.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
          invalid={step.template_id === ''}
          onChange={(template_id) => onChange(clean({ ...step, template_id, party_id: undefined, others: undefined }))}
        />
      </Field>
      {template !== undefined && !(template.status === 'active' && template.ready) ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('auto.step.signatureInactive')}</p>
      ) : null}
      {template !== undefined && template.parties.length > 1 ? (
        <Field label={t('auto.step.signatureParty')}>
          <ChoiceSelect
            value={contactParty ?? ''}
            allowEmpty={false}
            disabled={disabled}
            className="w-full"
            choices={template.parties.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(party_id) => onChange(clean({ ...step, party_id, others: step.others?.filter((o) => o.party_id !== party_id) }))}
          />
        </Field>
      ) : null}
      {others.map((party) => {
        const other = otherOf(party.id);
        return (
          <Field key={party.id} label={t('auto.step.signatureOther', { party: party.name })}>
            <div className="grid gap-1.5">
              <Input
                type="email"
                value={other?.email ?? ''}
                placeholder={t('auto.step.signatureOtherEmail')}
                disabled={disabled}
                className="h-8"
                aria-invalid={other === undefined || other.email === ''}
                onChange={(e) => setOther(party.id, { email: e.target.value.trim() })}
              />
              <Input
                value={other?.name ?? ''}
                placeholder={t('auto.step.signatureOtherName')}
                disabled={disabled}
                className="h-8"
                onChange={(e) => setOther(party.id, { name: e.target.value })}
              />
            </div>
          </Field>
        );
      })}
      <Field label={t('auto.step.signatureMessage')}>
        <Textarea
          rows={3}
          value={step.message ?? ''}
          maxLength={5000}
          placeholder={t('auto.step.signatureMessageHint')}
          disabled={disabled}
          onChange={(e) => onChange(clean({ ...step, message: e.target.value || undefined }))}
        />
      </Field>
    </div>
  );
}

function CreateOrderForm({ step, onChange, disabled }: FormProps<'create_order'>) {
  const { t } = useI18n();
  const products = useReferences('/products');
  const choices = (products.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const setItem = (index: number, item: StepOf<'create_order'>['items'][number]) =>
    onChange({ ...step, items: step.items.map((it, i) => (i === index ? item : it)) });
  return (
    <div className="grid gap-3">
      <p className="text-[11px] text-muted-foreground">{t('auto.step.orderHint')}</p>
      <p className="text-xs font-medium text-muted-foreground">{t('auto.step.items')}</p>
      {step.items.map((item, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            {products.data === null || products.isError ? (
              <Input
                value={item.product_id}
                placeholder={t('auto.step.product')}
                disabled={disabled}
                className="h-8"
                onChange={(e) => setItem(index, { ...item, product_id: e.target.value.trim() })}
              />
            ) : (
              <ChoiceSelect
                value={item.product_id}
                allowEmpty={false}
                disabled={disabled}
                className="flex-1"
                ariaLabel={t('auto.step.product')}
                choices={choices}
                onChange={(product_id) => setItem(index, { ...item, product_id })}
              />
            )}
            {!disabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('auto.remove')}
                onClick={() =>
                  onChange({ ...step, items: step.items.filter((_, i) => i !== index) })
                }
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('auto.step.quantity')}>
              <NumberInput
                value={item.quantity}
                min={1}
                disabled={disabled}
                onChange={(n) => setItem(index, { ...item, quantity: Math.max(1, n ?? 1) })}
              />
            </Field>
            <Field label={t('auto.step.unitPrice')}>
              <NumberInput
                value={item.unit_price_minor}
                min={0}
                disabled={disabled}
                onChange={(n) =>
                  setItem(index, clean({ ...item, unit_price_minor: n ?? undefined }))
                }
              />
            </Field>
          </div>
        </div>
      ))}
      {!disabled ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 justify-self-start"
          onClick={() =>
            onChange({
              ...step,
              items: [...step.items, { product_id: choices[0]?.value ?? '', quantity: 1 }],
            })
          }
        >
          <Plus className="size-3.5" aria-hidden /> {t('auto.step.addItem')}
        </Button>
      ) : null}
      <Field label={t('auto.step.currency')}>
        <Input
          value={step.currency ?? ''}
          maxLength={3}
          disabled={disabled}
          className="h-8 w-24 uppercase"
          onChange={(e) =>
            onChange(clean({ ...step, currency: e.target.value.toUpperCase() || undefined }))
          }
        />
      </Field>
    </div>
  );
}

function SigningInfo({ ctx }: { ctx: StepFormContext }) {
  const { t } = useI18n();
  const { api } = useAutomationApi();
  const [secret, setSecret] = useState<string | null>(null);
  const { guard, dialog: stepUpDialog } = useStepUp();
  const reveal = useAutomationMutation({
    mutationFn: () => api.signingSecret(ctx.automationId),
    invalidate: [],
    onSuccess: (result) => setSecret(result.secret),
    onError: (error) => guard(error, () => reveal.mutate(undefined)),
  });
  const rotate = useAutomationMutation({
    mutationFn: () => api.rotateSigningSecret(ctx.automationId),
    invalidate: [],
    success: t('auto.step.rotated'),
    onSuccess: (result) => setSecret((current) => (current === null ? null : result.secret)),
    onError: (error) => guard(error, () => rotate.mutate(undefined)),
  });
  return (
    <div className="grid gap-2 rounded-md border bg-muted/30 p-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound className="size-3.5" aria-hidden /> {t('auto.step.signingTitle')}
      </p>
      <p className="text-[11px] leading-snug text-muted-foreground">{t('auto.step.signingBody')}</p>
      {ctx.canPublish ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={reveal.isPending}
            onClick={() => (secret === null ? reveal.mutate(undefined) : setSecret(null))}
          >
            {t('auto.step.showSecret')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate(undefined)}
          >
            <RefreshCw className="size-3.5" aria-hidden /> {t('auto.step.rotateSecret')}
          </Button>
        </div>
      ) : null}
      {secret !== null ? <CopyBlock text={secret} /> : null}
      {stepUpDialog}
    </div>
  );
}

function HttpForm({ step, onChange, disabled, ctx }: FormProps<'http_request'>) {
  const { t } = useI18n();
  const headers = Object.entries(step.headers ?? {});
  const setHeaders = (entries: Array<[string, string]>) =>
    onChange(
      clean({ ...step, headers: entries.length > 0 ? Object.fromEntries(entries) : undefined }),
    );
  return (
    <div className="grid gap-3">
      <div className="flex gap-1.5">
        <ChoiceSelect
          value={step.method}
          allowEmpty={false}
          disabled={disabled}
          className="w-28 min-w-0"
          ariaLabel={t('auto.step.method')}
          choices={(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => ({
            value: m,
            label: m,
          }))}
          onChange={(method) =>
            onChange({ ...step, method: method as StepOf<'http_request'>['method'] })
          }
        />
        <Input
          value={step.url}
          disabled={disabled}
          aria-label={t('auto.step.url')}
          className="h-8 font-mono text-xs"
          onChange={(e) => onChange({ ...step, url: e.target.value.trim() })}
        />
      </div>
      <div className="grid gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t('auto.step.headers')}</p>
        {headers.map(([name, value], index) => (
          <div key={index} className="flex gap-1.5">
            <Input
              value={name}
              placeholder={t('auto.step.headerName')}
              disabled={disabled}
              className="h-8 w-36 font-mono text-xs"
              onChange={(e) =>
                setHeaders(headers.map((h, i) => (i === index ? [e.target.value, h[1]] : h)))
              }
            />
            <Input
              value={value}
              placeholder={t('auto.step.headerValue')}
              disabled={disabled}
              className="h-8 font-mono text-xs"
              onChange={(e) =>
                setHeaders(headers.map((h, i) => (i === index ? [h[0], e.target.value] : h)))
              }
            />
            {!disabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('auto.remove')}
                onClick={() => setHeaders(headers.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        {!disabled ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 justify-self-start"
            onClick={() => setHeaders([...headers, [`X-Header-${headers.length + 1}`, '']])}
          >
            <Plus className="size-3.5" aria-hidden /> {t('auto.step.addHeader')}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('auto.step.payload')}>
          <ChoiceSelect
            value={step.payload ?? (step.method === 'GET' ? 'none' : 'contact')}
            allowEmpty={false}
            disabled={disabled}
            className="w-full"
            choices={(['contact', 'minimal', 'none'] as const).map((p) => ({
              value: p,
              label: t(`auto.step.payload.${p}`),
            }))}
            onChange={(payload) =>
              onChange({ ...step, payload: payload as 'contact' | 'minimal' | 'none' })
            }
          />
        </Field>
        <Field label={t('auto.step.timeout')}>
          <NumberInput
            value={step.timeout_ms ?? 10_000}
            min={500}
            max={30_000}
            disabled={disabled}
            onChange={(n) => onChange(clean({ ...step, timeout_ms: n ?? undefined }))}
          />
        </Field>
      </div>
      <SwitchRow
        label={t('auto.step.sign')}
        checked={step.sign !== false}
        disabled={disabled}
        onChange={(on) => onChange(clean({ ...step, sign: on ? undefined : false }))}
      />
      {step.sign !== false ? <SigningInfo ctx={ctx} /> : null}
    </div>
  );
}

function SequenceTargetForm({
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
