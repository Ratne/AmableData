import { attrBoolean, attrEnum, attrNullableString, attrNumber, attrString } from './attrs';
import {
  conditionCloseTag,
  conditionOpenTag,
  containsLiquidDelimiters,
  variableExpression,
} from './liquid-syntax';
import { CONDITION_OPERATORS, EMAIL_NODES, LIQUID_NODES, type TiptapNode } from './schema';

/**
 * Plain-text version of the email, generated from the same document so it
 * always matches the HTML. Liquid stays unresolved, like the HTML template.
 */

export interface TextSerializeInput {
  readonly blocks: readonly TiptapNode[];
  readonly unsubscribeLabel: string;
  readonly footerAddress: string | null;
}

/** Author text with Liquid delimiters is wrapped in `raw` so it prints literally. */
function literal(text: string): string {
  if (!containsLiquidDelimiters(text)) return text;
  return `{% raw %}${text.replace(/endraw/g, 'end raw')}{% endraw %}`;
}

function linkTarget(href: string | null): string | null {
  if (href === null) return null;
  const trimmed = href.trim();
  if (/\{\{/.test(trimmed)) return trimmed.replace(/\{%[\s\S]*?%\}/g, '');
  return /^(https?:|mailto:|tel:)/i.test(trimmed) ? trimmed : null;
}

function inline(nodes: readonly TiptapNode[] | undefined): string {
  if (!nodes) return '';
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text': {
          const text = literal(node.text ?? '');
          const link = node.marks?.find((mark) => mark.type === 'link');
          const href = link ? linkTarget(attrNullableString(link, 'href')) : null;
          return href && href !== node.text ? `${text} (${href})` : text;
        }
        case 'hardBreak':
          return '\n';
        case LIQUID_NODES.variable:
          return (
            variableExpression({
              path: attrString(node, 'path'),
              fallback: attrNullableString(node, 'fallback'),
              filter: attrNullableString(node, 'filter'),
            }) ?? ''
          );
        case 'image': {
          const alt = attrString(node, 'alt');
          return alt ? `[${literal(alt)}]` : '';
        }
        default:
          return inline(node.content);
      }
    })
    .join('');
}

function blocks(nodes: readonly TiptapNode[] | undefined, footer: TextSerializeInput): string[] {
  return (nodes ?? []).flatMap((node) => block(node, footer));
}

function list(
  node: TiptapNode,
  ordered: boolean,
  task: boolean,
  footer: TextSerializeInput,
): string[] {
  const start = attrNumber(node, 'start', 1);
  const lines = (node.content ?? []).map((item, index) => {
    const bullet = task
      ? attrBoolean(item, 'checked')
        ? '[x]'
        : '[ ]'
      : ordered
        ? `${String(start + index)}.`
        : '-';
    const body = (item.content ?? [])
      .map((child) =>
        child.type === 'paragraph' ? inline(child.content) : blocks([child], footer).join('\n'),
      )
      .join('\n')
      .replace(/\n/g, '\n   ');
    return `${bullet} ${body}`;
  });
  return [lines.join('\n')];
}

function block(node: TiptapNode, input: TextSerializeInput): string[] {
  switch (node.type) {
    case 'paragraph':
      return [inline(node.content)];
    case 'heading': {
      const text = inline(node.content);
      return attrNumber(node, 'level', 2) <= 1 ? [text.toUpperCase()] : [text];
    }
    case 'bulletList':
      return list(node, false, false, input);
    case 'orderedList':
      return list(node, true, false, input);
    case 'taskList':
      return list(node, false, true, input);
    case 'blockquote':
      return [blocks(node.content, input).join('\n\n').replace(/^/gm, '> ')];
    case 'codeBlock':
      return [literal((node.content ?? []).map((child) => child.text ?? '').join(''))];
    case 'horizontalRule':
      return ['---'];
    case 'image': {
      const alt = attrString(node, 'alt');
      return alt ? [`[${literal(alt)}]`] : [];
    }
    case EMAIL_NODES.button: {
      const href = linkTarget(attrNullableString(node, 'href'));
      const label = literal(attrString(node, 'label', 'Open'));
      return [href ? `${label}: ${href}` : label];
    }
    case EMAIL_NODES.spacer:
    case EMAIL_NODES.preheader:
      return [];
    case EMAIL_NODES.columns:
      return (node.content ?? []).flatMap((column) => blocks(column.content, input));
    case EMAIL_NODES.header:
      return blocks(node.content, input);
    case EMAIL_NODES.footer: {
      const label = attrString(node, 'unsubscribeLabel') || input.unsubscribeLabel;
      return [
        '---',
        ...blocks(node.content, input),
        ...(input.footerAddress ? [literal(input.footerAddress)] : []),
        `${literal(label)}: {{ unsubscribe_url }}`,
      ];
    }
    case LIQUID_NODES.condition: {
      const attrs = {
        kind: attrEnum(node, 'kind', ['tag', 'field', 'expression'] as const, 'tag'),
        tag: attrNullableString(node, 'tag'),
        field: attrNullableString(node, 'field'),
        operator: attrEnum(node, 'operator', CONDITION_OPERATORS, 'equals'),
        value: attrNullableString(node, 'value'),
        expression: attrNullableString(node, 'expression'),
        negate: attrBoolean(node, 'negate'),
      };
      const branches = node.content ?? [];
      const thenBranch = branches.find((branch) => attrString(branch, 'branch') !== 'else');
      const elseBranch = branches.find((branch) => attrString(branch, 'branch') === 'else');
      const open = conditionOpenTag(attrs);
      if (open === null) return blocks(thenBranch?.content, input);
      const thenText = blocks(thenBranch?.content, input).join('\n\n');
      const elseText = elseBranch ? blocks(elseBranch.content, input).join('\n\n') : '';
      // Tags glue to their content so a false branch leaves no stray blank lines.
      return [
        `${open}${thenText}${elseText ? `{% else %}${elseText}` : ''}${conditionCloseTag(attrs)}`,
      ];
    }
    case LIQUID_NODES.branch:
      return blocks(node.content, input);
    case LIQUID_NODES.raw:
      // Raw blocks often carry markup meant for the HTML part; the text part keeps only the Liquid and the words.
      return [attrString(node, 'code').replace(/<[^>]*>/g, '')];
    default:
      return node.content ? blocks(node.content, input) : [];
  }
}

export function serializeText(input: TextSerializeInput): string {
  return blocks(input.blocks, input)
    .filter((chunk) => chunk.trim() !== '')
    .join('\n\n');
}

/** Collapses the blank-line runs that false conditions leave behind after rendering. */
export function tidyText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
