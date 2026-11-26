/**
 * Zod-free country data shared by the schema, the validator and the widget:
 * ISO 3166-1 alpha-2 codes (same set as the checkout buyer address) with their
 * ITU E.164 calling code (empty when the territory has none). Names come from
 * `Intl.DisplayNames` at render time, flags from the regional indicator pair.
 */

/** `<ISO2><calling code>` per country, calling code omitted where unassigned. */
const DATA =
  'AD376,AE971,AF93,AG1268,AI1264,AL355,AM374,AO244,AQ672,AR54,AS1684,AT43,AU61,AW297,AX358,AZ994,' +
  'BA387,BB1246,BD880,BE32,BF226,BG359,BH973,BI257,BJ229,BL590,BM1441,BN673,BO591,BQ599,BR55,BS1242,BT975,BV,BW267,BY375,BZ501,' +
  'CA1,CC61,CD243,CF236,CG242,CH41,CI225,CK682,CL56,CM237,CN86,CO57,CR506,CU53,CV238,CW599,CX61,CY357,CZ420,' +
  'DE49,DJ253,DK45,DM1767,DO1809,DZ213,EC593,EE372,EG20,EH212,ER291,ES34,ET251,' +
  'FI358,FJ679,FK500,FM691,FO298,FR33,' +
  'GA241,GB44,GD1473,GE995,GF594,GG44,GH233,GI350,GL299,GM220,GN224,GP590,GQ240,GR30,GS500,GT502,GU1671,GW245,GY592,' +
  'HK852,HM,HN504,HR385,HT509,HU36,ID62,IE353,IL972,IM44,IN91,IO246,IQ964,IR98,IS354,IT39,' +
  'JE44,JM1876,JO962,JP81,KE254,KG996,KH855,KI686,KM269,KN1869,KP850,KR82,KW965,KY1345,KZ7,' +
  'LA856,LB961,LC1758,LI423,LK94,LR231,LS266,LT370,LU352,LV371,LY218,' +
  'MA212,MC377,MD373,ME382,MF590,MG261,MH692,MK389,ML223,MM95,MN976,MO853,MP1670,MQ596,MR222,MS1664,MT356,MU230,MV960,MW265,MX52,MY60,MZ258,' +
  'NA264,NC687,NE227,NF672,NG234,NI505,NL31,NO47,NP977,NR674,NU683,NZ64,OM968,' +
  'PA507,PE51,PF689,PG675,PH63,PK92,PL48,PM508,PN64,PR1787,PS970,PT351,PW680,PY595,QA974,' +
  'RE262,RO40,RS381,RU7,RW250,' +
  'SA966,SB677,SC248,SD249,SE46,SG65,SH290,SI386,SJ47,SK421,SL232,SM378,SN221,SO252,SR597,SS211,ST239,SV503,SX1721,SY963,SZ268,' +
  'TC1649,TD235,TF,TG228,TH66,TJ992,TK690,TL670,TM993,TN216,TO676,TR90,TT1868,TV688,TW886,TZ255,' +
  'UA380,UG256,UM,US1,UY598,UZ998,VA39,VC1784,VE58,VG1284,VI1340,VN84,VU678,' +
  'WF681,WS685,XK383,YE967,YT262,ZA27,ZM260,ZW263';

/** `[ISO2, calling code]` pairs; the calling code is `''` where none exists. */
export const COUNTRY_DIAL: ReadonlyArray<readonly [string, string]> = DATA.split(',').map((s) => [
  s.slice(0, 2),
  s.slice(2),
]);

const DIAL_BY_CODE = new Map(COUNTRY_DIAL);

export function isCountryCode(value: string): boolean {
  return DIAL_BY_CODE.has(value);
}

/** Calling code of a country (`'39'` for IT), null when it has none. */
export function dialCodeOf(country: string): string | null {
  const dial = DIAL_BY_CODE.get(country);
  return dial === undefined || dial === '' ? null : dial;
}

/** Country preferred among those sharing a calling code. */
const PRIMARY_FOR_DIAL: Readonly<Record<string, string>> = {
  '1': 'US',
  '7': 'RU',
  '39': 'IT',
  '44': 'GB',
  '47': 'NO',
  '61': 'AU',
  '64': 'NZ',
  '212': 'MA',
  '262': 'RE',
  '290': 'SH',
  '358': 'FI',
  '500': 'FK',
  '590': 'GP',
  '599': 'CW',
  '672': 'NF',
};

/**
 * Country of an international number (`+39 333…` → `IT`): longest calling-code
 * match; ties go to `prefer`, then to the main country of that code.
 */
export function countryForNumber(number: string, prefer?: string | null): string | null {
  if (!number.trimStart().startsWith('+')) return null;
  const digits = number.replace(/\D/g, '');
  if (digits === '') return null;
  let bestLength = 0;
  let candidates: string[] = [];
  for (const [code, dial] of COUNTRY_DIAL) {
    if (dial === '' || !digits.startsWith(dial)) continue;
    if (dial.length > bestLength) {
      bestLength = dial.length;
      candidates = [code];
    } else if (dial.length === bestLength) {
      candidates.push(code);
    }
  }
  if (candidates.length === 0) return null;
  if (prefer !== undefined && prefer !== null && candidates.includes(prefer)) return prefer;
  const primary = PRIMARY_FOR_DIAL[digits.slice(0, bestLength)];
  return primary !== undefined && candidates.includes(primary) ? primary : (candidates[0] ?? null);
}

/** 🇮🇹 from `IT`: regional indicator pair (letters on platforms without flag emoji). */
export function flagEmoji(country: string): string {
  return String.fromCodePoint(
    ...[...country.toUpperCase()].map((ch) => 127397 + ch.charCodeAt(0)),
  );
}

/** Countries named in `locale`, sorted by name (code as name when the runtime has none). */
export function countryOptions(locale: string): Array<{ code: string; name: string }> {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    names = null;
  }
  return COUNTRY_DIAL.map(([code]) => ({ code, name: names?.of(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );
}

/** Countries that can prefix a phone number, with flag and calling code. */
export function phoneCountryOptions(
  locale: string,
): Array<{ code: string; name: string; dial: string }> {
  const dials = new Map(COUNTRY_DIAL);
  return countryOptions(locale).flatMap(({ code, name }) => {
    const dial = dials.get(code);
    return dial === undefined || dial === '' ? [] : [{ code, name, dial }];
  });
}
