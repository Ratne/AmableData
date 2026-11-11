import { describe, expect, it } from 'vitest';
import {
  AD_LINK_MACROS,
  AD_LINK_PLATFORMS,
  AD_PARAM_NAMES,
  adLink,
  appendParams,
  emailLink,
  isUnfilledMacro,
  SOURCE_PARAM_NAMES,
} from '../src';

describe('ad link vocabulary', () => {
  it('every platform carries at least the campaign and ad ids, all params captured by the tracker', () => {
    for (const platform of AD_LINK_PLATFORMS) {
      const keys = AD_LINK_MACROS[platform].map(([k]) => k);
      expect(keys).toContain('amb_cid');
      expect(keys).toContain('amb_adid');
      for (const k of keys) expect(SOURCE_PARAM_NAMES as readonly string[]).toContain(k);
    }
    for (const k of AD_PARAM_NAMES) expect(SOURCE_PARAM_NAMES as readonly string[]).toContain(k);
  });

  it('keeps macros unencoded and appends to existing queries and fragments', () => {
    expect(adLink('meta', '')).toContain('amb_adid={{ad.id}}');
    expect(adLink('google', 'https://a.com/x?y=1#top')).toMatch(
      /^https:\/\/a\.com\/x\?y=1&utm_source=google&.*amb_cid=\{campaignid\}.*#top$/,
    );
    expect(appendParams('https://a.com/?', [['a', '1']])).toBe('https://a.com/?a=1');
    expect(appendParams('https://a.com', [['a', '1']])).toBe('https://a.com?a=1');
  });

  it('builds email links with the provider merge tag on he', () => {
    expect(emailLink('mailchimp', 'https://a.com/', 'Black Friday')).toBe(
      'https://a.com/?he=*|EMAIL|*&utm_source=mailchimp&utm_medium=email&utm_campaign=Black_Friday&el=Black_Friday',
    );
    expect(emailLink('klaviyo', 'https://a.com/', '')).toBe(
      'https://a.com/?he={{ email }}&utm_source=klaviyo&utm_medium=email&el=email',
    );
  });

  it('recognises unfilled macros but not real ids', () => {
    for (const v of ['{{ad.id}}', '{campaignid}', '__CID__', '*|EMAIL|*', '%EMAIL%'])
      expect(isUnfilledMacro(v)).toBe(true);
    for (const v of ['120200000123', 'Feed', 'g', 'my_campaign_2'])
      expect(isUnfilledMacro(v)).toBe(false);
  });
});
