/**
 * Ad parameter vocabulary of the tracked links: the platform fills its
 * macros at click time, the tracker reads the params on the landing page and
 * the session keeps the ad ids, so leads and sales join the exact ad
 * (campaign → ad set → ad) without relying on the platform's own attribution.
 */

/** Neutral URL params carrying the ad ids (stored on the session). */
export const AD_PARAM_NAMES = [
  'amb_cid',
  'amb_asid',
  'amb_adid',
  'amb_pl',
  'amb_kw',
  'amb_net',
] as const;
export type AdParamName = (typeof AD_PARAM_NAMES)[number];

export const AD_LINK_PLATFORMS = [
  'meta',
  'google',
  'tiktok',
  'microsoft',
  'linkedin',
  'pinterest',
  'snapchat',
] as const;
export type AdLinkPlatform = (typeof AD_LINK_PLATFORMS)[number];

/** Params (in order) with each platform's dynamic macros; `utm_*` keep the reports readable. */
export const AD_LINK_MACROS: Readonly<
  Record<AdLinkPlatform, ReadonlyArray<readonly [string, string]>>
> = {
  meta: [
    ['utm_source', 'facebook'],
    ['utm_medium', 'paid_social'],
    ['utm_campaign', '{{campaign.name}}'],
    ['utm_content', '{{ad.name}}'],
    ['amb_cid', '{{campaign.id}}'],
    ['amb_asid', '{{adset.id}}'],
    ['amb_adid', '{{ad.id}}'],
    ['amb_pl', '{{placement}}'],
    ['amb_net', '{{site_source_name}}'],
  ],
  google: [
    ['utm_source', 'google'],
    ['utm_medium', 'cpc'],
    ['utm_campaign', '{campaignid}'],
    ['utm_term', '{keyword}'],
    ['amb_cid', '{campaignid}'],
    ['amb_asid', '{adgroupid}'],
    ['amb_adid', '{creative}'],
    ['amb_kw', '{keyword}'],
    ['amb_pl', '{placement}'],
    ['amb_net', '{network}'],
  ],
  tiktok: [
    ['utm_source', 'tiktok'],
    ['utm_medium', 'paid_social'],
    ['utm_campaign', '__CAMPAIGN_NAME__'],
    ['utm_content', '__CID_NAME__'],
    ['amb_cid', '__CAMPAIGN_ID__'],
    ['amb_asid', '__AID__'],
    ['amb_adid', '__CID__'],
    ['amb_pl', '__PLACEMENT__'],
  ],
  microsoft: [
    ['utm_source', 'bing'],
    ['utm_medium', 'cpc'],
    ['utm_campaign', '{Campaign}'],
    ['utm_term', '{keyword:default}'],
    ['amb_cid', '{CampaignId}'],
    ['amb_asid', '{AdGroupId}'],
    ['amb_adid', '{AdId}'],
    ['amb_kw', '{keyword:default}'],
    ['amb_net', '{Network}'],
  ],
  linkedin: [
    ['utm_source', 'linkedin'],
    ['utm_medium', 'paid_social'],
    ['utm_campaign', '{{CAMPAIGN_NAME}}'],
    ['amb_cid', '{{CAMPAIGN_ID}}'],
    ['amb_asid', '{{CAMPAIGN_GROUP_ID}}'],
    ['amb_adid', '{{CREATIVE_ID}}'],
  ],
  pinterest: [
    ['utm_source', 'pinterest'],
    ['utm_medium', 'paid_social'],
    ['utm_campaign', '{campaign_name}'],
    ['amb_cid', '{campaignid}'],
    ['amb_asid', '{adgroupid}'],
    ['amb_adid', '{adid}'],
  ],
  snapchat: [
    ['utm_source', 'snapchat'],
    ['utm_medium', 'paid_social'],
    ['utm_campaign', '{{campaign.name}}'],
    ['amb_cid', '{{campaign.id}}'],
    ['amb_asid', '{{adSet.id}}'],
    ['amb_adid', '{{ad.id}}'],
  ],
};

/** Where each platform takes the suffix (shown next to the generated string). */
export const AD_LINK_FIELD: Readonly<Record<AdLinkPlatform, string>> = {
  meta: 'Ad → Destination → URL parameters',
  google: 'Campaign settings → Campaign URL options → Final URL suffix',
  tiktok: 'Ad → Destination → URL (append the parameters)',
  microsoft: 'Campaign settings → Final URL suffix',
  linkedin: 'Ad → Destination URL (append the parameters)',
  pinterest: 'Ad → Destination URL (append the parameters)',
  snapchat: 'Ad → Website URL (append the parameters)',
};

export const EMAIL_PROVIDERS = [
  'mailchimp',
  'klaviyo',
  'activecampaign',
  'brevo',
  'hubspot',
  'kit',
  'mailerlite',
  'getresponse',
  'beehiiv',
  'sendgrid',
] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/** Merge tag of the recipient's email in each provider (filled when the email is sent). */
export const EMAIL_MERGE_TAGS: Readonly<Record<EmailProvider, string>> = {
  mailchimp: '*|EMAIL|*',
  klaviyo: '{{ email }}',
  activecampaign: '%EMAIL%',
  brevo: '{{ contact.EMAIL }}',
  hubspot: '{{ contact.email }}',
  kit: '{{ subscriber.email_address }}',
  mailerlite: '{$email}',
  getresponse: '[[email]]',
  beehiiv: '{{email}}',
  sendgrid: '{{email}}',
};

/** `true` when a value is still an unfilled macro (preview clicks, wrong field). */
export function isUnfilledMacro(value: string): boolean {
  return /[{}[\]|%$*]|^__[A-Z_]+__$/.test(value);
}

/**
 * Destination URL with the params appended verbatim (macros must reach the
 * platform unencoded); an empty destination gives the bare suffix.
 */
export function appendParams(
  destination: string,
  params: ReadonlyArray<readonly [string, string]>,
): string {
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  const base = destination.trim();
  if (base === '') return query;
  const [head, hash] = base.split('#', 2) as [string, string | undefined];
  const sep = head.includes('?') ? (head.endsWith('?') || head.endsWith('&') ? '' : '&') : '?';
  return `${head}${sep}${query}${hash === undefined ? '' : `#${hash}`}`;
}

/** Tracked link of an ad platform. */
export function adLink(platform: AdLinkPlatform, destination: string): string {
  return appendParams(destination, AD_LINK_MACROS[platform]);
}

/** Tracked link of an email: the recipient's email (`he`) identifies the click. */
export function emailLink(provider: EmailProvider, destination: string, campaign: string): string {
  const label = campaign.trim().replace(/\s+/g, '_').slice(0, 64);
  return appendParams(destination, [
    ['he', EMAIL_MERGE_TAGS[provider]],
    ['utm_source', provider],
    ['utm_medium', 'email'],
    ...(label === '' ? [] : ([['utm_campaign', label]] as const)),
    ['el', label === '' ? 'email' : label],
  ]);
}

// ------------------------------------------------------------ script path

/**
 * Neutral tracker path `<dir>/<name>`: the script is `/<dir>/<name>.js`
 * (`-l` cookieless, `-h` hash routing) and the tracker posts to `/<dir>/<name>`.
 * Generic filter lists match well-known names (`/s.js`, `/collect`); a per-site
 * random path served from a first-party host matches none of them. The
 * directory always holds a digit, so a self-hosted classic bundle under a word
 * (`/static/sa.js`, `/assets/main.js`) is never taken for a neutral path.
 */
export const SCRIPT_PATH_RE = /^(?=[a-z]*\d)[a-z0-9]{6,16}\/[a-z0-9]{2,16}$/;

const SCRIPT_NAMES = ['app', 'main', 'core', 'bundle', 'lib', 'init', 'site', 'static'] as const;
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

function pathFromBytes(bytes: ArrayLike<number>): string {
  let dir = '';
  for (let i = 0; i < 8; i++) dir += BASE36[(bytes[i] ?? 0) % BASE36.length];
  if (!/\d/.test(dir)) dir = dir.slice(0, 7) + String((bytes[7] ?? 0) % 10);
  return `${dir}/${SCRIPT_NAMES[(bytes[8] ?? 0) % SCRIPT_NAMES.length]}`;
}

/** Stable path of a site that never chose one (FNV-1a of the id, no randomness). */
export function defaultScriptPath(siteId: string): string {
  const bytes: number[] = [];
  let h = 0x811c9dc5;
  for (let round = 0; bytes.length < 9; round++) {
    for (const ch of `${siteId}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    bytes.push(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff);
  }
  return pathFromBytes(bytes);
}

/** New random path (rotation after a filter list picked the current one up). */
export function randomScriptPath(): string {
  const { crypto } = globalThis as unknown as {
    crypto: { getRandomValues(bytes: Uint8Array): Uint8Array };
  };
  return pathFromBytes(crypto.getRandomValues(new Uint8Array(9)));
}
