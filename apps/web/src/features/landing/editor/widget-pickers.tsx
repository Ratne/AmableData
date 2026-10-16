import { Input } from '@amable/ui/ui/input';
import { Spinner } from '@amable/ui/ui/spinner';
import { useI18n } from '../../../i18n';
import { useEventTypeOptions, useFormOptions } from '../api/hooks';
import { Choice } from '../components/common';

/** `form` widget: pick one of the tenant's forms (GET /forms). */
export function FormPicker({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const forms = useFormOptions();
  if (forms.isPending) return <Spinner />;
  if (forms.isError) {
    return (
      <div className="grid gap-1">
        <Input className="h-8 text-xs" value={value} disabled={disabled} placeholder={t('landing.editor.formIdPlaceholder')} onChange={(e) => onChange(e.target.value.trim())} />
        <p className="text-[11px] text-muted-foreground">{t('landing.editor.formsUnavailable')}</p>
      </div>
    );
  }
  const options = forms.data.map((f) => ({ value: f.id, label: f.name }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: t('landing.editor.missingForm', { id: value }) });
  if (options.length === 0) return <p className="text-xs text-muted-foreground">{t('landing.editor.noForms')}</p>;
  return (
    <Choice
      className="h-8 text-xs"
      value={value || null}
      noneLabel={t('landing.editor.chooseForm')}
      options={options}
      disabled={disabled}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}

/** `booking` widget: pick an event type; a manual slug input when the booking API is not available. */
export function EventTypePicker({ value, onChange, disabled }: { value: string; onChange: (slug: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const eventTypes = useEventTypeOptions();
  if (eventTypes.isPending) return <Spinner />;
  if (eventTypes.isError || eventTypes.data === null) {
    return (
      <div className="grid gap-1">
        <Input
          className="h-8 font-mono text-xs"
          value={value}
          disabled={disabled}
          placeholder={t('landing.editor.eventSlugPlaceholder')}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <p className="text-[11px] text-muted-foreground">{t('landing.editor.bookingUnavailable')}</p>
      </div>
    );
  }
  const options = eventTypes.data.map((e) => ({ value: e.slug, label: e.name }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
  if (options.length === 0) return <p className="text-xs text-muted-foreground">{t('landing.editor.noEventTypes')}</p>;
  return (
    <Choice
      className="h-8 text-xs"
      value={value || null}
      noneLabel={t('landing.editor.chooseEventType')}
      options={options}
      disabled={disabled}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}
