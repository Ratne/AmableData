import type { CustomTrackingField, TrafficSourceTemplateDef } from '@amable/api-types';

/**
 * Starting points of `POST /traffic-sources`. Source tokens are the platforms'
 * own URL macros, resolved by the platform at click time. Click ids the
 * platforms append by themselves (fbclid, gclid with auto-tagging, ttclid) are
 * captured from the landing URL but never appended to generated links.
 */

function field(slot: number, name: string, urlParam: string, sourceToken: string, append = true): CustomTrackingField {
  return { slot: `c${slot}`, name, url_param: urlParam, source_token: sourceToken, append };
}

const meta: TrafficSourceTemplateDef = {
  template: 'meta',
  name: 'Meta Ads',
  source: {
    name: 'Meta Ads',
    category: 'Social',
    template: 'meta',
    cost_type: 'cpc',
    skip_zero_revenue_postbacks: false,
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '{{campaign.id}}', append: true },
      external: { url_param: 'fbclid', source_token: '', append: false },
    },
    fields: [
      field(1, 'adset', 'adset', '{{adset.id}}'),
      field(2, 'ad', 'ad', '{{ad.id}}'),
      field(3, 'campaign_name', 'campaign_name', '{{campaign.name}}'),
      field(4, 'adset_name', 'adset_name', '{{adset.name}}'),
      field(5, 'ad_name', 'ad_name', '{{ad.name}}'),
      field(6, 'placement', 'placement', '{{placement}}'),
      field(7, 'site_source', 'site_source', '{{site_source_name}}'),
    ],
    conversion: {
      platform: 'meta',
      mapping: [
        { event: 'sale', platform_event: 'Purchase' },
        { event: 'lead', platform_event: 'Lead' },
      ],
    },
  },
};

const google: TrafficSourceTemplateDef = {
  template: 'google',
  name: 'Google Ads',
  source: {
    name: 'Google Ads',
    category: 'Search',
    template: 'google',
    cost_type: 'cpc',
    skip_zero_revenue_postbacks: false,
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '{campaignid}', append: true },
      external: { url_param: 'gclid', source_token: '', append: false },
    },
    fields: [
      field(1, 'adgroup', 'adgroup', '{adgroupid}'),
      field(2, 'creative', 'creative', '{creative}'),
      field(3, 'keyword', 'keyword', '{keyword}'),
      field(4, 'matchtype', 'matchtype', '{matchtype}'),
      field(5, 'device', 'device', '{device}'),
      field(6, 'network', 'network', '{network}'),
      field(7, 'placement', 'placement', '{placement}'),
      // iOS app-to-web click ids, added by auto-tagging instead of gclid.
      field(8, 'gbraid', 'gbraid', '', false),
      field(9, 'wbraid', 'wbraid', '', false),
    ],
    conversion: { platform: 'google', mapping: [] },
  },
};

const tiktok: TrafficSourceTemplateDef = {
  template: 'tiktok',
  name: 'TikTok Ads',
  source: {
    name: 'TikTok Ads',
    category: 'Social',
    template: 'tiktok',
    cost_type: 'cpc',
    skip_zero_revenue_postbacks: false,
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '__CAMPAIGN_ID__', append: true },
      external: { url_param: 'ttclid', source_token: '', append: false },
    },
    fields: [
      field(1, 'adgroup', 'adgroup', '__AID__'),
      field(2, 'ad', 'ad', '__CID__'),
      field(3, 'campaign_name', 'campaign_name', '__CAMPAIGN_NAME__'),
      field(4, 'adgroup_name', 'adgroup_name', '__AID_NAME__'),
      field(5, 'ad_name', 'ad_name', '__CID_NAME__'),
      field(6, 'placement', 'placement', '__PLACEMENT__'),
    ],
    conversion: {
      platform: 'tiktok',
      mapping: [
        { event: 'sale', platform_event: 'CompletePayment' },
        { event: 'lead', platform_event: 'SubmitForm' },
      ],
    },
  },
};

const custom: TrafficSourceTemplateDef = {
  template: 'custom',
  name: 'Custom',
  source: {
    name: 'Custom source',
    template: 'custom',
    cost_type: 'cpc',
    skip_zero_revenue_postbacks: false,
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '', append: true },
      external: { url_param: 'external', source_token: '', append: true },
    },
    fields: [],
    conversion: { mapping: [] },
  },
};

export const TRAFFIC_SOURCE_TEMPLATE_DEFS: readonly TrafficSourceTemplateDef[] = [meta, google, tiktok, custom];
