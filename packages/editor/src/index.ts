/**
 * @amable/editor — the single configurable Tiptap 3 editor (Simple Editor
 * template + email blocks + Liquid fields/conditions) and the live email preview.
 *
 * Documents are Tiptap JSON (`JSONContent`), stored as-is; `@amable/email-render`
 * turns them into email HTML at send time.
 */

import type { JSONContent } from '@tiptap/core';

export type { JSONContent };

export { AmableEditor, type AmableEditorProps } from './amable/amable-editor';
export { EmailPreview, type EmailPreviewProps } from './amable/email-preview';
export type { EditorFeatures, UploadImage } from './amable/extensions';
export {
  defaultLiquidFields,
  searchFields,
  type CustomFieldDescriptor,
  type LiquidField,
  type LiquidFieldGroup,
  type LiquidFieldGroupId,
} from './amable/fields';
export type { EditorLabels } from './amable/labels';
export {
  LiquidHelperProvider,
  type LiquidHelperHost,
  type LiquidHelperRenderProps,
  type LiquidHelperSlot,
} from './amable/liquid-helper';
