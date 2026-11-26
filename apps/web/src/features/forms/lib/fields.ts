import {
  collectsValue,
  formFieldSchema,
  OPTION_KINDS,
  type FieldKind,
  type FormDefinition,
  type FormField,
} from '@amable/forms';

/** Kinds offered by the "add field" menu, in display order. */
export const ADDABLE_KINDS: readonly FieldKind[] = [
  'text',
  'email',
  'phone',
  'textarea',
  'number',
  'date',
  'country',
  'select',
  'radio',
  'checkbox',
  'multicheck',
  'rating',
  'consent',
  'hidden',
  'heading',
  'html',
  'page_break',
];

const DEFAULT_MAPPING: Partial<Record<FieldKind, FormField['map_to']>> = {
  email: 'email',
  phone: 'phone',
  country: 'address.country_code',
};

/** `First name!` → `first_name`, unique among `taken`. */
function fieldKey(label: string, taken: ReadonlySet<string>, fallback: string): string {
  const base =
    label
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f_$1')
      .slice(0, 50) || fallback;
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${String(n)}`;
  return key;
}

export function newField(kind: FieldKind, definition: FormDefinition, label: string): FormField {
  const taken = new Set(definition.fields.map((f) => f.key));
  const usedTargets = new Set(definition.fields.map((f) => f.map_to));
  const mapping = DEFAULT_MAPPING[kind] ?? null;
  return formFieldSchema.parse({
    id: `f_${crypto.randomUUID().slice(0, 8)}`,
    kind,
    key: fieldKey(label, taken, kind),
    label,
    options: OPTION_KINDS.has(kind)
      ? [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ]
      : [],
    map_to: mapping !== null && !usedTargets.has(mapping) ? mapping : null,
  });
}

export interface AddressGroupLabels {
  line1: string;
  street_number: string;
  postal_code: string;
  locality: string;
  region: string;
  country: string;
}

/**
 * The "Address" palette entry: country first (it narrows the street
 * autocomplete), then street, street number, postal code, city and province,
 * already mapped to the contact address (a mapping stays empty when another
 * field already uses it).
 */
export function newAddressFields(definition: FormDefinition, labels: AddressGroupLabels): FormField[] {
  const taken = new Set(definition.fields.map((f) => f.key));
  const usedTargets = new Set(definition.fields.map((f) => f.map_to));
  const parts: ReadonlyArray<{
    part: keyof AddressGroupLabels;
    kind: FieldKind;
    mapTo: NonNullable<FormField['map_to']>;
    width: FormField['width'];
  }> = [
    { part: 'country', kind: 'country', mapTo: 'address.country_code', width: 'full' },
    { part: 'line1', kind: 'text', mapTo: 'address.line1', width: 'full' },
    { part: 'street_number', kind: 'text', mapTo: 'address.street_number', width: 'half' },
    { part: 'postal_code', kind: 'text', mapTo: 'address.postal_code', width: 'half' },
    { part: 'locality', kind: 'text', mapTo: 'address.locality', width: 'half' },
    { part: 'region', kind: 'text', mapTo: 'address.region', width: 'half' },
  ];
  return parts.map(({ part, kind, mapTo, width }) => {
    const key = fieldKey(labels[part], taken, part);
    taken.add(key);
    const mapped = !usedTargets.has(mapTo);
    if (mapped) usedTargets.add(mapTo);
    return formFieldSchema.parse({
      id: `f_${crypto.randomUUID().slice(0, 8)}`,
      kind,
      key,
      label: labels[part],
      width,
      map_to: mapped ? mapTo : null,
    });
  });
}

export { collectsValue, OPTION_KINDS };
