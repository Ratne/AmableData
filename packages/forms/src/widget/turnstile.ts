interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}

export interface TurnstileHandle {
  token(): string;
  reset(): void;
  remove(): void;
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<TurnstileApi> | null = null;

function api(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

function loadApi(): Promise<TurnstileApi> {
  const ready = api();
  if (ready !== undefined) return Promise.resolve(ready);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', () => {
      const loaded = api();
      if (loaded === undefined) reject(new Error('turnstile unavailable'));
      else resolve(loaded);
    });
    script.addEventListener('error', () => reject(new Error('turnstile unavailable')));
    document.head.appendChild(script);
  });
  return loading;
}

/** Renders the Turnstile challenge in `el` (loaded on demand, outside the shadow root). */
export function mountTurnstile(el: HTMLElement, siteKey: string): TurnstileHandle {
  let token = '';
  let widgetId: string | null = null;
  let removed = false;
  void loadApi()
    .then((turnstile) => {
      if (removed) return;
      widgetId = turnstile.render(el, {
        sitekey: siteKey,
        callback: (value: string) => {
          token = value;
        },
        'expired-callback': () => {
          token = '';
        },
        'error-callback': () => {
          token = '';
        },
      });
    })
    .catch(() => undefined);
  return {
    token: () => token,
    reset() {
      token = '';
      if (widgetId !== null) api()?.reset(widgetId);
    },
    remove() {
      removed = true;
      if (widgetId !== null) api()?.remove(widgetId);
    },
  };
}
