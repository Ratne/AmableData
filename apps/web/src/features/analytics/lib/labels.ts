import type {
  AnalyticsBreakdownDimension,
  AnalyticsFilter,
  AnalyticsInterval,
  AttributionModel,
} from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import type { RangePreset } from './range';

export type Translate = (
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
) => string;

const DIMENSION_KEYS: Record<AnalyticsBreakdownDimension, MessageKey> = {
  channel: 'analytics.dim.channel',
  referrer: 'analytics.dim.referrer',
  source: 'analytics.dim.source',
  campaign: 'analytics.dim.campaign',
  utm_source: 'analytics.dim.utm_source',
  utm_medium: 'analytics.dim.utm_medium',
  utm_term: 'analytics.dim.utm_term',
  utm_content: 'analytics.dim.utm_content',
  country: 'analytics.dim.country',
  region: 'analytics.dim.region',
  city: 'analytics.dim.city',
  device: 'analytics.dim.device',
  browser: 'analytics.dim.browser',
  os: 'analytics.dim.os',
  hostname: 'analytics.dim.hostname',
  entry_page: 'analytics.dim.entry_page',
  exit_page: 'analytics.dim.exit_page',
  page: 'analytics.dim.page',
  goal: 'analytics.dim.goal',
  exit_link: 'analytics.dim.exit_link',
  bot: 'analytics.dim.bot',
  bot_category: 'analytics.dim.bot_category',
};

export function dimensionLabel(t: Translate, dimension: AnalyticsBreakdownDimension): string {
  return t(DIMENSION_KEYS[dimension]);
}

const MODEL_KEYS: Record<AttributionModel, MessageKey> = {
  first_touch: 'analytics.model.first_touch',
  last_non_direct: 'analytics.model.last_non_direct',
  linear: 'analytics.model.linear',
  last_touch: 'analytics.model.last_touch',
  position_based: 'analytics.model.position_based',
};

export function modelLabel(t: Translate, model: AttributionModel): string {
  return t(MODEL_KEYS[model]);
}

const PRESET_KEYS: Record<RangePreset, MessageKey> = {
  today: 'analytics.range.today',
  yesterday: 'analytics.range.yesterday',
  '7d': 'analytics.range.7d',
  '30d': 'analytics.range.30d',
  '90d': 'analytics.range.90d',
  month: 'analytics.range.month',
  '12m': 'analytics.range.12m',
  custom: 'analytics.range.custom',
};

export function presetLabel(t: Translate, preset: RangePreset): string {
  return t(PRESET_KEYS[preset]);
}

const INTERVAL_KEYS: Record<AnalyticsInterval, MessageKey> = {
  hour: 'analytics.interval.hour',
  day: 'analytics.interval.day',
  week: 'analytics.interval.week',
  month: 'analytics.interval.month',
};

export function intervalLabel(t: Translate, interval: AnalyticsInterval): string {
  return t(INTERVAL_KEYS[interval]);
}

const OP_KEYS: Record<AnalyticsFilter['op'], MessageKey> = {
  is: 'analytics.filter.is',
  is_not: 'analytics.filter.isNot',
  contains: 'analytics.filter.contains',
};

export function opLabel(t: Translate, op: AnalyticsFilter['op']): string {
  return t(OP_KEYS[op]);
}

const BOT_CATEGORY_KEYS: Record<string, MessageKey> = {
  ai_answers: 'analytics.bots.ai_answers',
  training: 'analytics.bots.training',
  indexing: 'analytics.bots.indexing',
  other: 'analytics.bots.other',
};

export function botCategoryLabel(t: Translate, category: string): string {
  const key = BOT_CATEGORY_KEYS[category.toLowerCase().replace(/[\s-]+/g, '_')];
  return key ? t(key) : category;
}
