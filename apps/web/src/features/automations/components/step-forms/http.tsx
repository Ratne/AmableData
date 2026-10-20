import type { StepOf } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect } from '../../../crm/components/inputs';
import { clean } from '../../lib/clean';
import { Field, NumberInput, SwitchRow } from '../form-bits';
import type { FormProps } from './shared';
import { SigningInfo } from './signature';

export function HttpForm({ step, onChange, disabled, ctx }: FormProps<'http_request'>) {
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
