import {
  AD_LINK_FIELD,
  AD_LINK_PLATFORMS,
  adLink,
  EMAIL_MERGE_TAGS,
  EMAIL_PROVIDERS,
  emailLink,
  type AdLinkPlatform,
  type EmailProvider,
  type Site,
} from '@amable/api-types';
import { Input } from '@amable/ui/ui/input';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { CodeBlock } from '../components/copy';
import { Panel, Segmented } from '../components/ui';
import { Field, selectClass } from '../funnel-builder/panels/form-bits';

const PLATFORM_LABELS: Readonly<Record<AdLinkPlatform, string>> = {
  meta: 'Meta',
  google: 'Google Ads',
  tiktok: 'TikTok',
  microsoft: 'Microsoft Ads',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  snapchat: 'Snapchat',
};

const PROVIDER_LABELS: Readonly<Record<EmailProvider, string>> = {
  mailchimp: 'Mailchimp',
  klaviyo: 'Klaviyo',
  activecampaign: 'ActiveCampaign',
  brevo: 'Brevo',
  hubspot: 'HubSpot',
  kit: 'Kit',
  mailerlite: 'MailerLite',
  getresponse: 'GetResponse',
  beehiiv: 'beehiiv',
  sendgrid: 'SendGrid',
};

type Mode = 'ads' | 'email';

function defaultDestination(site: Site): string {
  const host = site.hostnames[0];
  return host === undefined ? '' : `https://${host}/`;
}

/** Tracked links: ad platforms (macros carry the ad ids) and emails (merge tag identifies the click). */
export function LinkBuilderPanel({ site }: { site: Site }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('ads');
  const [destination, setDestination] = useState(() => defaultDestination(site));
  const [platform, setPlatform] = useState<AdLinkPlatform>('meta');
  const [provider, setProvider] = useState<EmailProvider>('mailchimp');
  const [campaign, setCampaign] = useState('');

  return (
    <Panel
      title={t('analytics.links.title')}
      actions={
        <Segmented<Mode>
          label={t('analytics.links.title')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'ads', label: t('analytics.links.ads') },
            { value: 'email', label: t('analytics.links.email') },
          ]}
        />
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('analytics.links.destination')}>
            <Input
              className="h-8"
              value={destination}
              placeholder="https://example.com/offer"
              onChange={(e) => setDestination(e.target.value)}
            />
          </Field>
          {mode === 'ads' ? (
            <Field label={t('analytics.links.platform')}>
              <select
                className={selectClass}
                value={platform}
                onChange={(e) => setPlatform(e.target.value as AdLinkPlatform)}
              >
                {AD_LINK_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('analytics.links.provider')}>
                <select
                  className={selectClass}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as EmailProvider)}
                >
                  {EMAIL_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABELS[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('analytics.links.campaign')}>
                <Input
                  className="h-8"
                  value={campaign}
                  placeholder="newsletter_nov"
                  onChange={(e) => setCampaign(e.target.value)}
                />
              </Field>
            </div>
          )}
        </div>
        {mode === 'ads' ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t('analytics.links.suffixHint', { field: AD_LINK_FIELD[platform] })}
            </p>
            <CodeBlock code={adLink(platform, '')} />
            <p className="text-xs text-muted-foreground">{t('analytics.links.fullUrl')}</p>
            <CodeBlock code={adLink(platform, destination)} />
            <p className="text-xs text-muted-foreground">{t('analytics.links.adsHint')}</p>
          </>
        ) : (
          <>
            <CodeBlock code={emailLink(provider, destination, campaign)} />
            <p className="text-xs text-muted-foreground">
              {t('analytics.links.emailHint', { tag: EMAIL_MERGE_TAGS[provider] })}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
