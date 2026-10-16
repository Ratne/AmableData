import {
  collectsValue,
  CONTACT_MAP_TARGETS,
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

const DEFAULT_MAPPING: Partial<Record<FieldKind, FormField['map_to']>> = { email: 'email', phone: 'phone' };

/** `First name!` → `first_name`, unique among `taken`. */
export function fieldKey(label: string, taken: ReadonlySet<string>, fallback: string): string {
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

export function mappableTargets(): readonly string[] {
  return CONTACT_MAP_TARGETS;
}

export { collectsValue, OPTION_KINDS };
