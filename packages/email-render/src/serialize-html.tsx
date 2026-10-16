import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Row,
  Section,
  Text,
} from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import { Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  attrBoolean,
  attrEnum,
  attrNullableString,
  attrNumber,
  attrString,
  clamp,
  safeColor,
} from './attrs';
import { conditionCloseTag, conditionOpenTag, variableExpression } from './liquid-syntax';
import {
  CONDITION_OPERATORS,
  EMAIL_NODES,
  LIQUID_NODES,
  type LiquidConditionAttrs,
  type TiptapMark,
  type TiptapNode,
} from './schema';
import type { EmailTheme } from './theme';
import { LiquidTokens } from './tokens';

export interface HtmlSerializeInput {
  readonly blocks: readonly TiptapNode[];
  readonly preheader: string;
  readonly theme: EmailTheme;
  readonly lang: string;
  readonly unsubscribeLabel: string;
  readonly footerAddress: string | null;
}

interface Ctx {
  readonly tokens: LiquidTokens;
  readonly theme: EmailTheme;
  readonly unsubscribeLabel: string;
  readonly footerAddress: string | null;
}

const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
const SAFE_URL_RE = /^(https?:|mailto:|tel:)/i;
const SAFE_IMAGE_RE = /^https?:/i;

function textAlign(node: TiptapNode): CSSProperties['textAlign'] | undefined {
  const value = node.attrs?.['textAlign'];
  return typeof value === 'string' && (TEXT_ALIGNS as readonly string[]).includes(value)
    ? (value as CSSProperties['textAlign'])
    : undefined;
}

/** Link targets: literal http(s)/mailto/tel, or Liquid output resolved per recipient and re-checked by the sanitizer. */
function safeHref(value: string | null, ctx: Ctx): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/\{\{/.test(trimmed)) return ctx.tokens.mixed(trimmed);
  return SAFE_URL_RE.test(trimmed) ? trimmed : undefined;
}

function safeImageSrc(value: string | null, ctx: Ctx): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/\{\{/.test(trimmed)) return ctx.tokens.mixed(trimmed);
  return SAFE_IMAGE_RE.test(trimmed) ? trimmed : undefined;
}

function applyMark(mark: TiptapMark, child: ReactNode, ctx: Ctx, key: number): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{child}</strong>;
    case 'italic':
      return <em key={key}>{child}</em>;
    case 'underline':
      return <u key={key}>{child}</u>;
    case 'strike':
      return <s key={key}>{child}</s>;
    case 'superscript':
      return <sup key={key}>{child}</sup>;
    case 'subscript':
      return <sub key={key}>{child}</sub>;
    case 'code':
      return (
        <code
          key={key}
          style={{
            fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '0.9em',
            backgroundColor: '#f4f4f5',
            padding: '1px 4px',
            borderRadius: 4,
          }}
        >
          {child}
        </code>
      );
    case 'highlight':
      return (
        <mark
          key={key}
          style={{
            backgroundColor: safeColor(attrNullableString(mark, 'color'), '#fef08a'),
            color: 'inherit',
          }}
        >
          {child}
        </mark>
      );
    case 'textStyle': {
      const color = attrNullableString(mark, 'color');
      return color ? (
        <span key={key} style={{ color: safeColor(color, ctx.theme.textColor) }}>
          {child}
        </span>
      ) : (
        <Fragment key={key}>{child}</Fragment>
      );
    }
    case 'link': {
      const href = safeHref(attrNullableString(mark, 'href'), ctx);
      if (href === undefined) return <Fragment key={key}>{child}</Fragment>;
      return (
        <Link
          key={key}
          href={href}
          target="_blank"
          style={{ color: ctx.theme.linkColor, textDecoration: 'underline' }}
        >
          {child}
        </Link>
      );
    }
    default:
      return <Fragment key={key}>{child}</Fragment>;
  }
}

function renderInline(nodes: readonly TiptapNode[] | undefined, ctx: Ctx): ReactNode[] {
  if (!nodes) return [];
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': {
        let out: ReactNode = ctx.tokens.text(node.text ?? '');
        // Link outermost so the whole styled run is clickable.
        const marks = [...(node.marks ?? [])].sort(
          (a, b) => (a.type === 'link' ? 1 : 0) - (b.type === 'link' ? 1 : 0),
        );
        marks.forEach((mark, markIndex) => {
          out = applyMark(mark, out, ctx, markIndex);
        });
        return <Fragment key={index}>{out}</Fragment>;
      }
      case 'hardBreak':
        return <br key={index} />;
      case LIQUID_NODES.variable: {
        const expression = variableExpression({
          path: attrString(node, 'path'),
          fallback: attrNullableString(node, 'fallback'),
          filter: attrNullableString(node, 'filter'),
        });
        return (
          <Fragment key={index}>{expression === null ? '' : ctx.tokens.raw(expression)}</Fragment>
        );
      }
      case 'image':
        return <Fragment key={index}>{renderImage(node, ctx)}</Fragment>;
      default:
        return <Fragment key={index}>{renderInline(node.content, ctx)}</Fragment>;
    }
  });
}

function paragraphStyle(node: TiptapNode, ctx: Ctx, margin = '0 0 16px'): CSSProperties {
  return {
    margin,
    fontSize: 16,
    lineHeight: '26px',
    color: ctx.theme.textColor,
    textAlign: textAlign(node),
  };
}

const HEADING_SIZES: Record<number, { fontSize: number; lineHeight: string }> = {
  1: { fontSize: 30, lineHeight: '38px' },
  2: { fontSize: 24, lineHeight: '32px' },
  3: { fontSize: 20, lineHeight: '28px' },
  4: { fontSize: 17, lineHeight: '26px' },
};

function renderImage(node: TiptapNode, ctx: Ctx): ReactNode {
  const src = safeImageSrc(attrNullableString(node, 'src'), ctx);
  if (src === undefined) return null;
  const width = attrNumber(node, 'width', 0);
  const maxWidth = ctx.theme.width - 64;
  const img = (
    <Img
      src={src}
      alt={attrString(node, 'alt')}
      width={width > 0 ? Math.min(width, maxWidth) : undefined}
      style={{ display: 'block', maxWidth: '100%', height: 'auto', border: 0, margin: '0 auto' }}
    />
  );
  const href = safeHref(attrNullableString(node, 'href'), ctx);
  return href === undefined ? (
    img
  ) : (
    <Link href={href} target="_blank">
      {img}
    </Link>
  );
}

function renderList(node: TiptapNode, ctx: Ctx, ordered: boolean, task: boolean): ReactNode {
  const style: CSSProperties = {
    margin: '0 0 16px',
    paddingLeft: task ? 0 : 24,
    listStyleType: task ? 'none' : undefined,
    color: ctx.theme.textColor,
  };
  const items = (node.content ?? []).map((item, index) => {
    const prefix = task ? (attrBoolean(item, 'checked') ? '☑ ' : '☐ ') : null;
    return (
      <li key={index} style={{ margin: '0 0 4px', fontSize: 16, lineHeight: '26px' }}>
        {prefix}
        {(item.content ?? []).map((child, childIndex) =>
          child.type === 'paragraph' ? (
            <Fragment key={childIndex}>{renderInline(child.content, ctx)}</Fragment>
          ) : (
            <Fragment key={childIndex}>{renderBlock(child, ctx)}</Fragment>
          ),
        )}
      </li>
    );
  });
  return ordered ? (
    <ol style={style} start={attrNumber(node, 'start', 1)}>
      {items}
    </ol>
  ) : (
    <ul style={style}>{items}</ul>
  );
}

function conditionAttrs(node: TiptapNode): LiquidConditionAttrs {
  return {
    kind: attrEnum(node, 'kind', ['tag', 'field', 'expression'] as const, 'tag'),
    tag: attrNullableString(node, 'tag'),
    field: attrNullableString(node, 'field'),
    operator: attrEnum(node, 'operator', CONDITION_OPERATORS, 'equals'),
    value: attrNullableString(node, 'value'),
    expression: attrNullableString(node, 'expression'),
    negate: attrBoolean(node, 'negate'),
  };
}

export function renderBlocks(nodes: readonly TiptapNode[] | undefined, ctx: Ctx): ReactNode[] {
  return (nodes ?? []).map((node, index) => (
    <Fragment key={index}>{renderBlock(node, ctx)}</Fragment>
  ));
}

function renderFooter(node: TiptapNode, ctx: Ctx): ReactNode {
  const small: CSSProperties = {
    margin: '0 0 8px',
    fontSize: 12,
    lineHeight: '18px',
    color: ctx.theme.mutedTextColor,
    textAlign: 'center',
  };
  const label = attrString(node, 'unsubscribeLabel') || ctx.unsubscribeLabel;
  return (
    <Section
      style={{ borderTop: `1px solid ${ctx.theme.borderColor}`, marginTop: 24, paddingTop: 16 }}
    >
      {(node.content ?? []).map((child, index) =>
        child.type === 'paragraph' ? (
          <Text key={index} style={{ ...small, textAlign: textAlign(child) ?? 'center' }}>
            {renderInline(child.content, ctx)}
          </Text>
        ) : (
          <Fragment key={index}>{renderBlock(child, ctx)}</Fragment>
        ),
      )}
      {ctx.footerAddress ? <Text style={small}>{ctx.tokens.text(ctx.footerAddress)}</Text> : null}
      <Text style={small}>
        <Link
          href={ctx.tokens.raw('{{ unsubscribe_url }}')}
          target="_blank"
          style={{ color: ctx.theme.mutedTextColor, textDecoration: 'underline' }}
        >
          {ctx.tokens.text(label)}
        </Link>
      </Text>
    </Section>
  );
}

function renderBlock(node: TiptapNode, ctx: Ctx): ReactNode {
  switch (node.type) {
    case 'paragraph': {
      const inline = renderInline(node.content, ctx);
      return <Text style={paragraphStyle(node, ctx)}>{inline.length > 0 ? inline : ' '}</Text>;
    }
    case 'heading': {
      const level = clamp(Math.round(attrNumber(node, 'level', 2)), 1, 4);
      const size = HEADING_SIZES[level] ?? { fontSize: 20, lineHeight: '28px' };
      return (
        <Heading
          as={`h${String(level)}` as 'h1' | 'h2' | 'h3' | 'h4'}
          style={{
            margin: '0 0 12px',
            fontWeight: 600,
            color: ctx.theme.textColor,
            textAlign: textAlign(node),
            ...size,
          }}
        >
          {renderInline(node.content, ctx)}
        </Heading>
      );
    }
    case 'bulletList':
      return renderList(node, ctx, false, false);
    case 'orderedList':
      return renderList(node, ctx, true, false);
    case 'taskList':
      return renderList(node, ctx, false, true);
    case 'blockquote':
      return (
        <div
          style={{
            borderLeft: `3px solid ${ctx.theme.borderColor}`,
            paddingLeft: 16,
            margin: '0 0 16px',
            color: ctx.theme.mutedTextColor,
          }}
        >
          {renderBlocks(node.content, ctx)}
        </div>
      );
    case 'codeBlock':
      return (
        <pre
          style={{
            margin: '0 0 16px',
            padding: 12,
            backgroundColor: '#f4f4f5',
            borderRadius: 6,
            fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 13,
            lineHeight: '20px',
            whiteSpace: 'pre-wrap',
            color: ctx.theme.textColor,
          }}
        >
          {ctx.tokens.text((node.content ?? []).map((child) => child.text ?? '').join(''))}
        </pre>
      );
    case 'horizontalRule':
      return (
        <Hr
          style={{
            border: 'none',
            borderTop: `1px solid ${ctx.theme.borderColor}`,
            margin: '24px 0',
          }}
        />
      );
    case 'image':
      return <Section style={{ margin: '0 0 16px' }}>{renderImage(node, ctx)}</Section>;
    case EMAIL_NODES.button: {
      const href = safeHref(attrNullableString(node, 'href'), ctx);
      const align = attrEnum(node, 'align', ['left', 'center', 'right'] as const, 'center');
      const label = ctx.tokens.text(attrString(node, 'label', 'Open'));
      return (
        <Section style={{ margin: '8px 0 24px', textAlign: align }}>
          <Button
            href={href ?? '#'}
            target="_blank"
            style={{
              backgroundColor: safeColor(
                attrNullableString(node, 'backgroundColor'),
                ctx.theme.buttonColor,
              ),
              color: safeColor(attrNullableString(node, 'textColor'), ctx.theme.buttonTextColor),
              borderRadius: 8,
              fontSize: 16,
              fontWeight: 600,
              lineHeight: '20px',
              padding: '12px 24px',
              textDecoration: 'none',
              display: 'inline-block',
            }}
          >
            {label}
          </Button>
        </Section>
      );
    }
    case EMAIL_NODES.spacer: {
      const height = clamp(Math.round(attrNumber(node, 'height', 24)), 4, 160);
      return (
        <Section>
          <Row>
            <Column style={{ height, lineHeight: `${String(height)}px`, fontSize: 1 }}>
              &nbsp;
            </Column>
          </Row>
        </Section>
      );
    }
    case EMAIL_NODES.columns: {
      const columns = (node.content ?? []).filter((child) => child.type === EMAIL_NODES.column);
      const width = `${String(Math.floor(100 / Math.max(1, columns.length)))}%`;
      return (
        <Section style={{ margin: '0 0 16px' }}>
          <Row>
            {columns.map((column, index) => (
              <Column
                key={index}
                width={width}
                style={{
                  width,
                  verticalAlign: 'top',
                  paddingLeft: index === 0 ? 0 : 8,
                  paddingRight: index === columns.length - 1 ? 0 : 8,
                }}
              >
                {renderBlocks(column.content, ctx)}
              </Column>
            ))}
          </Row>
        </Section>
      );
    }
    case EMAIL_NODES.header:
      return (
        <Section
          style={{
            borderBottom: `1px solid ${ctx.theme.borderColor}`,
            marginBottom: 24,
            paddingBottom: 8,
          }}
        >
          {renderBlocks(node.content, ctx)}
        </Section>
      );
    case EMAIL_NODES.footer:
      return renderFooter(node, ctx);
    case EMAIL_NODES.preheader:
      return null;
    case LIQUID_NODES.condition: {
      const attrs = conditionAttrs(node);
      const open = conditionOpenTag(attrs);
      const branches = node.content ?? [];
      const thenBranch = branches.find((branch) => attrString(branch, 'branch') !== 'else');
      const elseBranch = branches.find((branch) => attrString(branch, 'branch') === 'else');
      // An unusable condition keeps the main content and drops the alternative, so nothing silently disappears.
      if (open === null) return renderBlocks(thenBranch?.content, ctx);
      return (
        <>
          {ctx.tokens.raw(open)}
          {renderBlocks(thenBranch?.content, ctx)}
          {elseBranch && (elseBranch.content?.length ?? 0) > 0 ? (
            <>
              {ctx.tokens.raw('{% else %}')}
              {renderBlocks(elseBranch.content, ctx)}
            </>
          ) : null}
          {ctx.tokens.raw(conditionCloseTag(attrs))}
        </>
      );
    }
    case LIQUID_NODES.branch:
      return renderBlocks(node.content, ctx);
    case LIQUID_NODES.raw:
      return ctx.tokens.raw(attrString(node, 'code'));
    default:
      return node.content ? renderBlocks(node.content, ctx) : null;
  }
}

const DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';

/** Serializes blocks to an email HTML document whose Liquid is still unresolved. */
export function serializeHtml(input: HtmlSerializeInput): string {
  const tokens = new LiquidTokens();
  const ctx: Ctx = {
    tokens,
    theme: input.theme,
    unsubscribeLabel: input.unsubscribeLabel,
    footerAddress: input.footerAddress,
  };
  const { theme } = input;
  const markup = renderToStaticMarkup(
    <Html lang={input.lang} dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Body
        style={{
          margin: 0,
          padding: '24px 0',
          backgroundColor: theme.backgroundColor,
          fontFamily: theme.fontFamily,
        }}
      >
        {input.preheader ? (
          <div
            style={{
              display: 'none',
              overflow: 'hidden',
              lineHeight: '1px',
              opacity: 0,
              maxHeight: 0,
              maxWidth: 0,
            }}
          >
            {tokens.mixed(input.preheader)}
            {' \u034f\u00a0'.repeat(40)}
          </div>
        ) : null}
        <Container
          width={theme.width}
          style={{
            width: '100%',
            maxWidth: theme.width,
            backgroundColor: theme.contentBackgroundColor,
            borderRadius: 8,
            padding: 32,
            fontFamily: theme.fontFamily,
          }}
        >
          {renderBlocks(input.blocks, ctx)}
        </Container>
      </Body>
    </Html>,
  );
  return DOCTYPE + tokens.restore(markup);
}
