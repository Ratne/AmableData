import { forwardRef, useRef, type ReactNode, type UIEvent } from 'react';

const TAG_RE = /(\{\{-?[\s\S]*?-?\}\}|\{%-?[\s\S]*?-?%\})/g;
const INNER_RE = /("[^"]*"|'[^']*'|\|\s*[a-z_]+|\b(?:if|elsif|else|endif|unless|endunless|case|when|endcase|for|endfor|in|limit|offset|assign|capture|endcapture|and|or|contains|blank|empty|raw|endraw|comment|endcomment|break|continue)\b)/g;

function highlightTag(tag: string, key: number): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of tag.matchAll(INNER_RE)) {
    const index = match.index;
    if (index > last) out.push(tag.slice(last, index));
    const token = match[0];
    const kind = token.startsWith('"') || token.startsWith("'") ? 'string' : token.startsWith('|') ? 'filter' : 'keyword';
    out.push(
      <span key={`${String(key)}-${String(index)}`} data-token={kind}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  if (last < tag.length) out.push(tag.slice(last));
  return (
    <span key={key} data-token={tag.startsWith('{{') ? 'output' : 'tag'}>
      {out}
    </span>
  );
}

/** Cheap Liquid syntax highlighting: delimiters, strings, filters and keywords. */
export function highlightLiquid(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of source.matchAll(TAG_RE)) {
    if (match.index > last) out.push(source.slice(last, match.index));
    out.push(highlightTag(match[0], key++));
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

export function LiquidCode({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={['liquid-code whitespace-pre-wrap break-all', className].filter(Boolean).join(' ')}>
      {highlightLiquid(code)}
    </pre>
  );
}

/** Inserts text at the textarea selection and returns the new value (caret placed after it). */
export function insertAtCursor(textarea: HTMLTextAreaElement | null, value: string, text: string): string {
  if (textarea === null) return value + text;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = value.slice(0, start) + text + value.slice(end);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(start + text.length, start + text.length);
  });
  return next;
}

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** 1-based line to flag as erroneous. */
  readonly errorLine?: number | null;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly id?: string;
  readonly ariaLabel?: string;
  readonly readOnly?: boolean;
}

/** Monospace Liquid editor: line numbers, highlighting overlay, error line marker. No wrapping, so lines stay aligned. */
export const CodeEditor = forwardRef<HTMLTextAreaElement, CodeEditorProps>(function CodeEditor(
  { value, onChange, errorLine = null, rows = 10, placeholder, id, ariaLabel, readOnly = false },
  ref,
) {
  const gutter = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLPreElement>(null);
  const lines = value.split('\n').length;
  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (gutter.current) gutter.current.scrollTop = scrollTop;
    if (overlay.current) {
      overlay.current.scrollTop = scrollTop;
      overlay.current.scrollLeft = scrollLeft;
    }
  };
  return (
    <div className="liquid-editor" style={{ height: `${String(rows * 1.5 + 1)}rem` }}>
      <div ref={gutter} className="liquid-editor-gutter" aria-hidden="true">
        {Array.from({ length: Math.max(lines, 1) }, (_, i) => (
          <div key={i} data-error={errorLine === i + 1 || undefined}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="liquid-editor-main">
        <pre ref={overlay} className="liquid-editor-overlay liquid-code" aria-hidden="true">
          {highlightLiquid(value)}
          {'\n'}
        </pre>
        <textarea
          ref={ref}
          id={id}
          aria-label={ariaLabel}
          className="liquid-editor-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          readOnly={readOnly}
          placeholder={placeholder}
          onScroll={onScroll}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
});
