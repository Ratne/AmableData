import {
  renderEmail,
  type CompileEmailOptions,
  type LiquidSandboxOptions,
  type RenderedEmail,
  type TiptapDocument,
} from '@amable/email-render';
import type { JSONContent } from '@tiptap/core';
import { useEffect, useState } from 'react';

export interface EmailPreviewProps {
  readonly doc: JSONContent;
  /** Recipient context (a real contact), merged over the sample unsubscribe URL. */
  readonly context: Record<string, unknown>;
  /** Compile options plus the Liquid `timezone` (the tenant's, as when sending). */
  readonly options?: CompileEmailOptions & LiquidSandboxOptions;
  readonly view?: 'html' | 'text';
  readonly className?: string;
  readonly labels?: { readonly error?: string };
}

const SAMPLE_UNSUBSCRIBE = 'https://example.com/unsubscribe/preview';

/**
 * Renders exactly what a recipient gets: the same `@amable/email-render`
 * pipeline as the Worker, Liquid resolved by LiquidJS with the given context.
 * The HTML is shown in a sandboxed iframe without scripts.
 */
export function EmailPreview({
  doc,
  context,
  options,
  view = 'html',
  className,
  labels,
}: EmailPreviewProps) {
  const [result, setResult] = useState<{ email: RenderedEmail | null; error: string | null }>({
    email: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      renderEmail(
        doc as TiptapDocument,
        { unsubscribe_url: SAMPLE_UNSUBSCRIBE, ...context },
        options,
      ).then(
        (email) => !cancelled && setResult({ email, error: null }),
        (error: unknown) =>
          !cancelled &&
          setResult((current) => ({
            email: current.email,
            error: error instanceof Error ? error.message : String(error),
          })),
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [doc, context, options]);

  return (
    <div className={['amable-email-preview', className].filter(Boolean).join(' ')}>
      {result.error ? (
        <p className="amable-email-preview-error" role="alert">
          {labels?.error ?? 'Preview failed'}: {result.error}
        </p>
      ) : null}
      {result.email?.subject ? (
        <div className="amable-email-preview-subject">{result.email.subject}</div>
      ) : null}
      {view === 'html' ? (
        <iframe
          title="Email preview"
          sandbox=""
          className="amable-email-preview-frame"
          srcDoc={result.email?.html ?? ''}
        />
      ) : (
        <pre className="amable-email-preview-text">{result.email?.text ?? ''}</pre>
      )}
    </div>
  );
}
