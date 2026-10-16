import type { FormDefinition, PublicFormConfig } from '@amable/forms';
import { FORMS_WIDGET_BUNDLE } from '@amable/forms/bundle';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';

interface WidgetApi {
  mount(el: HTMLElement, config: PublicFormConfig, options: { preview: boolean }): void;
}

declare global {
  interface Window {
    amableForms?: WidgetApi;
  }
}

let loading: Promise<WidgetApi> | null = null;

/**
 * Loads the real embed bundle once (blob script: allowed by the SPA's
 * 'strict-dynamic' CSP because a trusted script inserts it).
 */
function loadWidget(): Promise<WidgetApi> {
  if (window.amableForms !== undefined) return Promise.resolve(window.amableForms);
  loading ??= new Promise<WidgetApi>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([FORMS_WIDGET_BUNDLE], { type: 'text/javascript' }));
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      URL.revokeObjectURL(url);
      if (window.amableForms !== undefined) resolve(window.amableForms);
      else reject(new Error('widget unavailable'));
    };
    script.onerror = () => reject(new Error('widget unavailable'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

const DROPPED_TAGS = 'script,style,iframe,object,embed,link,meta,form,input,button,textarea,select';

/** The preview runs in the app origin: keep html fields inert. */
export function sanitizePreviewHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of doc.body.querySelectorAll(DROPPED_TAGS)) el.remove();
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^\s*(javascript|data):/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

export function previewConfig(id: string, name: string, tenant: string, definition: FormDefinition): PublicFormConfig {
  const { allowed_domains: _allowed, ...settings } = definition.settings;
  void _allowed;
  return {
    id,
    name,
    tenant,
    fields: definition.fields.map((f) => (f.kind === 'html' ? { ...f, html: sanitizePreviewHtml(f.html) } : f)),
    settings,
    style: definition.style,
    turnstile_site_key: null,
  };
}

/** Live preview: the embed widget itself, mounted with the unsaved definition. */
export function FormPreview({ config }: { config: PublicFormConfig }) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const serialized = JSON.stringify(config);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadWidget()
        .then((widget) => {
          if (!cancelled && host.current !== null) widget.mount(host.current, JSON.parse(serialized) as PublicFormConfig, { preview: true });
        })
        .catch(() => setFailed(true));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [serialized]);

  if (failed) return <p className="text-sm text-muted-foreground">{t('forms.preview.unavailable')}</p>;
  return <div ref={host} className="min-h-40" data-testid="form-preview" />;
}
