import type { Product } from '@amable/api-types';
import type { CheckoutDefinition, PublicCheckoutConfig, PublicCheckoutItem } from '@amable/checkout';
import { CHECKOUT_WIDGET_BUNDLE } from '@amable/checkout/bundle';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { sanitizePreviewHtml } from '../../forms/components/preview';

interface WidgetApi {
  mount(el: HTMLElement, config: PublicCheckoutConfig, options: { preview: boolean }): void;
}

declare global {
  interface Window {
    amableCheckout?: WidgetApi;
  }
}

let loading: Promise<WidgetApi> | null = null;

/** The real embed bundle, loaded once as a blob script (allowed by the SPA's 'strict-dynamic' CSP). */
function loadWidget(): Promise<WidgetApi> {
  if (window.amableCheckout !== undefined) return Promise.resolve(window.amableCheckout);
  loading ??= new Promise<WidgetApi>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([CHECKOUT_WIDGET_BUNDLE], { type: 'text/javascript' }));
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      URL.revokeObjectURL(url);
      if (window.amableCheckout !== undefined) resolve(window.amableCheckout);
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

/**
 * What the public endpoint would answer, built from the unsaved definition and
 * the catalog (list prices: taxes and promo codes only apply on the real page).
 */
export function previewCheckoutConfig(
  id: string,
  name: string,
  tenant: string,
  currency: string,
  definition: CheckoutDefinition,
  products: readonly Product[],
): PublicCheckoutConfig {
  const productById = new Map(products.map((p) => [p.id, p]));
  const planById = new Map(products.flatMap((p) => p.plans.map((plan) => [plan.id, { plan, product: p }] as const)));
  const items = definition.items.flatMap((item): PublicCheckoutItem[] => {
    if (item.kind === 'product') {
      const product = productById.get(item.ref_id);
      if (product === undefined) return [];
      return [
        {
          id: item.id,
          kind: 'product' as const,
          name: item.label || product.name,
          description: item.description || product.description || '',
          image_url: item.image_url,
          unit_price_minor: item.price_minor ?? product.price_minor,
          quantity: item.quantity,
          preselected: item.preselected,
          recurring: null,
        },
      ];
    }
    const entry = planById.get(item.ref_id);
    if (entry === undefined) return [];
    return [
      {
        id: item.id,
        kind: 'plan' as const,
        name: item.label || `${entry.product.name} — ${entry.plan.name}`,
        description: item.description || entry.product.description || '',
        image_url: item.image_url,
        unit_price_minor: item.price_minor ?? entry.plan.price_minor,
        quantity: item.quantity,
        preselected: item.preselected,
        recurring: {
          interval: entry.plan.interval,
          interval_count: entry.plan.interval_count,
          trial_days: entry.plan.trial_days,
          setup_fee_minor: entry.plan.setup_fee_minor,
        },
      },
    ];
  });
  const bumps = definition.bumps.flatMap((bump) => {
    const product = productById.get(bump.product_id);
    if (product === undefined) return [];
    const price = bump.price_minor ?? product.price_minor;
    return [
      {
        id: bump.id,
        title: bump.title,
        description: bump.description,
        image_url: bump.image_url,
        skin: bump.skin,
        position: bump.position,
        color: bump.color,
        checked: bump.checked,
        unit_price_minor: price,
        regular_price_minor: product.price_minor > price ? product.price_minor : null,
        quantity: bump.quantity,
      },
    ];
  });
  const { allowed_domains: _domains, first_offer: firstOffer, offer_window_minutes: _window, ...settings } = definition.settings;
  void _domains;
  void _window;
  return {
    id,
    name,
    tenant,
    currency,
    items,
    bumps,
    fields: definition.fields.map((f) => (f.kind === 'html' ? { ...f, html: sanitizePreviewHtml(f.html) } : f)),
    contact: definition.contact,
    settings,
    style: definition.style,
    offers_enabled: firstOffer !== '',
    stripe_publishable_key: null,
  };
}

/** Live preview: the embed widget itself, mounted in preview mode (no network, no payment). */
export function CheckoutPreview({ config }: { config: PublicCheckoutConfig }) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const serialized = JSON.stringify(config);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadWidget()
        .then((widget) => {
          if (!cancelled && host.current !== null) {
            widget.mount(host.current, JSON.parse(serialized) as PublicCheckoutConfig, { preview: true });
          }
        })
        .catch(() => setFailed(true));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [serialized]);

  if (failed) return <p className="text-sm text-muted-foreground">{t('checkout.preview.unavailable')}</p>;
  return <div ref={host} className="min-h-40" />;
}
