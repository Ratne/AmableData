import { searchableFilter } from '@amable/ui/blocks/searchable-select';
import { describe, expect, it } from 'vitest';
import {
  ISO_639_1,
  fallbackLanguageName,
  languageName,
  languageOptions,
} from '../src/components/locale/languages';
import {
  PHONE_COUNTRIES,
  composeE164,
  defaultPhoneCountry,
  flagEmoji,
  formatDial,
  isE164,
  normalizePhone,
  parsePhone,
  phoneDisplay,
} from '../src/components/locale/phone-countries';
import {
  formatUtcOffset,
  offsetKeywords,
  supportedTimeZones,
  timeZoneCity,
  timeZoneLabel,
  timeZoneOffsetMinutes,
  timeZoneOptions,
  timeZoneRegion,
} from '../src/components/locale/timezones';

const SUMMER = new Date('2026-07-01T12:00:00Z');
const WINTER = new Date('2026-01-15T12:00:00Z');

describe('time zones', () => {
  it('formats UTC offsets with sign, hours and minutes', () => {
    expect(formatUtcOffset(120)).toBe('UTC+02:00');
    expect(formatUtcOffset(0)).toBe('UTC+00:00');
    expect(formatUtcOffset(-210)).toBe('UTC-03:30');
    expect(formatUtcOffset(345)).toBe('UTC+05:45');
    expect(formatUtcOffset(-600)).toBe('UTC-10:00');
  });

  it('computes offsets including daylight saving time', () => {
    expect(timeZoneOffsetMinutes('Europe/Rome', SUMMER)).toBe(120);
    expect(timeZoneOffsetMinutes('Europe/Rome', WINTER)).toBe(60);
    expect(timeZoneOffsetMinutes('America/New_York', WINTER)).toBe(-300);
    expect(timeZoneOffsetMinutes('Asia/Kathmandu', SUMMER)).toBe(345);
    expect(timeZoneOffsetMinutes('UTC', SUMMER)).toBe(0);
    expect(timeZoneOffsetMinutes('Not/AZone', SUMMER)).toBeNull();
  });

  it('labels zones as id + offset', () => {
    expect(timeZoneLabel('Europe/Rome', SUMMER)).toBe('Europe/Rome (UTC+02:00)');
    expect(timeZoneLabel('America/Argentina/Buenos_Aires', SUMMER)).toBe(
      'America/Argentina/Buenos Aires (UTC-03:00)',
    );
    expect(timeZoneLabel('Legacy/Zone', SUMMER)).toBe('Legacy/Zone');
  });

  it('derives region, city and search aliases', () => {
    expect(timeZoneRegion('Europe/Rome')).toBe('Europe');
    expect(timeZoneRegion('UTC')).toBe('Other');
    expect(timeZoneRegion('Etc/GMT+5')).toBe('Other');
    expect(timeZoneCity('America/Argentina/Buenos_Aires')).toBe('Argentina / Buenos Aires');
    expect(offsetKeywords(120)).toEqual(['UTC+2', 'GMT+2', '+02:00']);
    expect(offsetKeywords(-210)).toEqual(['UTC-3:30', 'GMT-3:30', '-03:30']);
  });

  it('lists every runtime zone plus UTC, grouped by region then city', () => {
    const zones = supportedTimeZones();
    expect(zones.length).toBeGreaterThan(300);
    expect(zones).toContain('UTC');
    const options = timeZoneOptions(SUMMER);
    expect(options).toHaveLength(zones.length);
    const rome = options.find((o) => o.id === 'Europe/Rome');
    expect(rome).toMatchObject({ region: 'Europe', city: 'Rome', offset: 'UTC+02:00' });
    const regions = options.map((o) => o.region);
    expect(regions.indexOf('Africa')).toBe(0);
    expect(regions[regions.length - 1]).toBe('Other');
    const europe = options.filter((o) => o.region === 'Europe').map((o) => o.city);
    expect(europe).toEqual([...europe].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('keeps a stored zone the runtime does not list', () => {
    expect(timeZoneOptions(SUMMER, 'Legacy/Zone').some((o) => o.id === 'Legacy/Zone')).toBe(true);
  });
});

describe('languages', () => {
  it('covers every ISO 639-1 code exactly once', () => {
    expect(ISO_639_1).toHaveLength(183);
    expect(new Set(ISO_639_1).size).toBe(ISO_639_1.length);
    for (const code of ISO_639_1) expect(code).toMatch(/^[a-z]{2}$/);
    for (const code of ['it', 'en', 'zh', 'sw', 'yo', 'zu', 'ar', 'he']) {
      expect(ISO_639_1).toContain(code);
    }
  });

  it('names languages in the UI language and sorts by that name', () => {
    const italian = languageOptions('it');
    expect(italian).toHaveLength(ISO_639_1.length);
    expect(italian.find((l) => l.code === 'de')?.name).toBe('Tedesco');
    expect(italian.find((l) => l.code === 'de')?.nativeName).toBe('Deutsch');
    const names = italian.map((l) => l.name);
    const collator = new Intl.Collator('it');
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
    for (const language of italian) expect(language.name.length).toBeGreaterThan(0);

    const english = languageOptions('en');
    expect(english.find((l) => l.code === 'de')?.name).toBe('German');
    expect(english[0]?.name.localeCompare(english[1]?.name ?? '', 'en')).toBeLessThanOrEqual(0);
  });

  it('has static names for codes missing from trimmed ICU builds', () => {
    const missingInChromium =
      'aa ab ae av ba bi bo ce ch cr cu cv dz ff fj gv ho hz ie ii ik io iu kg ki kj kl kr ks ' +
      'kv kw li lu mh na nd ng nr nv oj os pi rn sc se sg ss ty ve vo za';
    for (const code of missingInChromium.split(' ')) {
      expect(ISO_639_1).toContain(code);
      expect(fallbackLanguageName(code, 'it')).toBeTruthy();
      expect(fallbackLanguageName(code, 'en')).toBeTruthy();
    }
    expect(fallbackLanguageName('ss', 'it')).toBe('Swati');
    expect(fallbackLanguageName('kl', 'it')).toBe('Groenlandese');
    expect(fallbackLanguageName('de', 'it')).toBeUndefined();
  });

  it('keeps a stored BCP-47 tag and names it', () => {
    const options = languageOptions('en', 'pt-BR');
    expect(options).toHaveLength(ISO_639_1.length + 1);
    expect(languageName('pt-BR', 'en')).toMatch(/Portuguese/);
  });
});

describe('searchable select filter', () => {
  const rome = ['Rome', 'UTC+02:00', 'Europe/Rome', 'UTC+2', 'GMT+2', '+02:00'];
  const sydney = ['Sydney', 'UTC+10:00', 'Australia/Sydney', 'UTC+10', 'GMT+10', '+10:00'];
  const monrovia = ['Monrovia', 'UTC+00:00', 'Africa/Monrovia', 'UTC+0', 'GMT+0', '+00:00'];

  it('matches substrings case- and accent-insensitively', () => {
    expect(searchableFilter('Europe/Rome', 'rome', rome)).toBe(1);
    expect(searchableFilter('Africa/Monrovia', 'rome', monrovia)).toBe(0);
    expect(searchableFilter('es', 'espanol', ['Español'])).toBe(1);
    expect(searchableFilter('Europe/Rome', 'europe rome', rome)).toBeGreaterThan(0);
    expect(searchableFilter('Europe/Rome', '', rome)).toBe(1);
  });

  it('matches UTC/GMT offsets as whole words', () => {
    expect(searchableFilter('Europe/Rome', 'UTC+2', rome)).toBeGreaterThan(0);
    expect(searchableFilter('Australia/Sydney', 'utc+1', sydney)).toBe(0);
    expect(searchableFilter('Australia/Sydney', 'gmt+10', sydney)).toBeGreaterThan(0);
  });

  it('ranks label prefix, then exact keyword, then other hits', () => {
    const italy = ['Italia', '+39', 'IT', 'Italy', '39', '+39'];
    const ireland = ['Irlanda', '+353', 'IE', 'Ireland', '353', '+353'];
    expect(searchableFilter('IT', 'ita', italy)).toBe(1);
    expect(searchableFilter('IT', '+39', italy)).toBe(0.9);
    expect(searchableFilter('IE', '+3', ireland)).toBe(0.5);
  });
});

describe('phone numbers', () => {
  it('has a complete ISO 3166 dial-code table', () => {
    expect(PHONE_COUNTRIES.length).toBeGreaterThanOrEqual(245);
    const codes = PHONE_COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const country of PHONE_COUNTRIES) {
      expect(country.code).toMatch(/^[A-Z]{2}$/);
      for (const dial of country.dials) expect(dial).toMatch(/^[1-9]\d{0,3}$/);
    }
  });

  it('builds flag emoji from regional indicators', () => {
    expect(flagEmoji('IT')).toBe('🇮🇹');
    expect(flagEmoji('us')).toBe('🇺🇸');
    expect(flagEmoji('')).toBe('🌐');
  });

  it('formats NANP area-code dials', () => {
    expect(formatDial('39')).toBe('+39');
    expect(formatDial('1242')).toBe('+1 242');
  });

  it('parses the country by longest calling-code prefix', () => {
    expect(parsePhone('+393331234567', 'US')).toEqual({
      country: 'IT',
      national: '3331234567',
      matched: true,
    });
    expect(parsePhone('+12425551234', 'IT')).toMatchObject({ country: 'BS', national: '5551234' });
    expect(parsePhone('+18095551234', 'IT')).toMatchObject({ country: 'DO', national: '5551234' });
    expect(parsePhone('+35312345678', 'IT')).toMatchObject({ country: 'IE', national: '12345678' });
    expect(parsePhone('+3581234567', 'IT')).toMatchObject({ country: 'FI', national: '1234567' });
    expect(parsePhone('0044 20 7946 0958', 'IT')).toMatchObject({
      country: 'GB',
      national: '2079460958',
    });
  });

  it('resolves a shared calling code to the preferred, then primary country', () => {
    expect(parsePhone('+12125551234', 'IT').country).toBe('US');
    expect(parsePhone('+16135551234', 'CA').country).toBe('CA');
    expect(parsePhone('+74951234567', 'IT').country).toBe('RU');
    expect(parsePhone('+77011234567', 'KZ').country).toBe('KZ');
    expect(parsePhone('+390669812345', 'VA').country).toBe('VA');
  });

  it('falls back to the given country for numbers without a prefix', () => {
    expect(parsePhone('333 123 4567', 'IT')).toEqual({
      country: 'IT',
      national: '3331234567',
      matched: false,
    });
  });

  it('composes E.164, dropping the trunk 0 only where it is not dialled', () => {
    expect(composeE164('IT', '333 123 4567')).toBe('+393331234567');
    expect(composeE164('IT', '06 1234 5678')).toBe('+390612345678');
    expect(composeE164('GB', '07911 123456')).toBe('+447911123456');
    expect(composeE164('DE', '030 123456')).toBe('+4930123456');
    expect(composeE164('BS', '555-1234')).toBe('+12425551234');
    expect(composeE164('IT', '')).toBe('');
  });

  it('validates E.164 length and shape', () => {
    expect(isE164('+393331234567')).toBe(true);
    expect(isE164('+1234')).toBe(true);
    expect(isE164('+123')).toBe(false);
    expect(isE164('+1234567890123456')).toBe(false);
    expect(isE164('+0393331234')).toBe(false);
    expect(isE164('393331234567')).toBe(false);
    expect(isE164('+39 333 1234567')).toBe(false);
  });

  it('normalizes stored and legacy numbers', () => {
    expect(normalizePhone('+39 333 123 4567', 'US')).toBe('+393331234567');
    expect(normalizePhone('0039 333 1234567', 'US')).toBe('+393331234567');
    expect(normalizePhone('333 1234567', 'IT')).toBe('+393331234567');
    expect(normalizePhone('(212) 555-1234', 'US')).toBe('+12125551234');
  });

  it('splits stored numbers for display', () => {
    expect(phoneDisplay('+393331234567')).toEqual({ country: 'IT', text: '+39 3331234567' });
    expect(phoneDisplay('+12425551234')).toEqual({ country: 'BS', text: '+1 242 5551234' });
    expect(phoneDisplay('02 1234567')).toEqual({ country: null, text: '02 1234567' });
  });

  it('picks the default country from the UI and browser languages', () => {
    expect(defaultPhoneCountry('it', ['it-IT', 'en-US'])).toBe('IT');
    expect(defaultPhoneCountry('it', ['en-US'])).toBe('IT');
    expect(defaultPhoneCountry('it', ['it-CH'])).toBe('CH');
    expect(defaultPhoneCountry('en', ['en-GB'])).toBe('GB');
    expect(defaultPhoneCountry('en', [])).toBe('US');
  });
});
