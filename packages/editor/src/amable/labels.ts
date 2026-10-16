/** UI strings of the editor; the app passes translations (keys under `editor.*` in @amable/i18n). */
export interface EditorLabels {
  readonly insert: string;
  readonly insertField: string;
  readonly button: string;
  readonly buttonLabel: string;
  readonly buttonLink: string;
  readonly align: string;
  readonly alignLeft: string;
  readonly alignCenter: string;
  readonly alignRight: string;
  readonly color: string;
  readonly textColor: string;
  readonly divider: string;
  readonly spacer: string;
  readonly height: string;
  readonly columns2: string;
  readonly columns3: string;
  readonly header: string;
  readonly footer: string;
  readonly unsubscribeLabel: string;
  readonly unsubscribeNote: string;
  readonly preheader: string;
  readonly preheaderPlaceholder: string;
  readonly condition: string;
  readonly conditionIf: string;
  readonly conditionTag: string;
  readonly conditionField: string;
  readonly conditionExpression: string;
  readonly conditionHasTag: string;
  readonly conditionHasNotTag: string;
  readonly conditionOtherwise: string;
  readonly conditionAddOtherwise: string;
  readonly conditionRemoveOtherwise: string;
  readonly operators: Readonly<
    Record<
      | 'equals'
      | 'not_equals'
      | 'contains'
      | 'greater_than'
      | 'less_than'
      | 'is_blank'
      | 'is_present',
      string
    >
  >;
  readonly value: string;
  readonly rawLiquid: string;
  readonly rawLiquidHint: string;
  readonly fallback: string;
  readonly fallbackPlaceholder: string;
  readonly noFields: string;
  readonly imageLink: string;
  readonly image: string;
  readonly remove: string;
}

export const DEFAULT_EDITOR_LABELS: EditorLabels = {
  insert: 'Insert',
  insertField: 'Insert field',
  button: 'Button',
  buttonLabel: 'Label',
  buttonLink: 'Link',
  align: 'Alignment',
  alignLeft: 'Left',
  alignCenter: 'Center',
  alignRight: 'Right',
  color: 'Color',
  textColor: 'Text color',
  divider: 'Divider',
  spacer: 'Spacer',
  height: 'Height',
  columns2: 'Two columns',
  columns3: 'Three columns',
  header: 'Header',
  footer: 'Footer',
  unsubscribeLabel: 'Unsubscribe link text',
  unsubscribeNote: 'The unsubscribe link is always added and cannot be removed.',
  preheader: 'Preheader',
  preheaderPlaceholder: 'Preview text shown next to the subject in the inbox',
  condition: 'Condition',
  conditionIf: 'If',
  conditionTag: 'Tag',
  conditionField: 'Field',
  conditionExpression: 'Liquid expression',
  conditionHasTag: 'has tag',
  conditionHasNotTag: 'does not have tag',
  conditionOtherwise: 'Otherwise',
  conditionAddOtherwise: 'Add “otherwise”',
  conditionRemoveOtherwise: 'Remove “otherwise”',
  operators: {
    equals: 'is',
    not_equals: 'is not',
    contains: 'contains',
    greater_than: 'is greater than',
    less_than: 'is less than',
    is_blank: 'is empty',
    is_present: 'is not empty',
  },
  value: 'Value',
  rawLiquid: 'Liquid code',
  rawLiquidHint: 'Advanced: raw Liquid, rendered for each recipient.',
  fallback: 'Fallback',
  fallbackPlaceholder: 'Shown when the field is empty',
  noFields: 'No matching fields',
  imageLink: 'Image link',
  image: 'Image',
  remove: 'Remove',
};
