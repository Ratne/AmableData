/**
 * Server-side bot and crawler detection.
 *
 * The list below is the bundled baseline; the central services of the managed
 * offering will distribute refreshed lists (and IP ranges for verification).
 * Keep entries specific: the first matching pattern wins.
 */

export type BotCategory = 'ai_answers' | 'training' | 'indexing' | 'other';

export interface CrawlerEntry {
  /** Bot name as reported in the dashboard. */
  name: string;
  provider: string;
  category: BotCategory;
  pattern: RegExp;
}

export const CRAWLER_LIST_VERSION = '2026-10-15';

export const CRAWLERS: readonly CrawlerEntry[] = [
  // AI assistants fetching pages to answer a user (live retrieval / AI search).
  { name: 'ChatGPT-User', provider: 'OpenAI', category: 'ai_answers', pattern: /ChatGPT-User/i },
  { name: 'OAI-SearchBot', provider: 'OpenAI', category: 'ai_answers', pattern: /OAI-SearchBot/i },
  { name: 'Claude-User', provider: 'Anthropic', category: 'ai_answers', pattern: /Claude-User/i },
  {
    name: 'Claude-SearchBot',
    provider: 'Anthropic',
    category: 'ai_answers',
    pattern: /Claude-SearchBot/i,
  },
  {
    name: 'Perplexity-User',
    provider: 'Perplexity',
    category: 'ai_answers',
    pattern: /Perplexity-User/i,
  },
  {
    name: 'PerplexityBot',
    provider: 'Perplexity',
    category: 'ai_answers',
    pattern: /PerplexityBot/i,
  },
  {
    name: 'MistralAI-User',
    provider: 'Mistral',
    category: 'ai_answers',
    pattern: /MistralAI-User/i,
  },
  {
    name: 'DuckAssistBot',
    provider: 'DuckDuckGo',
    category: 'ai_answers',
    pattern: /DuckAssistBot/i,
  },
  {
    name: 'Google-Agent',
    provider: 'Google',
    category: 'ai_answers',
    pattern: /Google-Agent|GoogleAgent/i,
  },
  { name: 'YouBot', provider: 'You.com', category: 'ai_answers', pattern: /YouBot/i },
  { name: 'Phind', provider: 'Phind', category: 'ai_answers', pattern: /PhindBot/i },
  // Model training crawlers.
  { name: 'GPTBot', provider: 'OpenAI', category: 'training', pattern: /GPTBot/i },
  {
    name: 'ClaudeBot',
    provider: 'Anthropic',
    category: 'training',
    pattern: /ClaudeBot|anthropic-ai|Claude-Web/i,
  },
  { name: 'CCBot', provider: 'Common Crawl', category: 'training', pattern: /CCBot/i },
  { name: 'Bytespider', provider: 'ByteDance', category: 'training', pattern: /Bytespider/i },
  {
    name: 'Meta-ExternalAgent',
    provider: 'Meta',
    category: 'training',
    pattern: /meta-externalagent|FacebookBot/i,
  },
  {
    name: 'Applebot-Extended',
    provider: 'Apple',
    category: 'training',
    pattern: /Applebot-Extended/i,
  },
  {
    name: 'Google-CloudVertexBot',
    provider: 'Google',
    category: 'training',
    pattern: /Google-CloudVertexBot/i,
  },
  { name: 'Amazonbot', provider: 'Amazon', category: 'training', pattern: /Amazonbot/i },
  {
    name: 'cohere-ai',
    provider: 'Cohere',
    category: 'training',
    pattern: /cohere-(ai|training-data-crawler)/i,
  },
  { name: 'Diffbot', provider: 'Diffbot', category: 'training', pattern: /Diffbot/i },
  { name: 'AI2Bot', provider: 'Allen Institute', category: 'training', pattern: /AI2Bot/i },
  { name: 'Timpibot', provider: 'Timpi', category: 'training', pattern: /Timpibot/i },
  { name: 'omgili', provider: 'Webz.io', category: 'training', pattern: /omgili/i },
  // Search engine indexing.
  {
    name: 'Googlebot',
    provider: 'Google',
    category: 'indexing',
    pattern: /Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google/i,
  },
  {
    name: 'Bingbot',
    provider: 'Microsoft',
    category: 'indexing',
    pattern: /bingbot|BingPreview|adidxbot/i,
  },
  { name: 'Applebot', provider: 'Apple', category: 'indexing', pattern: /Applebot/i },
  {
    name: 'YandexBot',
    provider: 'Yandex',
    category: 'indexing',
    pattern: /YandexBot|YandexMobileBot/i,
  },
  { name: 'Baiduspider', provider: 'Baidu', category: 'indexing', pattern: /Baiduspider/i },
  { name: 'DuckDuckBot', provider: 'DuckDuckGo', category: 'indexing', pattern: /DuckDuckBot/i },
  { name: 'SeznamBot', provider: 'Seznam', category: 'indexing', pattern: /SeznamBot/i },
  { name: 'Qwantbot', provider: 'Qwant', category: 'indexing', pattern: /Qwantbot|Qwantify/i },
  { name: 'Yeti', provider: 'Naver', category: 'indexing', pattern: /\bYeti\//i },
  { name: 'PetalBot', provider: 'Huawei', category: 'indexing', pattern: /PetalBot/i },
  { name: 'Mojeek', provider: 'Mojeek', category: 'indexing', pattern: /MojeekBot/i },
  // SEO tools, link previews, monitoring and generic automation.
  {
    name: 'AhrefsBot',
    provider: 'Ahrefs',
    category: 'other',
    pattern: /AhrefsBot|AhrefsSiteAudit/i,
  },
  { name: 'SemrushBot', provider: 'Semrush', category: 'other', pattern: /SemrushBot/i },
  { name: 'MJ12bot', provider: 'Majestic', category: 'other', pattern: /MJ12bot/i },
  { name: 'DotBot', provider: 'Moz', category: 'other', pattern: /DotBot|rogerbot/i },
  {
    name: 'Screaming Frog',
    provider: 'Screaming Frog',
    category: 'other',
    pattern: /Screaming Frog/i,
  },
  {
    name: 'facebookexternalhit',
    provider: 'Meta',
    category: 'other',
    pattern: /facebookexternalhit|facebookcatalog/i,
  },
  { name: 'Twitterbot', provider: 'X', category: 'other', pattern: /Twitterbot/i },
  { name: 'LinkedInBot', provider: 'LinkedIn', category: 'other', pattern: /LinkedInBot/i },
  { name: 'Slackbot', provider: 'Slack', category: 'other', pattern: /Slackbot|Slack-ImgProxy/i },
  { name: 'Discordbot', provider: 'Discord', category: 'other', pattern: /Discordbot/i },
  { name: 'TelegramBot', provider: 'Telegram', category: 'other', pattern: /TelegramBot/i },
  { name: 'WhatsApp', provider: 'Meta', category: 'other', pattern: /WhatsApp\//i },
  { name: 'UptimeRobot', provider: 'UptimeRobot', category: 'other', pattern: /UptimeRobot/i },
  { name: 'Pingdom', provider: 'Pingdom', category: 'other', pattern: /Pingdom/i },
  {
    name: 'Lighthouse',
    provider: 'Google',
    category: 'other',
    pattern: /Chrome-Lighthouse|Google Page Speed/i,
  },
];

const GENERIC_BOT =
  /(?:^|[^a-z])bot\b|bot[/;@]|crawl|spider|slurp|headless|phantomjs|selenium|puppeteer|playwright|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|wget|curl\/|node-fetch|axios\/|undici|scrapy|httpclient|feedfetcher|preview/i;

export interface BotMatch {
  name: string;
  provider: string;
  category: BotCategory;
}

/** Classifies a user agent; null for regular browsers. An empty UA counts as a bot. */
export function detectBot(userAgent: string | null | undefined): BotMatch | null {
  const ua = (userAgent ?? '').trim();
  if (ua === '') return { name: 'Empty user agent', provider: 'Unknown', category: 'other' };
  for (const entry of CRAWLERS) {
    if (entry.pattern.test(ua))
      return { name: entry.name, provider: entry.provider, category: entry.category };
  }
  if (GENERIC_BOT.test(ua) || !/Mozilla\/|Opera\//.test(ua)) {
    return { name: 'Other bot', provider: 'Unknown', category: 'other' };
  }
  return null;
}
