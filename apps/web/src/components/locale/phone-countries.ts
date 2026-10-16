/**
 * ISO 3166-1 alpha-2 countries and territories (plus XK) with their ITU calling
 * code. NANP members other than US/CA carry their area code (`1242` = +1 242)
 * so a stored E.164 number resolves to the right island.
 */
const DIAL_TABLE =
  'AD:376 AE:971 AF:93 AG:1268 AI:1264 AL:355 AM:374 AO:244 AQ:672 AR:54 AS:1684 AT:43 AU:61 ' +
  'AW:297 AX:358 AZ:994 BA:387 BB:1246 BD:880 BE:32 BF:226 BG:359 BH:973 BI:257 BJ:229 BL:590 ' +
  'BM:1441 BN:673 BO:591 BQ:599 BR:55 BS:1242 BT:975 BV:47 BW:267 BY:375 BZ:501 CA:1 CC:61 ' +
  'CD:243 CF:236 CG:242 CH:41 CI:225 CK:682 CL:56 CM:237 CN:86 CO:57 CR:506 CU:53 CV:238 CW:599 ' +
  'CX:61 CY:357 CZ:420 DE:49 DJ:253 DK:45 DM:1767 DO:1809,1829,1849 DZ:213 EC:593 EE:372 EG:20 ' +
  'EH:212 ER:291 ES:34 ET:251 FI:358 FJ:679 FK:500 FM:691 FO:298 FR:33 GA:241 GB:44 GD:1473 ' +
  'GE:995 GF:594 GG:44 GH:233 GI:350 GL:299 GM:220 GN:224 GP:590 GQ:240 GR:30 GS:500 GT:502 ' +
  'GU:1671 GW:245 GY:592 HK:852 HM:672 HN:504 HR:385 HT:509 HU:36 ID:62 IE:353 IL:972 IM:44 ' +
  'IN:91 IO:246 IQ:964 IR:98 IS:354 IT:39 JE:44 JM:1876,1658 JO:962 JP:81 KE:254 KG:996 KH:855 ' +
  'KI:686 KM:269 KN:1869 KP:850 KR:82 KW:965 KY:1345 KZ:7 LA:856 LB:961 LC:1758 LI:423 LK:94 ' +
  'LR:231 LS:266 LT:370 LU:352 LV:371 LY:218 MA:212 MC:377 MD:373 ME:382 MF:590 MG:261 MH:692 ' +
  'MK:389 ML:223 MM:95 MN:976 MO:853 MP:1670 MQ:596 MR:222 MS:1664 MT:356 MU:230 MV:960 MW:265 ' +
  'MX:52 MY:60 MZ:258 NA:264 NC:687 NE:227 NF:672 NG:234 NI:505 NL:31 NO:47 NP:977 NR:674 ' +
  'NU:683 NZ:64 OM:968 PA:507 PE:51 PF:689 PG:675 PH:63 PK:92 PL:48 PM:508 PN:64 PR:1787,1939 ' +
  'PS:970 PT:351 PW:680 PY:595 QA:974 RE:262 RO:40 RS:381 RU:7 RW:250 SA:966 SB:677 SC:248 ' +
  'SD:249 SE:46 SG:65 SH:290 SI:386 SJ:47 SK:421 SL:232 SM:378 SN:221 SO:252 SR:597 SS:211 ' +
  'ST:239 SV:503 SX:1721 SY:963 SZ:268 TC:1649 TD:235 TF:262 TG:228 TH:66 TJ:992 TK:690 TL:670 ' +
  'TM:993 TN:216 TO:676 TR:90 TT:1868 TV:688 TW:886 TZ:255 UA:380 UG:256 UM:1 US:1 UY:598 ' +
  'UZ:998 VA:39,379 VC:1784 VE:58 VG:1284 VI:1340 VN:84 WF:681 WS:685 XK:383 YE:967 YT:262 ' +
  'ZA:27 ZM:260 ZW:263';

export interface PhoneCountry {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  /** Calling code digits; the first one is shown in the picker. */
  readonly dials: readonly string[];
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = DIAL_TABLE.split(' ').map((entry) => {
  const [code = '', dials = ''] = entry.split(':');
  return { code, dials: dials.split(',') };
});

const BY_CODE = new Map(PHONE_COUNTRIES.map((country) => [country.code, country]));

/** Countries that win a shared calling code when nothing else disambiguates. */
const PRIMARY = new Set([
  'US',
  'RU',
  'GB',
  'NO',
  'AU',
  'MA',
  'RE',
  'FI',
  'IT',
  'FK',
  'GP',
  'CW',
  'NZ',
  'NF',
]);

const BY_DIAL = new Map<string, string[]>();
for (const country of PHONE_COUNTRIES) {
  for (const dial of country.dials) {
    const list = BY_DIAL.get(dial) ?? [];
    list.push(country.code);
    BY_DIAL.set(dial, list);
  }
}
const MAX_DIAL_LENGTH = Math.max(...[...BY_DIAL.keys()].map((dial) => dial.length));

/** Numbering plans whose leading 0 is part of the subscriber number. */
const KEEPS_LEADING_ZERO = new Set(['IT', 'VA', 'SM', 'CI', 'CG']);

export function phoneCountry(code: string): PhoneCountry | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export function primaryDial(code: string): string {
  return phoneCountry(code)?.dials[0] ?? '';
}

/** `+39`, or `+1 242` for NANP members dialled with their area code. */
export function formatDial(dial: string): string {
  return dial.length === 4 && dial.startsWith('1') ? `+1 ${dial.slice(1)}` : `+${dial}`;
}

/** Flag emoji from regional indicator symbols. */
export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '🌐';
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + upper.charCodeAt(0) - 65,
    0x1f1e6 + upper.charCodeAt(1) - 65,
  );
}

const regionNames = new Map<string, Intl.DisplayNames | null>();

/** Country name in `locale` (Intl.DisplayNames 'region'); the code when unknown. */
export function regionName(code: string, locale: string): string {
  let names = regionNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    } catch {
      names = null;
    }
    regionNames.set(locale, names);
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface ParsedPhone {
  readonly country: string;
  /** Digits after the calling code (or the raw digits when no prefix was found). */
  readonly national: string;
  /** True when the country came from the number's own `+` prefix. */
  readonly matched: boolean;
}

/**
 * Splits a stored number into country + national part by longest calling-code
 * prefix. A shared code resolves to `preferred` when it is one of the
 * candidates, else to the primary country of that code.
 */
export function parsePhone(value: string, preferred: string): ParsedPhone {
  const trimmed = value.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '');
  if (!international) return { country: preferred, national: digits, matched: false };
  const full = trimmed.startsWith('00') ? digits.slice(2) : digits;
  for (let length = Math.min(MAX_DIAL_LENGTH, full.length); length >= 1; length -= 1) {
    const candidates = BY_DIAL.get(full.slice(0, length));
    if (!candidates) continue;
    const country = candidates.includes(preferred)
      ? preferred
      : (candidates.find((code) => PRIMARY.has(code)) ?? candidates[0] ?? preferred);
    return { country, national: full.slice(length), matched: true };
  }
  return { country: preferred, national: full, matched: false };
}

/** `+<calling code><national digits>`; a trunk 0 is dropped where it is not dialled abroad. */
export function composeE164(country: string, national: string): string {
  let digits = national.replace(/\D/g, '');
  if (digits === '') return '';
  if (digits.startsWith('0') && !KEEPS_LEADING_ZERO.has(country.toUpperCase())) {
    digits = digits.slice(1);
  }
  return `+${primaryDial(country)}${digits}`;
}

/** E.164: `+` then 4–15 digits, no leading 0 in the calling code. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{3,14}$/.test(value);
}

/** Any stored/typed number as E.164, using `fallback` when it has no `+` prefix. */
export function normalizePhone(value: string, fallback: string): string {
  const parsed = parsePhone(value, fallback);
  if (parsed.matched) return `+${value.trim().replace(/^00/, '').replace(/\D/g, '')}`;
  return composeE164(parsed.country, parsed.national);
}

/** Stored number split for display: `{ country: 'IT', text: '+39 3331234567' }`; legacy values unchanged. */
export function phoneDisplay(value: string): { country: string | null; text: string } {
  const parsed = parsePhone(value, '');
  if (!parsed.matched) return { country: null, text: value };
  const digits = value.trim().replace(/^00/, '').replace(/\D/g, '');
  const dial = digits.slice(0, digits.length - parsed.national.length);
  return { country: parsed.country, text: `${formatDial(dial)} ${parsed.national}`.trim() };
}

const LOCALE_COUNTRY: Readonly<Record<string, string>> = { it: 'IT', en: 'US' };

/**
 * Default dialling country: the browser region when its language matches the
 * UI language (en-GB → GB), else the UI language's home country (it → IT).
 */
export function defaultPhoneCountry(uiLocale: string, browserLanguages: readonly string[]): string {
  const base = uiLocale.split('-')[0]?.toLowerCase() ?? '';
  for (const tag of browserLanguages) {
    const [language = '', region = ''] = tag.split('-');
    if (language.toLowerCase() === base && /^[A-Za-z]{2}$/.test(region) && phoneCountry(region)) {
      return region.toUpperCase();
    }
  }
  return LOCALE_COUNTRY[base] ?? 'US';
}
