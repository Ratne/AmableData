import { describe, expect, it } from 'vitest';
import { classifyChannel, type Channel, type ChannelInput } from '../src/analytics/channels';
import { cookielessVisitorId, saltDay } from '../src/analytics/cookieless';
import { detectBot } from '../src/analytics/crawlers';
import { hostAllowed, paymentFromData, toMinor } from '../src/analytics/enrich';
import { todaySalt } from '../src/analytics/store/site';
import { parseUserAgent } from '../src/analytics/ua';
import { createNodeSqlDb, T0 } from './helpers';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  instagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0',
};

describe('user agent parsing', () => {
  it.each([
    ['chromeMac', 'Chrome', '129', 'macOS', 'desktop'],
    ['safariMac', 'Safari', '18', 'macOS', 'desktop'],
    ['iphone', 'Safari', '18', 'iOS', 'mobile'],
    ['ipad', 'Chrome', '129', 'iPadOS', 'tablet'],
    ['androidPhone', 'Chrome', '129', 'Android', 'mobile'],
    ['androidTablet', 'Chrome', '128', 'Android', 'tablet'],
    ['samsung', 'Samsung Internet', '25', 'Android', 'mobile'],
    ['edgeWin', 'Edge', '129', 'Windows', 'desktop'],
    ['firefoxLinux', 'Firefox', '131', 'Linux', 'desktop'],
    ['operaWin', 'Opera', '114', 'Windows', 'desktop'],
    ['chromebook', 'Chrome', '129', 'ChromeOS', 'desktop'],
    ['instagram', 'Instagram', '345', 'iOS', 'mobile'],
  ] as const)('%s', (key, browser, version, os, device) => {
    const parsed = parseUserAgent(UA[key]);
    expect(parsed).toMatchObject({ browser, browserVersion: version, os, device });
  });

  it('reports versions of Windows and macOS', () => {
    expect(parseUserAgent(UA.edgeWin).osVersion).toBe('10');
    expect(parseUserAgent(UA.chromeMac).osVersion).toBe('10.15');
    expect(parseUserAgent('something odd')).toMatchObject({
      browser: 'Unknown',
      os: 'Unknown',
      device: 'desktop',
    });
  });
});

describe('channel classification', () => {
  const cases: ReadonlyArray<
    [label: string, input: ChannelInput, channel: Channel, paid: boolean, source: string | null]
  > = [
    ['no referrer', { referrerHost: null }, 'Direct', false, null],
    ['google organic', { referrerHost: 'www.google.com' }, 'Organic search', false, 'Google'],
    ['google.co.uk', { referrerHost: 'www.google.co.uk' }, 'Organic search', false, 'Google'],
    [
      'bing + msclkid',
      { referrerHost: 'www.bing.com', clickIds: { msclkid: 'x' } },
      'Paid search',
      true,
      'Bing',
    ],
    [
      'gclid without referrer',
      { referrerHost: null, clickIds: { gclid: 'x' } },
      'Paid search',
      true,
      'Google',
    ],
    [
      'wbraid (iOS)',
      { referrerHost: null, clickIds: { wbraid: 'x' } },
      'Paid search',
      true,
      'Google',
    ],
    ['duckduckgo', { referrerHost: 'duckduckgo.com' }, 'Organic search', false, 'DuckDuckGo'],
    [
      'utm_medium=cpc unknown source',
      { referrerHost: null, utmSource: 'adnet', utmMedium: 'cpc' },
      'Paid search',
      true,
      'adnet',
    ],
    [
      'utm organic search',
      { referrerHost: null, utmSource: 'google', utmMedium: 'organic' },
      'Organic search',
      false,
      'Google',
    ],
    [
      'facebook organic (fbclid is not paid)',
      { referrerHost: 'l.facebook.com', clickIds: { fbclid: 'x' } },
      'Organic social',
      false,
      'Facebook',
    ],
    [
      'facebook paid via utm',
      { referrerHost: 'm.facebook.com', utmSource: 'facebook', utmMedium: 'paid_social' },
      'Paid social',
      true,
      'Facebook',
    ],
    ['t.co', { referrerHost: 't.co' }, 'Organic social', false, 'X'],
    ['twclid', { referrerHost: null, clickIds: { twclid: 'x' } }, 'Paid social', true, 'X'],
    ['ttclid', { referrerHost: null, clickIds: { ttclid: 'x' } }, 'Paid social', true, 'TikTok'],
    [
      'li_fat_id from linkedin',
      { referrerHost: 'www.linkedin.com', clickIds: { li_fat_id: 'x' } },
      'Paid social',
      true,
      'LinkedIn',
    ],
    ['reddit', { referrerHost: 'old.reddit.com' }, 'Organic social', false, 'Reddit'],
    ['hn via ref param', { referrerHost: null, ref: 'hn' }, 'Organic social', false, 'Hacker News'],
    [
      'utm social medium',
      { referrerHost: null, utmSource: 'mastodon.social', utmMedium: 'social' },
      'Organic social',
      false,
      'Mastodon',
    ],
    [
      'email medium',
      { referrerHost: null, utmSource: 'crm', utmMedium: 'email' },
      'Email',
      false,
      'crm',
    ],
    ['webmail referrer', { referrerHost: 'mail.google.com' }, 'Email', false, 'mail.google.com'],
    [
      'newsletter medium',
      { referrerHost: null, utmSource: 'weekly', utmMedium: 'newsletter' },
      'Newsletter',
      false,
      'weekly',
    ],
    [
      'substack',
      { referrerHost: 'someone.substack.com' },
      'Newsletter',
      false,
      'someone.substack.com',
    ],
    [
      'affiliate medium',
      { referrerHost: null, utmSource: 'partnerx', utmMedium: 'affiliate' },
      'Affiliate',
      false,
      'partnerx',
    ],
    [
      'via param',
      { referrerHost: 'blog.example.org', via: 'mario' },
      'Affiliate',
      false,
      'blog.example.org',
    ],
    ['plain referral', { referrerHost: 'news.example.org' }, 'Referral', false, 'news.example.org'],
    [
      'utm_source only',
      { referrerHost: null, utmSource: 'partner-site' },
      'Referral',
      false,
      'partner-site',
    ],
    [
      'paid display',
      { referrerHost: 'ads.example.net', utmMedium: 'display' },
      'Referral',
      true,
      'ads.example.net',
    ],
  ];
  it.each(cases)('%s', (_label, input, channel, paid, source) => {
    expect(classifyChannel(input)).toEqual({ channel, paid, source });
  });
});

describe('bot and crawler detection', () => {
  it.each([
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'GPTBot',
      'training',
    ],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0',
      'ChatGPT-User',
      'ai_answers',
    ],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot', 'training'],
    ['Mozilla/5.0 (compatible; Claude-User/1.0)', 'Claude-User', 'ai_answers'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', 'PerplexityBot', 'ai_answers'],
    [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Googlebot',
      'indexing',
    ],
    ['Mozilla/5.0 (compatible; bingbot/2.0)', 'Bingbot', 'indexing'],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot', 'training'],
    ['Mozilla/5.0 (compatible; AhrefsBot/7.0)', 'AhrefsBot', 'other'],
    ['curl/8.4.0', 'Other bot', 'other'],
    ['python-requests/2.32', 'Other bot', 'other'],
    ['Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0 Safari/537.36', 'Other bot', 'other'],
    ['', 'Empty user agent', 'other'],
  ] as const)('%s', (ua, name, category) => {
    expect(detectBot(ua)).toMatchObject({ name, category });
  });

  it('lets real browsers through (including CUBOT phones)', () => {
    expect(detectBot(UA.chromeMac)).toBeNull();
    expect(detectBot(UA.iphone)).toBeNull();
    expect(
      detectBot(
        'Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      ),
    ).toBeNull();
  });
});

describe('cookieless hashing', () => {
  it('is stable within a day and rotates with the daily salt', async () => {
    const db = createNodeSqlDb();
    const day1 = todaySalt(db, T0);
    expect(todaySalt(db, T0 + 3_600_000)).toEqual(day1);
    const a = await cookielessVisitorId(day1.value, 'site', '203.0.113.7', UA.chromeMac);
    expect(a).toMatch(/^h[0-9a-f]{32}$/);
    expect(await cookielessVisitorId(day1.value, 'site', '203.0.113.7', UA.chromeMac)).toBe(a);
    expect(await cookielessVisitorId(day1.value, 'site', '203.0.113.8', UA.chromeMac)).not.toBe(a);
    expect(
      await cookielessVisitorId(day1.value, 'other-site', '203.0.113.7', UA.chromeMac),
    ).not.toBe(a);

    const day2 = todaySalt(db, T0 + 86_400_000);
    expect(day2.day).toBe(saltDay(T0 + 86_400_000));
    expect(day2.value).not.toBe(day1.value);
    expect(await cookielessVisitorId(day2.value, 'site', '203.0.113.7', UA.chromeMac)).not.toBe(a);

    // Salts older than two days are destroyed: yesterday's hashes can't be recomputed.
    todaySalt(db, T0 + 3 * 86_400_000);
    const days = db
      .all<{ day: string }>(`SELECT day FROM daily_salts ORDER BY day`)
      .map((r) => r.day);
    expect(days).not.toContain(day1.day);
  });
});

describe('helpers', () => {
  it('matches hostnames and subdomains', () => {
    const site = { hostnames: ['example.com'], allowLocalhost: false };
    expect(hostAllowed('example.com', site)).toBe(true);
    expect(hostAllowed('shop.example.com', site)).toBe(true);
    expect(hostAllowed('badexample.com', site)).toBe(false);
    expect(hostAllowed('localhost', site)).toBe(false);
    expect(hostAllowed('localhost', { ...site, allowLocalhost: true })).toBe(true);
  });

  it('converts payments to minor units by currency', () => {
    expect(toMinor(19.99, 'EUR')).toBe(1999);
    expect(toMinor(1500, 'JPY')).toBe(1500);
    expect(toMinor(1.234, 'KWD')).toBe(1234);
    expect(
      paymentFromData({
        amount: '49',
        currency: 'usd',
        transaction_id: 't1',
        is_free_trial: 'true',
      }),
    ).toMatchObject({
      amountMinor: 4900,
      currency: 'USD',
      freeTrial: true,
    });
    expect(paymentFromData({ amount: 'x', currency: 'USD', transaction_id: 't1' })).toBeNull();
  });
});
