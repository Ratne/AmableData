/**
 * Client side of the CSV import: header/sample preview (the server streams and
 * parses the full file) and a first guess of the column mapping.
 */

export const IMPORT_TARGETS = [
  'given_name',
  'middle_name',
  'family_name',
  'name',
  'prefix',
  'suffix',
  'preferred_name',
  'job_title',
  'website',
  'spouse_name',
  'time_zone',
  'preferred_locale',
  'birthday',
  'anniversary',
  'owner_id',
  'marketable_status',
  'score_value',
  'company_name',
  'lead_source',
  'email',
  'email2',
  'email3',
  'phone',
  'phone2',
  'phone3',
  'address.line1',
  'address.street_number',
  'address.line2',
  'address.locality',
  'address.region',
  'address.postal_code',
  'address.country_code',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'tags',
] as const;

export type ImportTarget = (typeof IMPORT_TARGETS)[number] | `custom.${string}` | 'ignore';

export function detectDelimiter(headerLine: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of headerLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === ',' || char === ';' || char === '\t')) counts[char] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

/** RFC 4180 parse of the first `maxRows` records (header included). */
export function parseCsvPreview(text: string, maxRows = 6): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(source.split(/\r?\n/, 1)[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length && rows.length < maxRows; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (rows.length < maxRows && (cell !== '' || row.length > 0)) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }
  return rows;
}

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Header spellings (en/it) that map to a target without user input. */
const ALIASES: Readonly<Record<string, ImportTarget>> = {
  firstname: 'given_name',
  givenname: 'given_name',
  first: 'given_name',
  nome: 'given_name',
  lastname: 'family_name',
  familyname: 'family_name',
  surname: 'family_name',
  last: 'family_name',
  cognome: 'family_name',
  fullname: 'name',
  name: 'name',
  nomecompleto: 'name',
  middlename: 'middle_name',
  email: 'email',
  emailaddress: 'email',
  mail: 'email',
  email2: 'email2',
  email3: 'email3',
  phone: 'phone',
  phonenumber: 'phone',
  telephone: 'phone',
  telefono: 'phone',
  mobile: 'phone',
  cellulare: 'phone',
  phone2: 'phone2',
  phone3: 'phone3',
  company: 'company_name',
  companyname: 'company_name',
  azienda: 'company_name',
  organization: 'company_name',
  jobtitle: 'job_title',
  title: 'job_title',
  ruolo: 'job_title',
  website: 'website',
  sitoweb: 'website',
  birthday: 'birthday',
  compleanno: 'birthday',
  datadinascita: 'birthday',
  tags: 'tags',
  tag: 'tags',
  street: 'address.line1',
  address: 'address.line1',
  indirizzo: 'address.line1',
  civico: 'address.street_number',
  numerocivico: 'address.street_number',
  housenumber: 'address.street_number',
  streetnumber: 'address.street_number',
  city: 'address.locality',
  citta: 'address.locality',
  region: 'address.region',
  state: 'address.region',
  provincia: 'address.region',
  zip: 'address.postal_code',
  postalcode: 'address.postal_code',
  cap: 'address.postal_code',
  country: 'address.country_code',
  countrycode: 'address.country_code',
  paese: 'address.country_code',
  leadsource: 'lead_source',
  source: 'lead_source',
  score: 'score_value',
  utmsource: 'utm_source',
  utmmedium: 'utm_medium',
  utmcampaign: 'utm_campaign',
  utmterm: 'utm_term',
  utmcontent: 'utm_content',
};

/**
 * First guess of the mapping: exact target names, known aliases, then custom
 * field keys/labels. Each target is used at most once; the rest is ignored.
 */
export function guessMapping(
  headers: readonly string[],
  customFields: ReadonlyArray<{ key: string; label: string }>,
): Record<string, ImportTarget> {
  const used = new Set<string>();
  const mapping: Record<string, ImportTarget> = {};
  for (const header of headers) {
    const key = normalize(header);
    let target: ImportTarget | undefined = (IMPORT_TARGETS as readonly string[]).includes(
      header.trim().toLowerCase(),
    )
      ? (header.trim().toLowerCase() as ImportTarget)
      : ALIASES[key];
    if (target === undefined) {
      const custom = customFields.find(
        (field) => normalize(field.key) === key || normalize(field.label) === key,
      );
      if (custom !== undefined) target = `custom.${custom.key}`;
    }
    if (target === undefined || used.has(target)) {
      mapping[header] = 'ignore';
    } else {
      used.add(target);
      mapping[header] = target;
    }
  }
  return mapping;
}

/** Targets chosen twice (the server rejects duplicate targets). */
export function duplicateTargets(mapping: Readonly<Record<string, string>>): string[] {
  const seen = new Map<string, number>();
  for (const target of Object.values(mapping)) {
    if (target !== 'ignore') seen.set(target, (seen.get(target) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([target]) => target);
}
