import {
  CONDITION_OPERATORS,
  conditionCloseTag,
  conditionOpenTag,
  LIQUID_NODES,
  variableExpression,
  type ConditionKind,
  type ConditionOperator,
  type LiquidConditionAttrs,
} from '@amable/email-render';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import { Mention, type MentionOptions } from '@tiptap/extension-mention';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  ReactRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { useState } from 'react';
import { searchFields, type LiquidFieldGroup } from '../fields';
import { DEFAULT_EDITOR_LABELS, type EditorLabels } from '../labels';
import {
  FieldPicker,
  type FieldPickerHandle,
  type FieldPickerItem,
  type FieldPickerProps,
} from '../ui/field-picker';

/**
 * Liquid authoring: `{{` opens a field picker and inserts a chip stored as
 * `{{ path | filter | default: "…" }}`; a visual condition block becomes
 * `{% if %}…{% else %}…{% endif %}`; a raw block holds Liquid for experts.
 * The Liquid source is produced by `@amable/email-render`, the single place
 * that knows the syntax.
 */

export interface LiquidOptions {
  readonly labels: EditorLabels;
  readonly fields: readonly LiquidFieldGroup[];
}

function labelsOf(props: NodeViewProps): EditorLabels {
  return (props.extension.options as LiquidOptions).labels;
}

function VariableView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const [open, setOpen] = useState(false);
  const attrs = props.node.attrs as {
    path: string;
    fallback: string | null;
    label: string | null;
    filter: string | null;
  };
  const source = variableExpression(attrs) ?? '';
  return (
    <NodeViewWrapper as="span" className="amable-liquid-chip-wrapper">
      <button
        type="button"
        className="amable-liquid-chip"
        data-selected={props.selected}
        title={source}
        contentEditable={false}
        onClick={() => props.editor.isEditable && setOpen((value) => !value)}
      >
        {attrs.label ?? attrs.path}
        {attrs.fallback ? (
          <span className="amable-liquid-chip-fallback"> · {attrs.fallback}</span>
        ) : null}
      </button>
      {open ? (
        <span className="amable-block-panel amable-liquid-chip-panel" contentEditable={false}>
          <label>
            <span>{labels.fallback}</span>
            <input
              autoFocus
              value={attrs.fallback ?? ''}
              placeholder={labels.fallbackPlaceholder}
              onChange={(event) => props.updateAttributes({ fallback: event.target.value || null })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                  props.editor.commands.focus();
                }
              }}
            />
          </label>
          <code>{source}</code>
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

function suggestionRenderer(getOptions: () => LiquidOptions) {
  return () => {
    let renderer: ReactRenderer<FieldPickerHandle, FieldPickerProps> | null = null;
    let reference: SuggestionProps<FieldPickerItem>['clientRect'] = null;

    const place = () => {
      const element = renderer?.element as HTMLElement | undefined;
      const rect = reference?.();
      if (!element || !rect) return;
      void computePosition({ getBoundingClientRect: () => rect }, element, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        Object.assign(element.style, {
          position: 'fixed',
          left: `${String(x)}px`,
          top: `${String(y)}px`,
          zIndex: '60',
        });
      });
    };

    const toProps = (props: SuggestionProps<FieldPickerItem>): FieldPickerProps => ({
      items: props.items,
      emptyLabel: getOptions().labels.noFields,
      command: (item) => props.command(item),
    });

    return {
      onStart: (props: SuggestionProps<FieldPickerItem>) => {
        renderer = new ReactRenderer(FieldPicker, { props: toProps(props), editor: props.editor });
        reference = props.clientRect;
        document.body.appendChild(renderer.element);
        place();
      },
      onUpdate: (props: SuggestionProps<FieldPickerItem>) => {
        renderer?.updateProps(toProps(props));
        reference = props.clientRect;
        place();
      },
      onKeyDown: (props: SuggestionKeyDownProps) => {
        if (props.event.key === 'Escape') {
          renderer?.destroy();
          renderer?.element.remove();
          renderer = null;
          return true;
        }
        return renderer?.ref?.onKeyDown(props.event) ?? false;
      },
      onExit: () => {
        renderer?.destroy();
        renderer?.element.remove();
        renderer = null;
      },
    };
  };
}

type LiquidVariableOptions = MentionOptions<FieldPickerItem, FieldPickerItem> & LiquidOptions;

function optionsFrom(editor: Editor): LiquidOptions {
  const extension = editor.extensionManager.extensions.find(
    (candidate) => candidate.name === LIQUID_NODES.variable,
  );
  return (
    (extension?.options as LiquidOptions | undefined) ?? {
      labels: DEFAULT_EDITOR_LABELS,
      fields: [],
    }
  );
}

export const LiquidVariable = Mention.extend<LiquidVariableOptions>({
  name: LIQUID_NODES.variable,

  addOptions() {
    let current: Editor | null = null;
    return {
      ...(this.parent?.() as MentionOptions<FieldPickerItem, FieldPickerItem>),
      labels: DEFAULT_EDITOR_LABELS,
      fields: [],
      suggestion: {
        char: '{{',
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query, editor }) => {
          current = editor;
          return searchFields(optionsFrom(editor).fields, query).slice(0, 30);
        },
        command: ({ editor, range, props }) => {
          // Swallow a closing `}}` typed by habit right after the trigger.
          const after = editor.state.doc.textBetween(
            range.to,
            Math.min(range.to + 2, editor.state.doc.content.size),
            '',
            '',
          );
          const to = after === '}}' ? range.to + 2 : range.to;
          editor
            .chain()
            .focus()
            .insertContentAt({ from: range.from, to }, [
              {
                type: LIQUID_NODES.variable,
                attrs: {
                  path: props.field.path,
                  label: props.field.label,
                  filter: props.field.filter ?? null,
                  fallback: null,
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: suggestionRenderer(() =>
          current ? optionsFrom(current) : { labels: DEFAULT_EDITOR_LABELS, fields: [] },
        ),
      },
    };
  },

  addAttributes() {
    return {
      path: { default: '' },
      fallback: { default: null },
      label: { default: null },
      filter: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: `span[data-type="${LIQUID_NODES.variable}"]`,
        getAttrs: (element) => ({
          path: element.getAttribute('data-path') ?? '',
          fallback: element.getAttribute('data-fallback'),
          label: element.getAttribute('data-label'),
          filter: element.getAttribute('data-filter'),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as {
      path: string;
      fallback: string | null;
      label: string | null;
      filter: string | null;
    };
    return [
      'span',
      mergeAttributes(
        { 'data-type': LIQUID_NODES.variable, 'data-path': attrs.path },
        attrs.fallback ? { 'data-fallback': attrs.fallback } : {},
        attrs.label ? { 'data-label': attrs.label } : {},
        attrs.filter ? { 'data-filter': attrs.filter } : {},
        HTMLAttributes,
      ),
      variableExpression(attrs) ?? '',
    ];
  },

  renderText({ node }) {
    return (
      variableExpression(
        node.attrs as { path: string; fallback: string | null; filter: string | null },
      ) ?? ''
    );
  },

  addNodeView() {
    return ReactNodeViewRenderer(VariableView);
  },
});

function ConditionView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const attrs = props.node.attrs as LiquidConditionAttrs;
  const editable = props.editor.isEditable;
  const hasElse = props.node.childCount > 1;
  const source = conditionOpenTag(attrs);

  const toggleElse = () => {
    const pos = props.getPos();
    if (typeof pos !== 'number') return;
    const end = pos + props.node.nodeSize - 1;
    if (hasElse) {
      const last = props.node.lastChild;
      if (!last) return;
      props.editor
        .chain()
        .focus()
        .deleteRange({ from: end - last.nodeSize, to: end })
        .run();
    } else {
      props.editor
        .chain()
        .focus()
        .insertContentAt(end, {
          type: LIQUID_NODES.branch,
          attrs: { branch: 'else' },
          content: [{ type: 'paragraph' }],
        })
        .run();
    }
  };

  return (
    <NodeViewWrapper className="amable-liquid-condition" data-selected={props.selected}>
      <div className="amable-liquid-condition-bar" contentEditable={false}>
        <strong>{labels.conditionIf}</strong>
        <select
          disabled={!editable}
          value={attrs.kind}
          onChange={(event) =>
            props.updateAttributes({ kind: event.target.value as ConditionKind })
          }
          aria-label={labels.condition}
        >
          <option value="tag">{labels.conditionTag}</option>
          <option value="field">{labels.conditionField}</option>
          <option value="expression">{labels.conditionExpression}</option>
        </select>
        {attrs.kind === 'tag' ? (
          <>
            <select
              disabled={!editable}
              value={attrs.negate ? 'not' : 'has'}
              onChange={(event) => props.updateAttributes({ negate: event.target.value === 'not' })}
            >
              <option value="has">{labels.conditionHasTag}</option>
              <option value="not">{labels.conditionHasNotTag}</option>
            </select>
            <input
              disabled={!editable}
              value={attrs.tag ?? ''}
              placeholder="VIP"
              onChange={(event) => props.updateAttributes({ tag: event.target.value })}
            />
          </>
        ) : attrs.kind === 'field' ? (
          <>
            <select
              disabled={!editable}
              value={attrs.field ?? ''}
              onChange={(event) => props.updateAttributes({ field: event.target.value })}
              aria-label={labels.conditionField}
            >
              <option value="" />
              {(props.extension.options as LiquidOptions).fields.flatMap((group) =>
                group.fields
                  .filter((field) => field.path !== 'now')
                  .map((field) => (
                    <option key={`${group.id}:${field.path}`} value={field.path}>
                      {group.label} · {field.label}
                    </option>
                  )),
              )}
            </select>
            <select
              disabled={!editable}
              value={attrs.operator}
              onChange={(event) =>
                props.updateAttributes({ operator: event.target.value as ConditionOperator })
              }
            >
              {CONDITION_OPERATORS.map((operator) => (
                <option key={operator} value={operator}>
                  {labels.operators[operator]}
                </option>
              ))}
            </select>
            {attrs.operator !== 'is_blank' && attrs.operator !== 'is_present' ? (
              <input
                disabled={!editable}
                value={attrs.value ?? ''}
                placeholder={labels.value}
                onChange={(event) => props.updateAttributes({ value: event.target.value })}
              />
            ) : null}
          </>
        ) : (
          <input
            disabled={!editable}
            className="amable-liquid-mono"
            value={attrs.expression ?? ''}
            placeholder="order.total > 100"
            onChange={(event) => props.updateAttributes({ expression: event.target.value })}
          />
        )}
        <code className="amable-liquid-condition-source" data-invalid={source === null}>
          {source ?? '…'}
        </code>
        {editable ? (
          <button type="button" className="amable-link-button" onClick={toggleElse}>
            {hasElse ? labels.conditionRemoveOtherwise : labels.conditionAddOtherwise}
          </button>
        ) : null}
      </div>
      <NodeViewContent className="amable-liquid-condition-content" />
      <div className="amable-liquid-condition-end" contentEditable={false}>
        <code>{conditionCloseTag(attrs)}</code>
      </div>
    </NodeViewWrapper>
  );
}

export const LiquidCondition = Node.create<LiquidOptions>({
  name: LIQUID_NODES.condition,
  group: 'block',
  content: `${LIQUID_NODES.branch}{1,2}`,
  isolating: true,
  defining: true,
  draggable: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS, fields: [] }),
  addAttributes: () => ({
    kind: { default: 'tag' },
    tag: { default: null },
    field: { default: null },
    operator: { default: 'equals' },
    value: { default: null },
    expression: { default: null },
    negate: { default: false },
  }),
  parseHTML: () => [{ tag: `div[data-type="${LIQUID_NODES.condition}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': LIQUID_NODES.condition }),
    0,
  ],
  addNodeView() {
    return ReactNodeViewRenderer(ConditionView);
  },
});

function BranchView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const isElse = props.node.attrs['branch'] === 'else';
  return (
    <NodeViewWrapper className="amable-liquid-branch" data-branch={isElse ? 'else' : 'then'}>
      {isElse ? (
        <div className="amable-liquid-branch-label" contentEditable={false}>
          {labels.conditionOtherwise}
        </div>
      ) : null}
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

export const LiquidBranch = Node.create<LiquidOptions>({
  name: LIQUID_NODES.branch,
  content: 'block+',
  isolating: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS, fields: [] }),
  addAttributes: () => ({ branch: { default: 'then' } }),
  parseHTML: () => [{ tag: `div[data-type="${LIQUID_NODES.branch}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': LIQUID_NODES.branch }),
    0,
  ],
  addNodeView() {
    return ReactNodeViewRenderer(BranchView);
  },
});

function RawView(props: NodeViewProps) {
  const labels = labelsOf(props);
  const code = String(props.node.attrs['code'] ?? '');
  return (
    <NodeViewWrapper
      className="amable-liquid-raw"
      data-selected={props.selected}
      contentEditable={false}
    >
      <div className="amable-liquid-raw-label">
        <strong>{labels.rawLiquid}</strong> <small>{labels.rawLiquidHint}</small>
      </div>
      <textarea
        className="amable-liquid-mono"
        spellCheck={false}
        readOnly={!props.editor.isEditable}
        value={code}
        rows={Math.min(12, Math.max(3, code.split('\n').length + 1))}
        onChange={(event) => props.updateAttributes({ code: event.target.value })}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </NodeViewWrapper>
  );
}

export const LiquidRaw = Node.create<LiquidOptions>({
  name: LIQUID_NODES.raw,
  group: 'block',
  atom: true,
  draggable: true,
  addOptions: () => ({ labels: DEFAULT_EDITOR_LABELS, fields: [] }),
  addAttributes: () => ({ code: { default: '' } }),
  parseHTML: () => [
    {
      tag: `pre[data-type="${LIQUID_NODES.raw}"]`,
      getAttrs: (element) => ({ code: element.textContent ?? '' }),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'pre',
    mergeAttributes(HTMLAttributes, { 'data-type': LIQUID_NODES.raw }),
    String(node.attrs['code'] ?? ''),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(RawView);
  },
});
