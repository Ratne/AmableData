import {
  ATTRIBUTION_MODELS,
  type AttributionModel,
  type CreateSiteInput,
  type Site,
} from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Switch } from '@amable/ui/ui/switch';
import { X } from 'lucide-react';
import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { modelLabel } from '../lib/labels';

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'BRL',
  'MXN',
  'INR',
];
export const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Rome', 'Europe/London', 'America/New_York'];
  }
}

/** Hostname from a pasted URL or plain host. */
function normalizeHost(raw: string): string {
  const value = raw.trim().toLowerCase();
  try {
    return value.includes('://') ? new URL(value).hostname : value.replace(/\/.*$/, '');
  } catch {
    return value;
  }
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export type SiteFormValue = Required<
  Pick<
    CreateSiteInput,
    | 'name'
    | 'hostnames'
    | 'cookieless'
    | 'allow_localhost'
    | 'timezone'
    | 'currency'
    | 'retention_days'
    | 'attribution_model'
  >
>;

export function SiteFormDialog({
  site,
  pending,
  onClose,
  onSubmit,
}: {
  site: Site | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (value: SiteFormValue) => void;
}) {
  const { t } = useI18n();
  const zones = useMemo(timeZones, []);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState(site?.name ?? '');
  const [hostnames, setHostnames] = useState<string[]>(site?.hostnames ?? []);
  const [hostDraft, setHostDraft] = useState('');
  const [timezone, setTimezone] = useState(site?.timezone ?? browserZone ?? 'UTC');
  const [currency, setCurrency] = useState(site?.currency ?? 'EUR');
  const [cookieless, setCookieless] = useState(site?.cookieless ?? false);
  const [allowLocalhost, setAllowLocalhost] = useState(site?.allow_localhost ?? false);
  const [retention, setRetention] = useState(String(site?.retention_days ?? 395));
  const [model, setModel] = useState<AttributionModel>(
    site?.attribution_model ?? 'last_non_direct',
  );

  const addHost = () => {
    const host = normalizeHost(hostDraft);
    if (!host || !HOSTNAME.test(host) || hostnames.includes(host) || hostnames.length >= 20) return;
    setHostnames([...hostnames, host]);
    setHostDraft('');
  };
  const onHostKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addHost();
    } else if (event.key === 'Backspace' && !hostDraft && hostnames.length > 0) {
      setHostnames(hostnames.slice(0, -1));
    }
  };

  const retentionDays = Number(retention);
  const retentionValid =
    Number.isInteger(retentionDays) &&
    (retentionDays === 0 || (retentionDays >= 30 && retentionDays <= 3650));
  const pendingHost = normalizeHost(hostDraft);
  const allHosts =
    pendingHost && HOSTNAME.test(pendingHost) && !hostnames.includes(pendingHost)
      ? [...hostnames, pendingHost]
      : hostnames;
  const valid =
    name.trim().length > 0 &&
    allHosts.length > 0 &&
    /^[A-Za-z]{3}$/.test(currency) &&
    retentionValid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit({
      name: name.trim(),
      hostnames: allHosts,
      timezone,
      currency: currency.toUpperCase(),
      cookieless,
      allow_localhost: allowLocalhost,
      retention_days: retentionDays,
      attribution_model: model,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {site ? t('analytics.sites.editTitle') : t('analytics.sites.newTitle')}
            </DialogTitle>
            <DialogDescription>{t('analytics.sites.formHint')}</DialogDescription>
          </DialogHeader>
          <Field label={t('analytics.common.name')} htmlFor="amb-site-name">
            <Input
              id="amb-site-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme"
              autoFocus
            />
          </Field>
          <Field
            label={t('analytics.sites.hostnames')}
            htmlFor="amb-site-host"
            hint={t('analytics.sites.hostnamesHint')}
          >
            <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1 focus-within:ring-2 focus-within:ring-ring/40">
              {hostnames.map((host) => (
                <span
                  key={host}
                  className="inline-flex h-6 items-center gap-1 rounded bg-foreground/[0.06] pl-2 pr-1 font-mono text-xs"
                >
                  {host}
                  <button
                    type="button"
                    aria-label={t('analytics.common.remove')}
                    onClick={() => setHostnames(hostnames.filter((item) => item !== host))}
                    className="inline-flex size-4 items-center justify-center rounded hover:bg-foreground/10"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <input
                id="amb-site-host"
                value={hostDraft}
                onChange={(event) => setHostDraft(event.target.value)}
                onKeyDown={onHostKey}
                onBlur={addHost}
                placeholder={hostnames.length === 0 ? 'example.com' : ''}
                className="h-6 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none"
              />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('analytics.sites.timezone')} htmlFor="amb-site-tz">
              <select
                id="amb-site-tz"
                className={selectClass}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('analytics.sites.currency')} htmlFor="amb-site-currency">
              <Input
                id="amb-site-currency"
                list="amb-currencies"
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
              <datalist id="amb-currencies">
                {CURRENCIES.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
            </Field>
            <Field
              label={t('analytics.sites.retention')}
              htmlFor="amb-site-retention"
              hint={t('analytics.sites.retentionHint')}
            >
              <Input
                id="amb-site-retention"
                type="number"
                min={0}
                max={3650}
                value={retention}
                aria-invalid={!retentionValid}
                onChange={(event) => setRetention(event.target.value)}
              />
            </Field>
            <Field label={t('analytics.controls.attribution')} htmlFor="amb-site-model">
              <select
                id="amb-site-model"
                className={selectClass}
                value={model}
                onChange={(event) => setModel(event.target.value as AttributionModel)}
              >
                {ATTRIBUTION_MODELS.map((value) => (
                  <option key={value} value={value}>
                    {modelLabel(t, value)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{t('analytics.sites.cookieless')}</span>
              <span className="text-xs text-muted-foreground">
                {t('analytics.sites.cookielessHint')}
              </span>
            </span>
            <Switch checked={cookieless} onCheckedChange={setCookieless} />
          </label>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{t('analytics.sites.localhost')}</span>
              <span className="text-xs text-muted-foreground">
                {t('analytics.sites.localhostHint')}
              </span>
            </span>
            <Switch checked={allowLocalhost} onCheckedChange={setAllowLocalhost} />
          </label>
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton type="submit" variant="primary" disabled={!valid || pending}>
              {site ? t('common.save') : t('analytics.sites.create')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
