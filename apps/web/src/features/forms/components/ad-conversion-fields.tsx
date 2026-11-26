import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { useI18n } from '../../../i18n';
import { Choice, FormField as Field } from './common';

export type ConversionType = 'facebook_capi' | 'tiktok_events';

/** Standard web events of Meta CAPI and TikTok Events API 2.0 (same names on both). */
const STANDARD_EVENTS = [
  'Lead',
  'CompleteRegistration',
  'Contact',
  'SubmitApplication',
  'Schedule',
  'Subscribe',
  'StartTrial',
  'InitiateCheckout',
  'Purchase',
] as const;
const CUSTOM = '__custom';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** Config sent to the API for a conversion connection, from the dialog state. */
export function buildConversionConfig(type: ConversionType, config: Record<string, unknown>, defaultEvent = 'Lead') {
  const common = {
    event_name: str(config['event_name']).trim() || defaultEvent,
    test_event_code: str(config['test_event_code']).trim(),
    send_external_id: config['send_external_id'] !== false,
    default_calling_code: str(config['default_calling_code']).replace(/\D/g, ''),
  };
  return type === 'facebook_capi'
    ? { pixel_id: str(config['pixel_id']).trim(), ...common }
    : { pixel_code: str(config['pixel_code']).trim(), ...common };
}

/** Pixel, access token, event and options of a Meta CAPI / TikTok Events connection. */
export function AdConversionFields({
  type,
  config,
  set,
  token,
  setToken,
  hasToken,
  defaultEvent = 'Lead',
  dedupHint,
}: {
  type: ConversionType;
  config: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
  token: string;
  setToken: (token: string) => void;
  hasToken: boolean;
  defaultEvent?: string;
  /** Where the event ID comes from, for deduplication with the browser pixel. */
  dedupHint?: string;
}) {
  const { t } = useI18n();
  const pixelKey = type === 'facebook_capi' ? 'pixel_id' : 'pixel_code';
  const event = str(config['event_name'], defaultEvent);
  const standard = (STANDARD_EVENTS as readonly string[]).includes(event);
  return (
    <>
      <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        {t(type === 'facebook_capi' ? 'forms.conversion.metaSetup' : 'forms.conversion.tiktokSetup')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t(type === 'facebook_capi' ? 'forms.conversion.pixelId' : 'forms.conversion.pixelCode')}>
          {(id) => <Input id={id} required value={str(config[pixelKey])} onChange={(e) => set({ [pixelKey]: e.target.value })} />}
        </Field>
        <Field label={t('forms.conversion.token')} hint={hasToken ? t('forms.conversion.tokenKeep') : undefined}>
          {(id) => (
            <Input id={id} type="password" autoComplete="off" required={!hasToken} value={token} onChange={(e) => setToken(e.target.value)} />
          )}
        </Field>
        <Field label={t('forms.conversion.event')} hint={dedupHint ?? t('forms.conversion.dedupHint')}>
          {(id) => (
            <Choice
              id={id}
              value={standard ? event : CUSTOM}
              options={[
                ...STANDARD_EVENTS.map((value) => ({ value, label: value })),
                { value: CUSTOM, label: t('forms.conversion.customEvent') },
              ]}
              onChange={(v) => set({ event_name: v === null || v === CUSTOM ? '' : v })}
            />
          )}
        </Field>
        {standard ? null : (
          <Field label={t('forms.conversion.customEventName')}>
            {(id) => <Input id={id} required value={event} onChange={(e) => set({ event_name: e.target.value })} />}
          </Field>
        )}
        <Field label={t('forms.conversion.testCode')} hint={t('forms.conversion.testCodeHint')}>
          {(id) => <Input id={id} value={str(config['test_event_code'])} onChange={(e) => set({ test_event_code: e.target.value })} />}
        </Field>
        <Field label={t('forms.conversion.callingCode')} hint={t('forms.conversion.callingCodeHint')}>
          {(id) => (
            <Input id={id} inputMode="numeric" maxLength={4} value={str(config['default_calling_code'])} onChange={(e) => set({ default_calling_code: e.target.value })} />
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={config['send_external_id'] !== false} onCheckedChange={(send_external_id) => set({ send_external_id })} />
        {t('forms.conversion.externalId')}
      </label>
    </>
  );
}
