import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro: 'Connect your WATI account to receive and answer WhatsApp messages in Conversations.',
    endpoint: 'API endpoint (WATI → API Docs)',
    token: 'Access token',
    save: 'Save',
    remove: 'Disconnect',
    webhookTitle: 'Incoming messages',
    step1: 'In WATI open Webhooks and add a webhook with this URL.',
    step2: 'Enable the events "Message received", "Message delivered", "Message read" and "Message failed".',
    copy: 'Copy URL',
    copied: 'URL copied',
    configured: (endpoint: string) => `Connected to ${endpoint}.`,
    missing: 'Not connected yet.',
    saved: 'WATI connected',
    removed: 'WATI disconnected',
    invalidEndpoint: 'The endpoint must be your https://….wati.io address',
    invalidToken: 'WATI refused this token',
    failed: 'Could not save',
  },
  it: {
    intro: 'Collega il tuo account WATI per ricevere e rispondere ai messaggi WhatsApp in Conversazioni.',
    endpoint: 'Endpoint API (WATI → API Docs)',
    token: 'Access token',
    save: 'Salva',
    remove: 'Scollega',
    webhookTitle: 'Messaggi in arrivo',
    step1: 'In WATI apri Webhooks e aggiungi un webhook con questo URL.',
    step2: 'Attiva gli eventi "Message received", "Message delivered", "Message read" e "Message failed".',
    copy: 'Copia URL',
    copied: 'URL copiato',
    configured: (endpoint: string) => `Collegato a ${endpoint}.`,
    missing: 'Non ancora collegato.',
    saved: 'WATI collegato',
    removed: 'WATI scollegato',
    invalidEndpoint: 'L\'endpoint deve essere il tuo indirizzo https://….wati.io',
    invalidToken: 'WATI ha rifiutato questo token',
    failed: 'Salvataggio non riuscito',
  },
};

const bridge = createAppBridge();
bridge.autoResize();
let t = TEXT.en;

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = t[node.dataset['i18n'] as keyof typeof t];
    if (typeof value === 'string') node.textContent = value;
  }
});

interface Settings {
  configured?: boolean;
  endpoint?: string | null;
  webhook_url?: string;
  error?: string;
}

async function api(method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; settings: Settings }> {
  const response = await fetch('/api/settings', {
    method,
    headers: { authorization: `Bearer ${await bridge.sessionToken()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, settings: (await response.json()) as Settings };
}

const status = document.querySelector<HTMLElement>('#status')!;
const webhook = document.querySelector<HTMLElement>('#webhook')!;
const form = document.querySelector<HTMLFormElement>('#settings')!;
const endpoint = form.elements.namedItem('endpoint') as HTMLInputElement;
const token = form.elements.namedItem('token') as HTMLInputElement;

const show = (settings: Settings) => {
  status.textContent = settings.configured === true ? t.configured(settings.endpoint ?? '') : t.missing;
  if (settings.endpoint) endpoint.value = settings.endpoint;
  if (settings.webhook_url) webhook.textContent = settings.webhook_url;
};

async function save(body: Record<string, unknown>, done: string): Promise<void> {
  try {
    const { status: code, settings } = await api('POST', body);
    if (settings.error === 'invalid_endpoint') return bridge.toast(t.invalidEndpoint, 'error');
    if (settings.error === 'invalid_token') return bridge.toast(t.invalidToken, 'error');
    if (code >= 400) return bridge.toast(t.failed, 'error');
    token.value = '';
    show(settings);
    bridge.toast(done, 'success');
  } catch {
    bridge.toast(t.failed, 'error');
  }
}

void api('GET').then(({ settings }) => show(settings));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void save({ endpoint: endpoint.value.trim(), token: token.value.trim() }, t.saved);
});
document.querySelector('#remove')!.addEventListener('click', () => void save({ remove: true }, t.removed));
document.querySelector('#copy')!.addEventListener('click', () => {
  void navigator.clipboard.writeText(webhook.textContent ?? '').then(() => bridge.toast(t.copied, 'success'));
});
