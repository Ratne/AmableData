import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect } from '../../../crm/components/inputs';
import { useAutomationApi } from '../../api/hooks';
import { clean } from '../../lib/clean';
import { SendingDomainBanner } from '../../../developers/components';
import { EmailDialog } from '../email-dialog';
import { Field, ReferenceSelect, SendWindowEditor, SwitchRow } from '../form-bits';
import { DEFAULT_WINDOW, type FormProps } from './shared';

export function SendEmailForm({ step, onChange, disabled }: FormProps<'send_email'>) {
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
