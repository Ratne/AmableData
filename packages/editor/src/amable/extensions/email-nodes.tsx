import { EMAIL_NODES } from '@amable/email-render';
import { mergeAttributes, Node } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { DEFAULT_EDITOR_LABELS, type EditorLabels } from '../labels';

/**
 * Email building blocks. Attributes mirror `@amable/email-render`'s schema,
 * which turns them into table-based HTML; the views here are only an editing
 * approximation. Header, footer and preheader belong to the `emailFrame`
 * group, which the email document allows only at the top level.
 */

export interface EmailNodeOptions {
  readonly labels: EditorLabels;
}

function labelsOf(props: NodeViewProps): EditorLabels {
  return (props.extension.options as EmailNodeOptions).labels;
}

function ButtonView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const attrs = props.node.attrs as {
    label: string;
    href: string;
    align: 'left' | 'center' | 'right';
    backgroundColor: string;
    textColor: string;
  };
  const editable = props.editor.isEditable;
  return (
    <NodeViewWrapper
      className="amable-email-block"
      data-selected={props.selected}
      data-type={EMAIL_NODES.button}
    >
      <div
        className="amable-email-button-row"
        style={{ textAlign: attrs.align }}
        contentEditable={false}
      >
        <span
          className="amable-email-button"
          style={{ backgroundColor: attrs.backgroundColor, color: attrs.textColor }}
        >
          {attrs.label || labels.button}
        </span>
      </div>
      {props.selected && editable ? (
        <div className="amable-block-panel" contentEditable={false}>
          <label>
            <span>{labels.buttonLabel}</span>
            <input
              value={attrs.label}
              onChange={(event) => props.updateAttributes({ label: event.target.value })}
            />
          </label>
          <label>
            <span>{labels.buttonLink}</span>
            <input
              value={attrs.href}
              placeholder="https://"
              onChange={(event) => props.updateAttributes({ href: event.target.value })}
            />
          </label>
          <label>
            <span>{labels.align}</span>
            <select
              value={attrs.align}
              onChange={(event) => props.updateAttributes({ align: event.target.value })}
            >
              <option value="left">{labels.alignLeft}</option>
              <option value="center">{labels.alignCenter}</option>
              <option value="right">{labels.alignRight}</option>
            </select>
          </label>
          <label>
            <span>{labels.color}</span>
            <input
              type="color"
              value={attrs.backgroundColor}
              onChange={(event) => props.updateAttributes({ backgroundColor: event.target.value })}
            />
          </label>
          <label>
            <span>{labels.textColor}</span>
            <input
              type="color"
              value={attrs.textColor}
              onChange={(event) => props.updateAttributes({ textColor: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

export const EmailButton = Node.create<EmailNodeOptions>({
  name: EMAIL_NODES.button,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS }),
  addAttributes: () => ({
    label: { default: 'Open' },
    href: { default: '' },
    align: { default: 'center' },
    backgroundColor: { default: '#2563eb' },
    textColor: { default: '#ffffff' },
  }),
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.button}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': EMAIL_NODES.button }),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(ButtonView);
  },
});

function SpacerView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const height = Number(props.node.attrs['height']) || 24;
  return (
    <NodeViewWrapper
      className="amable-email-block"
      data-selected={props.selected}
      data-type={EMAIL_NODES.spacer}
    >
      <div className="amable-email-spacer" style={{ height }} contentEditable={false}>
        <span>
          {labels.spacer} · {height}px
        </span>
      </div>
      {props.selected && props.editor.isEditable ? (
        <div className="amable-block-panel" contentEditable={false}>
          <label>
            <span>{labels.height}</span>
            <input
              type="range"
              min={4}
              max={160}
              step={4}
              value={height}
              onChange={(event) => props.updateAttributes({ height: Number(event.target.value) })}
            />
          </label>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

export const EmailSpacer = Node.create<EmailNodeOptions>({
  name: EMAIL_NODES.spacer,
  group: 'block',
  atom: true,
  draggable: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS }),
  addAttributes: () => ({ height: { default: 24 } }),
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.spacer}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': EMAIL_NODES.spacer }),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(SpacerView);
  },
});

export const EmailColumns = Node.create({
  name: EMAIL_NODES.columns,
  group: 'block',
  content: `${EMAIL_NODES.column}{2,3}`,
  isolating: true,
  draggable: true,
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.columns}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-type': EMAIL_NODES.columns,
      class: 'amable-email-columns',
    }),
    0,
  ],
});

export const EmailColumn = Node.create({
  name: EMAIL_NODES.column,
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.column}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-type': EMAIL_NODES.column,
      class: 'amable-email-column',
    }),
    0,
  ],
});

function FrameView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const isFooter = props.node.type.name === EMAIL_NODES.footer;
  const unsubscribeLabel = String(props.node.attrs['unsubscribeLabel'] ?? '');
  return (
    <NodeViewWrapper className="amable-email-frame" data-type={props.node.type.name}>
      <div className="amable-email-frame-label" contentEditable={false}>
        {isFooter ? labels.footer : labels.header}
      </div>
      <NodeViewContent className="amable-email-frame-content" />
      {isFooter ? (
        <div className="amable-email-unsubscribe" contentEditable={false}>
          <input
            aria-label={labels.unsubscribeLabel}
            value={unsubscribeLabel}
            readOnly={!props.editor.isEditable}
            onChange={(event) => props.updateAttributes({ unsubscribeLabel: event.target.value })}
          />
          <small>{labels.unsubscribeNote}</small>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

export const EmailHeader = Node.create<EmailNodeOptions>({
  name: EMAIL_NODES.header,
  group: 'emailFrame',
  content: 'block+',
  isolating: true,
  defining: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS }),
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.header}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': EMAIL_NODES.header }),
    0,
  ],
  addNodeView() {
    return ReactNodeViewRenderer(FrameView);
  },
});

export const EmailFooter = Node.create<EmailNodeOptions>({
  name: EMAIL_NODES.footer,
  group: 'emailFrame',
  content: 'block*',
  isolating: true,
  defining: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS }),
  addAttributes: () => ({ unsubscribeLabel: { default: 'Unsubscribe' } }),
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.footer}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': EMAIL_NODES.footer }),
    0,
  ],
  addNodeView() {
    return ReactNodeViewRenderer(FrameView);
  },
});

function PreheaderView(props: NodeViewProps) {
  const labels = labelsOf(props);
  return (
    <NodeViewWrapper
      className="amable-email-preheader"
      data-type={EMAIL_NODES.preheader}
      contentEditable={false}
    >
      <span>{labels.preheader}</span>
      <input
        value={String(props.node.attrs['text'] ?? '')}
        placeholder={labels.preheaderPlaceholder}
        readOnly={!props.editor.isEditable}
        maxLength={150}
        onChange={(event) => props.updateAttributes({ text: event.target.value })}
      />
    </NodeViewWrapper>
  );
}

export const EmailPreheader = Node.create<EmailNodeOptions>({
  name: EMAIL_NODES.preheader,
  group: 'emailFrame',
  atom: true,
  selectable: false,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS }),
  addAttributes: () => ({ text: { default: '' } }),
  parseHTML: () => [{ tag: `div[data-type="${EMAIL_NODES.preheader}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': EMAIL_NODES.preheader }),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(PreheaderView);
  },
});

/** The standard image node plus a click-through link and alignment, used by the email renderer. */
export const ImageWithLink = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      href: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-href'),
        renderHTML: (attrs) => (attrs['href'] ? { 'data-href': attrs['href'] } : {}),
      },
    };
  },
});
