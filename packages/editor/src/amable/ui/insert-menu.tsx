import { EMAIL_NODES, LIQUID_NODES } from '@amable/email-render';
import type { Editor, JSONContent } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { ChevronDownIcon } from '../../components/tiptap-icons/chevron-down-icon';
import { Button } from '../../components/tiptap-ui-primitive/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/tiptap-ui-primitive/dropdown-menu';
import type { EditorLabels } from '../labels';
import { PlusIcon } from './icons';

const paragraph = (): JSONContent => ({ type: 'paragraph' });
const column = (): JSONContent => ({ type: EMAIL_NODES.column, content: [paragraph()] });

function hasTopLevel(editor: Editor, type: string): boolean {
  let found = false;
  editor.state.doc.forEach((child) => {
    if (child.type.name === type) found = true;
  });
  return found;
}

export interface InsertMenuProps {
  readonly editor: Editor;
  readonly labels: EditorLabels;
  readonly email: boolean;
  readonly liquid: boolean;
}

/** One menu for every custom block: email layout pieces and Liquid logic. */
export function InsertMenu({ editor, labels, email, liquid }: InsertMenuProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      hasHeader: email && hasTopLevel(current, EMAIL_NODES.header),
      hasPreheader: email && hasTopLevel(current, EMAIL_NODES.preheader),
    }),
  });

  const insert = (content: JSONContent) => editor.chain().focus().insertContent(content).run();
  const insertAtStart = (content: JSONContent) =>
    editor.chain().focus().insertContentAt(0, content).run();

  const items: { id: string; label: string; run: () => void; hidden?: boolean }[] = [
    ...(email
      ? [
          {
            id: 'button',
            label: labels.button,
            run: () => insert({ type: EMAIL_NODES.button, attrs: { label: labels.button } }),
          },
          { id: 'divider', label: labels.divider, run: () => insert({ type: 'horizontalRule' }) },
          { id: 'spacer', label: labels.spacer, run: () => insert({ type: EMAIL_NODES.spacer }) },
          {
            id: 'columns2',
            label: labels.columns2,
            run: () => insert({ type: EMAIL_NODES.columns, content: [column(), column()] }),
          },
          {
            id: 'columns3',
            label: labels.columns3,
            run: () =>
              insert({ type: EMAIL_NODES.columns, content: [column(), column(), column()] }),
          },
          {
            id: 'header',
            label: labels.header,
            hidden: state.hasHeader,
            run: () => insertAtStart({ type: EMAIL_NODES.header, content: [paragraph()] }),
          },
          {
            id: 'preheader',
            label: labels.preheader,
            hidden: state.hasPreheader,
            run: () => insertAtStart({ type: EMAIL_NODES.preheader }),
          },
        ]
      : []),
    ...(liquid
      ? [
          {
            id: 'field',
            label: labels.insertField,
            run: () => editor.chain().focus().insertContent('{{').run(),
          },
          {
            id: 'condition',
            label: labels.condition,
            run: () =>
              insert({
                type: LIQUID_NODES.condition,
                content: [
                  { type: LIQUID_NODES.branch, attrs: { branch: 'then' }, content: [paragraph()] },
                ],
              }),
          },
          { id: 'raw', label: labels.rawLiquid, run: () => insert({ type: LIQUID_NODES.raw }) },
        ]
      : []),
  ];

  if (items.length === 0) return null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="button"
          tabIndex={-1}
          aria-label={labels.insert}
          tooltip={labels.insert}
        >
          <PlusIcon className="tiptap-button-icon" />
          <span className="tiptap-button-text">{labels.insert}</span>
          <ChevronDownIcon className="tiptap-button-dropdown-small" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {items
            .filter((item) => !item.hidden)
            .map((item) => (
              <DropdownMenuItem key={item.id} asChild onSelect={item.run}>
                <Button type="button" variant="ghost">
                  <span className="tiptap-button-text">{item.label}</span>
                </Button>
              </DropdownMenuItem>
            ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
