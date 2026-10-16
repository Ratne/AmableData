import type { AnyExtension } from '@tiptap/core';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { TextAlign } from '@tiptap/extension-text-align';
import { Typography } from '@tiptap/extension-typography';
import { Placeholder, Selection } from '@tiptap/extensions';
import { StarterKit } from '@tiptap/starter-kit';
import { HorizontalRule } from '../components/tiptap-node/horizontal-rule-node/horizontal-rule-node-extension';
import { ImageUploadNode } from '../components/tiptap-node/image-upload-node/image-upload-node-extension';
import { MAX_FILE_SIZE } from '../lib/tiptap-utils';
import { CleanPaste, EmailDocument, EmailFooterGuard } from './extensions/document';
import {
  EmailButton,
  EmailColumn,
  EmailColumns,
  EmailFooter,
  EmailHeader,
  EmailPreheader,
  EmailSpacer,
  ImageWithLink,
} from './extensions/email-nodes';
import {
  LiquidBranch,
  LiquidCondition,
  LiquidRaw,
  LiquidVariable,
} from './extensions/liquid-nodes';
import type { LiquidFieldGroup } from './fields';
import type { EditorLabels } from './labels';

export type UploadImage = (
  file: File,
  onProgress?: (event: { progress: number }) => void,
  signal?: AbortSignal,
) => Promise<string>;

export interface EditorFeatures {
  /** `email` adds the email blocks, top-level header/footer/preheader and the mandatory footer. */
  readonly mode: 'rich' | 'email';
  /** Liquid fields and blocks; `null` disables Liquid entirely (e.g. contact notes). */
  readonly liquidFields: readonly LiquidFieldGroup[] | null;
  readonly uploadImage: UploadImage | null;
  readonly placeholder: string;
  readonly labels: EditorLabels;
  readonly unsubscribeLabel: string;
}

/** The one extension set behind every editor in the app; features switch blocks on and off. */
export function createExtensions(features: EditorFeatures): AnyExtension[] {
  const { labels } = features;
  const email = features.mode === 'email';
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      horizontalRule: false,
      document: email ? false : undefined,
      codeBlock: email ? false : undefined,
      // The footer closes an email document; a trailing paragraph after it would be unreachable content.
      trailingNode: email ? false : undefined,
      link: { openOnClick: false, enableClickSelection: true, protocols: ['mailto', 'tel'] },
    }),
    HorizontalRule,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    ImageWithLink,
    Typography,
    Superscript,
    Subscript,
    Selection,
    Placeholder.configure({ placeholder: features.placeholder }),
    CleanPaste,
  ];

  if (features.uploadImage) {
    extensions.push(
      ImageUploadNode.configure({
        accept: 'image/*',
        maxSize: MAX_FILE_SIZE,
        limit: 3,
        upload: features.uploadImage,
        onError: (error) => console.error('Image upload failed:', error),
      }),
    );
  }

  if (email) {
    extensions.push(
      EmailDocument,
      EmailButton.configure({ labels }),
      EmailSpacer.configure({ labels }),
      EmailColumns,
      EmailColumn,
      EmailHeader.configure({ labels }),
      EmailFooter.configure({ labels }),
      EmailPreheader.configure({ labels }),
      EmailFooterGuard.configure({ unsubscribeLabel: features.unsubscribeLabel }),
    );
  }

  if (features.liquidFields !== null) {
    const fields = features.liquidFields;
    extensions.push(
      LiquidVariable.configure({ labels, fields }),
      LiquidCondition.configure({ labels, fields }),
      LiquidBranch.configure({ labels, fields }),
      LiquidRaw.configure({ labels, fields }),
    );
  }

  return extensions;
}
