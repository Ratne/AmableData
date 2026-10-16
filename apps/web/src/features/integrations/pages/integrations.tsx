import type { AddressLookupSettings, UpdateAddressLookupSettingsInput } from '@amable/api-types/crm';
import { cn, DashboardButton, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { Switch } from '@amable/ui/ui/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { FormField, PageState, SectionCard } from '../../commerce/components/common';
import { request } from '../../crm/api/client';
import { errorMessage, usePermissions, useTenantSlug } from '../../crm/api/hooks';

const TOKEN_RE = /^[ps]k\.[A-Za-z0-9._-]{20,500}$/;

function settingsUrl(slug: string): string {
  return `/api/v2/t/${encodeURIComponent(slug)}/settings/addressLookup`;
}

export function IntegrationsPage() {
  const { t } = useI18n();
  const slug = useTenantSlug();
  usePageChrome({ title: t('nav.integrations') });
  const settings = useQuery({
    queryKey: ['tenant', slug, 'addressLookupSettings'] as const,
    queryFn: () => request<AddressLookupSettings>(settingsUrl(slug)),
  });
  return (
    <PageState isPending={settings.isPending} error={settings.error}>
      {() =>
        settings.data ? <AddressLookupForm key={JSON.stringify(settings.data)} initial={settings.data} /> : null
      }
    </PageState>
  );
}

function AddressLookupForm({ initial }: { initial: AddressLookupSettings }) {
  const { t } = useI18n();
  const slug = useTenantSlug();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const editable = can('integrations:manage');
  const [provider, setProvider] = useState(initial.provider);
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(!initial.mapbox.configured);
  const [permanent, setPermanent] = useState(initial.mapbox.permanent);

  const tokenTyped = token.trim();
  const tokenValid = tokenTyped === '' || TOKEN_RE.test(tokenTyped);
  const needsToken = provider === 'mapbox' && !initial.mapbox.configured && tokenTyped === '';
  const dirty =
    provider !== initial.provider || tokenTyped !== '' || permanent !== initial.mapbox.permanent;

  const save = useMutation({
    mutationFn: (body: UpdateAddressLookupSettingsInput) =>
      request<AddressLookupSettings>(settingsUrl(slug), { method: 'PATCH', json: body }),
    onSuccess: (data) => {
      queryClient.setQueryData(['tenant', slug, 'addressLookupSettings'], data);
      void queryClient.invalidateQueries({ queryKey: ['crm', slug, 'addressSuggestions'] });
      toast.success(t('integrations.saved'));
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!tokenValid || needsToken) return;
    save.mutate({
      provider,
      ...(tokenTyped === '' ? {} : { mapbox_token: tokenTyped }),
      ...(permanent === initial.mapbox.permanent ? {} : { mapbox_permanent: permanent }),
    });
  };

  return (
    <form onSubmit={submit}>
      <PageToolbar
        actions={
          editable ? (
            <DashboardButton
              variant="primary"
              type="submit"
              disabled={!dirty || !tokenValid || needsToken || save.isPending}
            >
              <Save aria-hidden /> {t('common.save')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid max-w-3xl gap-4">
        <SectionCard title={t('integrations.address.title')}>
          <fieldset disabled={!editable || save.isPending} className="grid gap-4">
            <p className="text-sm text-muted-foreground">{t('integrations.address.intro')}</p>
            <RadioGroup
              value={provider}
              onValueChange={(value) => setProvider(value === 'mapbox' ? 'mapbox' : 'default')}
              className="grid gap-2"
            >
              <ProviderOption
                value="default"
                title={t('integrations.address.osm')}
                badge={t('integrations.address.free')}
                description={
                  initial.default_available
                    ? t('integrations.address.osmHint')
                    : t('integrations.address.osmOff')
                }
                selected={provider === 'default'}
              />
              <ProviderOption
                value="mapbox"
                title={t('integrations.address.mapbox')}
                badge={t('integrations.address.needsKey')}
                description={t('integrations.address.mapboxHint')}
                selected={provider === 'mapbox'}
              />
            </RadioGroup>

            {provider === 'mapbox' || initial.mapbox.configured ? (
              <div className="grid gap-4 rounded-md border p-3">
                {initial.mapbox.configured && !replacing ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                    <span>{t('integrations.address.tokenSaved', { hint: initial.mapbox.token_hint ?? '' })}</span>
                    <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setReplacing(true)}>
                      {t('integrations.address.replaceToken')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => save.mutate({ mapbox_token: null })}
                    >
                      {t('integrations.address.removeToken')}
                    </Button>
                  </div>
                ) : (
                  <FormField
                    label={t('integrations.address.token')}
                    error={tokenValid ? null : t('integrations.address.tokenInvalid')}
                    hint={
                      <>
                        {t('integrations.address.tokenHint')}{' '}
                        <a
                          href="https://account.mapbox.com/access-tokens/"
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 underline"
                        >
                          account.mapbox.com <ExternalLink className="size-3" aria-hidden />
                        </a>
                      </>
                    }
                  >
                    {(id) => (
                      <Input
                        id={id}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="pk.eyJ1Ijoi…"
                        value={token}
                        aria-invalid={!tokenValid}
                        onChange={(e) => setToken(e.target.value)}
                      />
                    )}
                  </FormField>
                )}
                <div className="flex items-start gap-3">
                  <Switch id="mapbox-permanent" checked={permanent} onCheckedChange={setPermanent} />
                  <div className="grid gap-1">
                    <Label htmlFor="mapbox-permanent">{t('integrations.address.permanent')}</Label>
                    <p className="text-xs text-muted-foreground">{t('integrations.address.permanentHint')}</p>
                  </div>
                </div>
              </div>
            ) : null}
            {needsToken ? <p className="text-xs text-destructive">{t('integrations.address.needsTokenFirst')}</p> : null}
          </fieldset>
        </SectionCard>
      </PageBody>
    </form>
  );
}

function ProviderOption({
  value,
  title,
  badge,
  description,
  selected,
}: {
  value: string;
  title: string;
  badge: string;
  description: string;
  selected: boolean;
}) {
  const id = `address-provider-${value}`;
  return (
    <Label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal',
        selected && 'border-primary bg-primary/5',
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="grid gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title} <Badge variant="secondary">{badge}</Badge>
        </span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </Label>
  );
}
