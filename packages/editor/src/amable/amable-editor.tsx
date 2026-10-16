import type { JSONContent } from '@tiptap/core';
import {
  EditorContent,
  EditorContext,
  useEditor,
  useEditorState,
  type Editor,
} from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockquoteButton } from '../components/tiptap-ui/blockquote-button';
import { CodeBlockButton } from '../components/tiptap-ui/code-block-button';
import { ColorHighlightPopover } from '../components/tiptap-ui/color-highlight-popover';
import { HeadingDropdownMenu } from '../components/tiptap-ui/heading-dropdown-menu';
import { ImageUploadButton } from '../components/tiptap-ui/image-upload-button';
import { LinkPopover } from '../components/tiptap-ui/link-popover';
import { ListDropdownMenu } from '../components/tiptap-ui/list-dropdown-menu';
import { MarkButton } from '../components/tiptap-ui/mark-button';
import { TextAlignButton } from '../components/tiptap-ui/text-align-button';
import { UndoRedoButton } from '../components/tiptap-ui/undo-redo-button';
import { Button } from '../components/tiptap-ui-primitive/button';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '../components/tiptap-ui-primitive/toolbar';
import { createExtensions, type UploadImage } from './extensions';
import type { LiquidFieldGroup } from './fields';
import { DEFAULT_EDITOR_LABELS, type EditorLabels } from './labels';
import { documentLiquidSource, insertLiquid, useLiquidHelperSlot, type LiquidHelperHost } from './liquid-helper';
import { InsertMenu } from './ui/insert-menu';

import '../styles/_variables.scss';
import '../styles/_keyframe-animations.scss';
import '../components/tiptap-node/blockquote-node/blockquote-node.scss';
import '../components/tiptap-node/code-block-node/code-block-node.scss';
import '../components/tiptap-node/horizontal-rule-node/horizontal-rule-node.scss';
import '../components/tiptap-node/list-node/list-node.scss';
import '../components/tiptap-node/image-node/image-node.scss';
import '../components/tiptap-node/heading-node/heading-node.scss';
import '../components/tiptap-node/paragraph-node/paragraph-node.scss';
import './amable-editor.css';

export interface AmableEditorProps {
  /** Tiptap JSON, stored as-is. Controlled: external changes replace the content. */
  readonly value?: JSONContent | null;
  readonly onChange?: (doc: JSONContent) => void;
  /**
   * `rich` for notes, task and deal descriptions, signatures, form texts;
   * `email` for templates, broadcasts and sequence emails.
   */
  readonly mode?: 'rich' | 'email';
  /** Fields for the `{{` picker; pass `null` to disable Liquid (default for `rich`). */
  readonly liquidFields?: readonly LiquidFieldGroup[] | null;
  /** Uploads an image (to R2) and returns its public URL; without it the image button is hidden. */
  readonly uploadImage?: UploadImage | null;
  readonly placeholder?: string;
  readonly editable?: boolean;
  readonly toolbar?: 'full' | 'compact' | 'none';
  readonly labels?: Partial<EditorLabels>;
  /** Default text of the mandatory unsubscribe link in email mode. */
  readonly unsubscribeLabel?: string;
  readonly className?: string;
  readonly onReady?: (editor: Editor) => void;
}

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

function ImageLinkField({ editor, labels }: { editor: Editor; labels: EditorLabels }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      active: current.isActive('image'),
      href: (current.getAttributes('image')['href'] as string | null | undefined) ?? '',
    }),
  });
  if (!state.active) return null;
  return (
    <ToolbarGroup>
      <input
        className="amable-toolbar-input"
        aria-label={labels.imageLink}
        placeholder={`${labels.imageLink} https://`}
        value={state.href}
        onChange={(event) =>
          editor
            .chain()
            .updateAttributes('image', { href: event.target.value || null })
            .run()
        }
      />
    </ToolbarGroup>
  );
}

function EditorToolbar({
  editor,
  labels,
  variant,
  email,
  liquid,
  canUpload,
  helper,
}: {
  editor: Editor;
  labels: EditorLabels;
  variant: 'full' | 'compact';
  email: boolean;
  liquid: boolean;
  canUpload: boolean;
  helper: { label: string; onOpen: () => void } | null;
}) {
  const full = variant === 'full';
  return (
    <Toolbar className="amable-editor-toolbar">
      <ToolbarGroup>
        <UndoRedoButton action="undo" />
        <UndoRedoButton action="redo" />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        <HeadingDropdownMenu modal={false} levels={[1, 2, 3]} />
        <ListDropdownMenu modal={false} types={['bulletList', 'orderedList', 'taskList']} />
        <BlockquoteButton />
        {full && !email ? <CodeBlockButton /> : null}
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        <MarkButton type="bold" />
        <MarkButton type="italic" />
        <MarkButton type="underline" />
        <MarkButton type="strike" />
        {full ? <MarkButton type="code" /> : null}
        {full ? <ColorHighlightPopover /> : null}
        <LinkPopover />
      </ToolbarGroup>
      {full ? (
        <>
          <ToolbarSeparator />
          <ToolbarGroup>
            <TextAlignButton align="left" />
            <TextAlignButton align="center" />
            <TextAlignButton align="right" />
          </ToolbarGroup>
        </>
      ) : null}
      {canUpload ? (
        <>
          <ToolbarSeparator />
          <ToolbarGroup>
            <ImageUploadButton text={labels.image} />
          </ToolbarGroup>
        </>
      ) : null}
      {email || liquid ? (
        <>
          <ToolbarSeparator />
          <ToolbarGroup>
            <InsertMenu editor={editor} labels={labels} email={email} liquid={liquid} />
            {helper !== null ? (
              <Button
                type="button"
                variant="ghost"
                data-testid="liquid-helper-open"
                tooltip={helper.label}
                onClick={helper.onOpen}
              >
                <span className="tiptap-button-text amable-liquid-mono">{'{{ }}'}</span>
                <span className="tiptap-button-text">{helper.label}</span>
              </Button>
            ) : null}
          </ToolbarGroup>
        </>
      ) : null}
      {email ? <ImageLinkField editor={editor} labels={labels} /> : null}
    </Toolbar>
  );
}

/**
 * The single configurable editor used across the app (notes, descriptions,
 * signatures, email templates, broadcasts, sequence emails, form texts, alerts).
 * Built on the Tiptap Simple Editor template; content is Tiptap JSON.
 */
export function AmableEditor({
  value,
  onChange,
  mode = 'rich',
  liquidFields,
  uploadImage = null,
  placeholder = '',
  editable = true,
  toolbar = 'full',
  labels: labelOverrides,
  unsubscribeLabel,
  className,
  onReady,
}: AmableEditorProps) {
  const labels = useMemo(() => ({ ...DEFAULT_EDITOR_LABELS, ...labelOverrides }), [labelOverrides]);
  const fields = liquidFields === undefined ? (mode === 'email' ? [] : null) : liquidFields;
  const lastEmitted = useRef<JSONContent | null | undefined>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Extensions are fixed for the editor's lifetime; remount (change `key`) to switch mode.
  const extensions = useMemo(
    () =>
      createExtensions({
        mode,
        liquidFields: fields,
        uploadImage,
        placeholder,
        labels,
        unsubscribeLabel: unsubscribeLabel ?? labels.footer,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    immediatelyRender: true,
    editable,
    extensions,
    content: value ?? EMPTY_DOC,
    editorProps: {
      attributes: { class: 'amable-editor-content', autocomplete: 'off', spellcheck: 'true' },
    },
    onUpdate: ({ editor: current }) => {
      const json = current.getJSON();
      lastEmitted.current = json;
      onChangeRef.current?.(json);
    },
  });

  useEffect(() => {
    if (editor) onReady?.(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || value === undefined || value === lastEmitted.current) return;
    const next = value ?? EMPTY_DOC;
    if (JSON.stringify(next) !== JSON.stringify(editor.getJSON())) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [editor, value]);

  const slot = useLiquidHelperSlot();
  const [helperOpen, setHelperOpen] = useState(false);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const host = useMemo<LiquidHelperHost | null>(
    () =>
      editor
        ? {
            insert: (code) => insertLiquid(editor, code, fieldsRef.current ?? []),
            source: () => documentLiquidSource(editor),
          }
        : null,
    [editor],
  );
  const withHelper = slot !== null && fields !== null && editable && host !== null;

  if (!editor) return null;

  return (
    <div className={['amable-editor', className].filter(Boolean).join(' ')} data-mode={mode}>
      <EditorContext.Provider value={{ editor }}>
        {toolbar !== 'none' && editable ? (
          <EditorToolbar
            editor={editor}
            labels={labels}
            variant={toolbar}
            email={mode === 'email'}
            liquid={fields !== null}
            canUpload={uploadImage !== null}
            helper={withHelper ? { label: slot.label, onOpen: () => setHelperOpen(true) } : null}
          />
        ) : null}
        <EditorContent editor={editor} role="presentation" className="amable-editor-body" />
      </EditorContext.Provider>
      {withHelper
        ? slot.render({ open: helperOpen, onOpenChange: setHelperOpen, host, fields: fields ?? [] })
        : null}
    </div>
  );
}
