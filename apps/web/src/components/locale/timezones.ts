/** Used when the runtime cannot enumerate IANA zones (`Intl.supportedValuesOf`). */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Addis_Ababa',
  'Africa/Algiers',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Dakar',
  'Africa/Dar_es_Salaam',
  'Africa/Johannesburg',
  'Africa/Kinshasa',
  'Africa/Lagos',
  'Africa/Luanda',
  'Africa/Nairobi',
  'Africa/Tripoli',
  'Africa/Tunis',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Caracas',
  'America/Chicago',
  'America/Denver',
  'America/Guatemala',
  'America/Halifax',
  'America/Havana',
  'America/La_Paz',
  'America/Lima',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Montevideo',
  'America/New_York',
  'America/Panama',
  'America/Phoenix',
  'America/Puerto_Rico',
  'America/Santiago',
  'America/Santo_Domingo',
  'America/Sao_Paulo',
  'America/St_Johns',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Almaty',
  'Asia/Baghdad',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Kabul',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Kuala_Lumpur',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tashkent',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Asia/Yangon',
  'Atlantic/Azores',
  'Atlantic/Canary',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Bucharest',
  'Europe/Budapest',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Kyiv',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Prague',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Indian/Maldives',
  'Indian/Mauritius',
  'Pacific/Auckland',
  'Pacific/Fiji',
  'Pacific/Guam',
  'Pacific/Honolulu',
  'Pacific/Port_Moresby',
  'UTC',
];

export const TIME_ZONE_REGIONS = [
  'Africa',
  'America',
  'Antarctica',
  'Arctic',
  'Asia',
  'Atlantic',
  'Australia',
  'Europe',
  'Indian',
  'Pacific',
  'Other',
] as const;
export type TimeZoneRegion = (typeof TIME_ZONE_REGIONS)[number];

export interface TimeZoneOption {
  readonly id: string;
  readonly region: TimeZoneRegion;
  /** `Argentina / Buenos Aires` for `America/Argentina/Buenos_Aires`. */
  readonly city: string;
  readonly offsetMinutes: number;
  /** `UTC+02:00`. */
  readonly offset: string;
}

export function supportedTimeZones(): string[] {
  let list: string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = [];
  }
  if (list.length === 0) list = [...FALLBACK_TIME_ZONES];
  return list.includes('UTC') ? list : [...list, 'UTC'];
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  let format = formatters.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      format = null;
    }
    formatters.set(zone, format);
  }
  return format;
}

/** Minutes east of UTC observed in `zone` at `at`; null for an unknown zone. */
export function timeZoneOffsetMinutes(zone: string, at: Date = new Date()): number | null {
  const format = formatterFor(zone);
  if (format === null) return null;
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const local = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const utc = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((local - utc) / 60_000);
}

/** `UTC+02:00`, `UTC-03:30`, `UTC+00:00`. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${mins}`;
}

/** Search aliases for an offset: `UTC+2`, `GMT+2`, `+02:00`, `UTC+5:45`. */
export function offsetKeywords(minutes: number): string[] {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const short = `${String(Math.floor(abs / 60))}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  return [`UTC${sign}${short}`, `GMT${sign}${short}`, formatUtcOffset(minutes).slice(3)];
}

export function timeZoneRegion(zone: string): TimeZoneRegion {
  const head = zone.split('/')[0] ?? '';
  return (TIME_ZONE_REGIONS as readonly string[]).includes(head) && zone.includes('/')
    ? (head as TimeZoneRegion)
    : 'Other';
}

export function timeZoneCity(zone: string): string {
  const parts = zone.split('/');
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  return rest.join(' / ').replace(/_/g, ' ');
}

/** `Europe/Rome (UTC+02:00)`; the bare id when the zone is unknown. */
export function timeZoneLabel(zone: string, at: Date = new Date()): string {
  const minutes = timeZoneOffsetMinutes(zone, at);
  const name = zone.replace(/_/g, ' ');
  return minutes === null ? name : `${name} (${formatUtcOffset(minutes)})`;
}

/** Every known zone (plus `extra`, e.g. a legacy stored id), grouped by region then city. */
export function timeZoneOptions(at: Date = new Date(), extra?: string | null): TimeZoneOption[] {
  const ids = supportedTimeZones();
  if (extra && !ids.includes(extra)) ids.push(extra);
  const options: TimeZoneOption[] = ids.map((id) => {
    const offsetMinutes = timeZoneOffsetMinutes(id, at) ?? 0;
    return {
      id,
      region: timeZoneRegion(id),
      city: timeZoneCity(id),
      offsetMinutes,
      offset: formatUtcOffset(offsetMinutes),
    };
  });
  const order = (region: TimeZoneRegion) => TIME_ZONE_REGIONS.indexOf(region);
  return options.sort(
    (a, b) => order(a.region) - order(b.region) || a.city.localeCompare(b.city, 'en'),
  );
}
