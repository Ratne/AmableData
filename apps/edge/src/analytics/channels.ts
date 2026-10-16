/** Traffic channel classification (computed once, at session start). */

export const CHANNELS = [
  'Direct',
  'Organic search',
  'Paid search',
  'Organic social',
  'Paid social',
  'Email',
  'Newsletter',
  'Referral',
  'Affiliate',
] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelInput {
  /** Hostname of the document referrer (already lowercased), when external. */
  referrerHost: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  /** `ref`, `source` and `via` landing params. */
  ref?: string | null;
  source?: string | null;
  via?: string | null;
  clickIds?: Readonly<Record<string, string>> | null;
}

export interface ChannelResult {
  channel: Channel;
  /** True when the visit comes from paid media (ad click id or paid utm_medium). */
  paid: boolean;
  /** Normalized source label (search engine, social network, utm_source, referrer host). */
  source: string | null;
}

const SEARCH_ENGINES: ReadonlyArray<[label: string, re: RegExp]> = [
  ['Google', /(^|\.)google\.[a-z.]+$|^google$/],
  ['Bing', /(^|\.)bing\.com$|^bing$/],
  ['DuckDuckGo', /(^|\.)duckduckgo\.com$|^duckduckgo$/],
  ['Yahoo', /(^|\.)search\.yahoo\.[a-z.]+$|^yahoo$/],
  ['Yandex', /(^|\.)yandex\.[a-z.]+$|^yandex$/],
  ['Baidu', /(^|\.)baidu\.com$|^baidu$/],
  ['Ecosia', /(^|\.)ecosia\.org$|^ecosia$/],
  ['Brave Search', /^search\.brave\.com$/],
  ['Qwant', /(^|\.)qwant\.com$|^qwant$/],
  ['Startpage', /(^|\.)startpage\.com$/],
  ['Naver', /(^|\.)naver\.com$|^naver$/],
  ['Seznam', /(^|\.)seznam\.cz$/],
  ['Kagi', /(^|\.)kagi\.com$/],
];

const SOCIAL_NETWORKS: ReadonlyArray<[label: string, re: RegExp]> = [
  ['Facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$|^(facebook|fb)$/],
  ['Instagram', /(^|\.)instagram\.com$|^(instagram|ig)$/],
  ['X', /(^|\.)(twitter\.com|x\.com|t\.co)$|^(twitter|x)$/],
  ['LinkedIn', /(^|\.)(linkedin\.com|lnkd\.in)$|^linkedin$/],
  ['Reddit', /(^|\.)reddit\.com$|^reddit$/],
  ['YouTube', /(^|\.)(youtube\.com|youtu\.be)$|^youtube$/],
  ['TikTok', /(^|\.)tiktok\.com$|^tiktok$/],
  ['Pinterest', /(^|\.)pinterest\.[a-z.]+$|^pin\.it$|^pinterest$/],
  ['Threads', /(^|\.)threads\.net$|^threads$/],
  ['Bluesky', /(^|\.)bsky\.app$|^bluesky$/],
  ['Mastodon', /(^|\.)mastodon\.[a-z.]+$|^mastodon$/],
  ['Quora', /(^|\.)quora\.com$/],
  ['Hacker News', /^news\.ycombinator\.com$|^hackernews$|^hn$/],
  ['Product Hunt', /(^|\.)producthunt\.com$|^producthunt$/],
  ['Discord', /(^|\.)(discord\.com|discord\.gg)$|^discord$/],
  ['Telegram', /(^|\.)(t\.me|telegram\.org)$|^telegram$/],
  ['WhatsApp', /(^|\.)(whatsapp\.com|wa\.me)$|^whatsapp$/],
  ['Snapchat', /(^|\.)snapchat\.com$|^snapchat$/],
  ['VK', /(^|\.)vk\.com$/],
];

const WEBMAIL =
  /(^|\.)(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|mail\.proton\.me|webmail\.[a-z.]+|mail\.[a-z0-9-]+\.[a-z.]+)$/;
const NEWSLETTER_HOSTS =
  /(^|\.)(substack\.com|beehiiv\.com|buttondown\.(email|com)|convertkit\.com|kit\.com|mailchi\.mp|ghost\.io|revue\.co)$/;

const PAID_MEDIUM =
  /^(cpc|ppc|cpm|cpv|cpa|cpp|paid|paid[_-]?(search|social|media)|paidsearch|paidsocial|display|banner|ads?|retargeting|remarketing|sponsored)$/;
const SOCIAL_MEDIUM = /^(social|social[_-]?network|social[_-]?media|sm|organic[_-]?social)$/;
const SEARCH_MEDIUM = /^(organic|search|organic[_-]?search|seo)$/;

/** Ad click ids that only exist on paid clicks (fbclid is added to organic Facebook links too). */
const PAID_SEARCH_CLICK_IDS = ['gclid', 'wbraid', 'gbraid', 'msclkid'] as const;
const PAID_SOCIAL_CLICK_IDS = ['ttclid', 'twclid', 'li_fat_id'] as const;

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function match(list: ReadonlyArray<[string, RegExp]>, ...candidates: string[]): string | null {
  for (const c of candidates) {
    if (c === '') continue;
    for (const [label, re] of list) if (re.test(c)) return label;
  }
  return null;
}

export function classifyChannel(input: ChannelInput): ChannelResult {
  const host = norm(input.referrerHost);
  const utmSource = norm(input.utmSource);
  const medium = norm(input.utmMedium);
  const refParam = norm(input.ref) || norm(input.source);
  const via = norm(input.via);
  const name = utmSource || refParam;
  const clicks = input.clickIds ?? {};
  const has = (ids: readonly string[]): boolean => ids.some((id) => (clicks[id] ?? '') !== '');

  const paidSearchClick = has(PAID_SEARCH_CLICK_IDS);
  const paidSocialClick = has(PAID_SOCIAL_CLICK_IDS);
  const paid =
    paidSearchClick || paidSocialClick || PAID_MEDIUM.test(medium) || medium.includes('paid');

  const engine = match(SEARCH_ENGINES, host, name);
  const social = match(SOCIAL_NETWORKS, host, name);
  const rawSource =
    input.utmSource?.trim() || input.ref?.trim() || input.source?.trim() || host || null;
  const fallbackSource = engine ?? social ?? rawSource;

  const result = (channel: Channel, source: string | null = fallbackSource): ChannelResult => ({
    channel,
    paid,
    source,
  });

  if (
    medium === 'email' ||
    medium === 'e-mail' ||
    medium === 'e_mail' ||
    (medium === '' && WEBMAIL.test(host))
  ) {
    return result('Email', rawSource);
  }
  if (medium === 'newsletter' || name.includes('newsletter') || NEWSLETTER_HOSTS.test(host)) {
    return result('Newsletter', rawSource);
  }
  if (medium === 'affiliate' || medium === 'affiliates' || medium === 'partner' || via !== '') {
    return result('Affiliate', fallbackSource ?? (input.via?.trim() || null));
  }
  if (paidSearchClick && social === null)
    return result('Paid search', engine ?? (clicks['msclkid'] ? 'Bing' : 'Google'));
  if (paidSocialClick && engine === null) {
    const label = social ?? (clicks['ttclid'] ? 'TikTok' : clicks['twclid'] ? 'X' : 'LinkedIn');
    return result('Paid social', label);
  }
  if (engine !== null || SEARCH_MEDIUM.test(medium))
    return result(paid ? 'Paid search' : 'Organic search');
  if (social !== null || SOCIAL_MEDIUM.test(medium))
    return result(paid ? 'Paid social' : 'Organic social');
  if (medium === 'cpc' || medium === 'ppc') return result('Paid search');
  if (host !== '' || name !== '') return result('Referral');
  return { channel: 'Direct', paid, source: null };
}
