/**
 * Catalog of Liquid fields offered by the `{{` picker. The app builds it from
 * the tenant's schema (custom fields per entity) and passes translated labels;
 * `defaultLiquidFields` is the built-in part.
 */

export type LiquidFieldGroupId =
  'contact' | 'custom' | 'owner' | 'company' | 'order' | 'date' | 'other';

export interface LiquidField {
  /** Dotted path into the recipient context, or `now` for date fields. */
  readonly path: string;
  readonly label: string;
  /** Filter appended after the path, e.g. `date: "%d/%m/%Y"`. */
  readonly filter?: string;
  /** Example value shown in the picker and used by the preview when no sample is given. */
  readonly example?: string;
}

export interface LiquidFieldGroup {
  readonly id: LiquidFieldGroupId | (string & {});
  readonly label: string;
  readonly fields: readonly LiquidField[];
}

export interface CustomFieldDescriptor {
  /** Stable key of the custom field; becomes `contact.custom.<key>`. */
  readonly key: string;
  readonly label: string;
}

export function defaultLiquidFields(
  customFields: readonly CustomFieldDescriptor[] = [],
): LiquidFieldGroup[] {
  const groups: LiquidFieldGroup[] = [
    {
      id: 'contact',
      label: 'Contact',
      fields: [
        { path: 'contact.first_name', label: 'First name', example: 'Ada' },
        { path: 'contact.last_name', label: 'Last name', example: 'Lovelace' },
        { path: 'contact.full_name', label: 'Full name', example: 'Ada Lovelace' },
        { path: 'contact.email', label: 'Email', example: 'ada@example.com' },
        { path: 'contact.phone', label: 'Phone', example: '+39 02 1234567' },
        { path: 'contact.city', label: 'City', example: 'Milano' },
        { path: 'contact.country', label: 'Country', example: 'Italy' },
      ],
    },
    {
      id: 'owner',
      label: 'Owner',
      fields: [
        { path: 'owner.name', label: 'Owner name', example: 'Marco Rossi' },
        { path: 'owner.email', label: 'Owner email', example: 'marco@example.com' },
        { path: 'owner.signature', label: 'Owner signature' },
      ],
    },
    {
      id: 'company',
      label: 'Company',
      fields: [
        { path: 'company.name', label: 'Company name', example: 'Analytical Engines Srl' },
        { path: 'company.website', label: 'Company website', example: 'https://example.com' },
      ],
    },
    {
      id: 'order',
      label: 'Order',
      fields: [
        { path: 'order.number', label: 'Order number', example: 'A-1042' },
        { path: 'order.total', label: 'Order total', example: '149.00' },
        { path: 'order.currency', label: 'Currency', example: 'EUR' },
        {
          path: 'order.date',
          label: 'Order date',
          filter: 'date: "%d/%m/%Y"',
          example: '15/10/2026',
        },
      ],
    },
    {
      id: 'date',
      label: 'Date',
      fields: [
        { path: 'now', label: 'Today', filter: 'date: "%d/%m/%Y"', example: '15/10/2026' },
        { path: 'now', label: 'Current year', filter: 'date: "%Y"', example: '2026' },
      ],
    },
  ];
  if (customFields.length > 0) {
    groups.splice(1, 0, {
      id: 'custom',
      label: 'Custom fields',
      fields: customFields.map((field) => ({
        path: `contact.custom.${field.key}`,
        label: field.label,
      })),
    });
  }
  return groups;
}

export function searchFields(
  groups: readonly LiquidFieldGroup[],
  query: string,
): { group: LiquidFieldGroup; field: LiquidField }[] {
  const needle = query.trim().toLowerCase();
  return groups.flatMap((group) =>
    group.fields
      .filter(
        (field) =>
          needle === '' ||
          field.label.toLowerCase().includes(needle) ||
          field.path.toLowerCase().includes(needle),
      )
      .map((field) => ({ group, field })),
  );
}
