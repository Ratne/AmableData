/** Every ISO 639-1 language code (the deprecated `sh` excluded). */
export const ISO_639_1: readonly string[] = (
  'aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
  'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht ' +
  'hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky ' +
  'la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny ' +
  'oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss ' +
  'st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo ' +
  'za zh zu'
).split(' ');

/** `code:English:Italiano` for languages missing from Chromium's trimmed ICU data. */
const FALLBACK_TABLE =
  'aa:Afar:Afar ab:Abkhazian:Abcaso ae:Avestan:Avestico av:Avaric:Avaro ba:Bashkir:Baschiro ' +
  'bi:Bislama:Bislama bo:Tibetan:Tibetano ce:Chechen:Ceceno ch:Chamorro:Chamorro cr:Cree:Cree ' +
  'cu:Church Slavic:Slavo ecclesiastico cv:Chuvash:Ciuvascio dz:Dzongkha:Dzongkha ff:Fula:Fula ' +
  'fj:Fijian:Figiano gv:Manx:Mannese ho:Hiri Motu:Hiri motu hz:Herero:Herero ' +
  'ie:Interlingue:Interlingue ii:Sichuan Yi:Yi del Sichuan ik:Inupiaq:Inupiak io:Ido:Ido ' +
  'iu:Inuktitut:Inuktitut kg:Kongo:Kongo ki:Kikuyu:Kikuyu kj:Kuanyama:Kuanyama ' +
  'kl:Kalaallisut:Groenlandese kr:Kanuri:Kanuri ks:Kashmiri:Kashmiri kv:Komi:Komi ' +
  'kw:Cornish:Cornico li:Limburgish:Limburghese lu:Luba-Katanga:Luba-Katanga ' +
  'mh:Marshallese:Marshallese na:Nauru:Nauruano nd:North Ndebele:Ndebele del nord ' +
  'ng:Ndonga:Ndonga nr:South Ndebele:Ndebele del sud nv:Navajo:Navajo oj:Ojibwa:Ojibwe ' +
  'os:Ossetic:Osseto pi:Pali:Pali rn:Rundi:Kirundi sc:Sardinian:Sardo ' +
  'se:Northern Sami:Sami del nord sg:Sango:Sango ss:Swati:Swati ty:Tahitian:Tahitiano ' +
  've:Venda:Venda vo:Volapük:Volapük za:Zhuang:Zhuang';

const FALLBACK_NAMES = new Map(
  FALLBACK_TABLE.split(/ (?=[a-z]{2}:)/).map((entry) => {
    const [code = '', en = '', it = ''] = entry.split(':');
    return [code, { en, it }] as const;
  }),
);

/** Static name when the runtime has no data for `code`; undefined otherwise. */
export function fallbackLanguageName(code: string, uiLocale: string): string | undefined {
  const names = FALLBACK_NAMES.get(code);
  if (!names) return undefined;
  return uiLocale.toLowerCase().startsWith('it') ? names.it : names.en;
}

export interface LanguageOption {
  readonly code: string;
  /** In the UI language. */
  readonly name: string;
  /** In the language itself; empty when it equals `name` or is unknown to the runtime. */
  readonly nativeName: string;
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

function namesIn(locale: string): Intl.DisplayNames | null {
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  return names;
}

function lookup(locale: string, code: string): string | undefined {
  try {
    return namesIn(locale)?.of(code) ?? undefined;
  } catch {
    return undefined;
  }
}

const capitalize = (text: string, locale: string) =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/** Language (or BCP-47 tag) name in the UI language; the code itself when unknown. */
export function languageName(code: string, uiLocale: string): string {
  const name = lookup(uiLocale, code) ?? fallbackLanguageName(code, uiLocale) ?? lookup('en', code);
  return name ? capitalize(name, uiLocale) : code;
}

export function nativeLanguageName(code: string): string {
  const name = lookup(code, code);
  return name ? capitalize(name, code) : '';
}

/** All ISO 639-1 languages (plus `extra`, e.g. a stored `pt-BR`), sorted by localized name. */
export function languageOptions(uiLocale: string, extra?: string | null): LanguageOption[] {
  const codes = extra && !ISO_639_1.includes(extra) ? [...ISO_639_1, extra] : ISO_639_1;
  const collator = new Intl.Collator(uiLocale);
  return codes
    .map((code) => {
      const name = languageName(code, uiLocale);
      const native = nativeLanguageName(code);
      return { code, name, nativeName: native === name ? '' : native };
    })
    .sort((a, b) => collator.compare(a.name, b.name));
}
