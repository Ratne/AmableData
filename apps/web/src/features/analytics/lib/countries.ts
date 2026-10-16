/** Flag emoji of an ISO 3166-1 alpha-2 code (regional indicator symbols); globe for unknowns. */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '🌐';
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + upper.charCodeAt(0) - 65,
    0x1f1e6 + upper.charCodeAt(1) - 65,
  );
}

const nameCache = new Map<string, Intl.DisplayNames | null>();

export function countryName(code: string | null | undefined, locale: string): string {
  if (!code) return '';
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  let names = nameCache.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    nameCache.set(locale, names);
  }
  try {
    return names?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Approximate country centroids `[lat, lon]`, for the flat map and globe fallbacks. */
const CENTROIDS_RAW =
  'US:39,-98 CA:57,-101 MX:23,-102 BR:-10,-52 AR:-35,-65 CL:-31,-71 CO:4,-73 PE:-10,-76 VE:7,-66 EC:-1,-78 ' +
  'BO:-17,-64 PY:-23,-58 UY:-33,-56 CU:22,-79 DO:19,-70 GT:15,-90 CR:10,-84 PA:9,-80 PR:18,-66 ' +
  'GB:54,-2 IE:53,-8 FR:46,2 ES:40,-4 PT:39.5,-8 IT:42.8,12.5 DE:51,10 NL:52.2,5.5 BE:50.6,4.6 LU:49.8,6.1 ' +
  'CH:46.8,8.2 AT:47.5,14.5 DK:56,10 NO:61,9 SE:62,15 FI:64,26 IS:65,-18 PL:52,19 CZ:49.8,15.5 SK:48.7,19.7 ' +
  'HU:47.2,19.5 RO:46,25 BG:42.7,25.5 GR:39,22 HR:45.1,15.5 SI:46.1,14.8 RS:44,21 BA:44,17.8 AL:41,20 ' +
  'MK:41.6,21.7 ME:42.8,19.3 UA:49,32 BY:53.7,28 LT:55.2,24 LV:56.9,24.6 EE:58.6,25 MD:47.2,28.5 ' +
  'RU:60,90 TR:39,35 CY:35,33 MT:35.9,14.4 IL:31.4,35 PS:31.9,35.2 LB:33.9,35.9 JO:31,36 SY:35,38 IQ:33,44 ' +
  'IR:32,53 SA:24,45 AE:24,54 QA:25.3,51.2 KW:29.3,47.6 BH:26,50.5 OM:21,57 YE:15.5,48 EG:26.5,30 ' +
  'MA:32,-6 DZ:28,2 TN:34,9 LY:27,17 SD:15,30 ET:9,39 KE:0.5,38 TZ:-6,35 UG:1.3,32.3 RW:-2,30 NG:9,8 ' +
  'GH:8,-1 CI:7.5,-5.5 SN:14.5,-14.5 CM:5.7,12.7 ZA:-29,24 NA:-22,17 BW:-22,24 ZW:-19,29.8 ZM:-13.5,27.8 ' +
  'MZ:-18,35 AO:-12,17.5 CD:-3,23 MG:-19,46.7 MU:-20.3,57.6 IN:22,79 PK:30,70 BD:24,90 LK:7.8,80.7 NP:28.4,84 ' +
  'AF:34,66 KZ:48,67 UZ:41.5,64 GE:42.2,43.5 AM:40.2,45 AZ:40.3,47.7 CN:35,103 HK:22.3,114.2 TW:23.7,121 ' +
  'JP:36.5,138.5 KR:36.3,127.8 MN:46.8,103 VN:16,107.8 TH:15,101 MY:3.5,102 SG:1.35,103.8 ID:-2.5,118 ' +
  'PH:12.5,122 KH:12.6,105 MM:21,96 AU:-25,134 NZ:-41.5,172.5';

export const COUNTRY_CENTROIDS: ReadonlyMap<string, readonly [number, number]> = new Map(
  CENTROIDS_RAW.split(' ').map((entry) => {
    const [code = '', coords = ''] = entry.split(':');
    const [lat = '0', lon = '0'] = coords.split(',');
    return [code, [Number(lat), Number(lon)] as const];
  }),
);
