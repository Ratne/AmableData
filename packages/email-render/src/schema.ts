/**
 * Tiptap JSON shapes shared by `@amable/editor` (which produces documents) and
 * this renderer (which turns them into email HTML). Documents are stored as-is
 * and stay re-editable, so node names and attributes here are a storage format:
 * renaming one needs a data migration.
 */

export interface TiptapMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface TiptapNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly TiptapNode[];
  readonly marks?: readonly TiptapMark[];
  readonly text?: string;
}

export interface TiptapDocument extends TiptapNode {
  readonly type: 'doc';
  readonly content?: readonly TiptapNode[];
}

/** Custom node names introduced by the email and Liquid extensions. */
export const EMAIL_NODES = {
  button: 'emailButton',
  spacer: 'emailSpacer',
  columns: 'emailColumns',
  column: 'emailColumn',
  header: 'emailHeader',
  footer: 'emailFooter',
  preheader: 'emailPreheader',
} as const;

export const LIQUID_NODES = {
  variable: 'liquidVariable',
  condition: 'liquidCondition',
  branch: 'liquidBranch',
  raw: 'liquidRaw',
} as const;

export type ButtonAlign = 'left' | 'center' | 'right';

export interface EmailButtonAttrs {
  readonly label: string;
  readonly href: string;
  readonly align: ButtonAlign;
  readonly backgroundColor: string;
  readonly textColor: string;
}

export interface EmailSpacerAttrs {
  /** Pixels, clamped to 4–160 at render time. */
  readonly height: number;
}

export interface EmailFooterAttrs {
  /** Text of the unsubscribe link that the renderer always appends to the footer. */
  readonly unsubscribeLabel: string;
}

export interface EmailPreheaderAttrs {
  readonly text: string;
}

export interface LiquidVariableAttrs {
  /** Dotted path into the recipient context, e.g. `contact.first_name`. */
  readonly path: string;
  readonly fallback: string | null;
  /** Human label shown on the chip; not part of the Liquid output. */
  readonly label: string | null;
  /** Optional extra filter, e.g. `date: "%d/%m/%Y"` or `upcase`. */
  readonly filter: string | null;
}

export type ConditionKind = 'tag' | 'field' | 'expression';

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'is_blank',
  'is_present',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface LiquidConditionAttrs {
  readonly kind: ConditionKind;
  /** `tag`: the tag name the contact must have. */
  readonly tag: string | null;
  /** `field`: dotted path compared with `value`. */
  readonly field: string | null;
  readonly operator: ConditionOperator;
  readonly value: string | null;
  /** `expression`: raw Liquid condition for experts, e.g. `order.total > 100`. */
  readonly expression: string | null;
  /** When true, the tag condition is negated (`unless`). */
  readonly negate: boolean;
}

export interface LiquidBranchAttrs {
  readonly branch: 'then' | 'else';
}

export interface LiquidRawAttrs {
  readonly code: string;
}
