import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro: 'New contacts are verified with your Emailable account. The outcome goes to the "Email status" field and to tags.',
    key: 'Emailable API key',
    save: 'Save',
    remove: 'Remove key',
    configured: (last4: string) => `Key saved (…${last4}).`,
    missing: 'No key yet: contacts are not verified.',
    saved: 'Key saved',
    removed: 'Key removed',
    invalid: 'Emailable refused this key',
    failed: 'Could not save',
  },
  it: {
    intro: 'I nuovi contatti vengono verificati con il tuo account Emailable. L\'esito va nel campo "Stato email" e nei tag.',
    key: 'Chiave API Emailable',
    save: 'Salva',
    remove: 'Rimuovi chiave',
    configured: (last4: string) => `Chiave salvata (…${last4}).`,
    missing: 'Nessuna chiave: i contatti non vengono verificati.',
    saved: 'Chiave salvata',
    removed: 'Chiave rimossa',
    invalid: 'Emailable ha rifiutato questa chiave',
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
  last4?: string;
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
const form = document.querySelector<HTMLFormElement>('#settings')!;
const input = form.elements.namedItem('api_key') as HTMLInputElement;

const show = (settings: Settings) => {
  status.textContent = settings.configured === true ? t.configured(settings.last4 ?? '') : t.missing;
};

async function save(apiKey: string): Promise<void> {
  try {
    const { status: code, settings } = await api('POST', { api_key: apiKey });
    if (code === 422) return bridge.toast(t.invalid, 'error');
    if (code >= 400) return bridge.toast(t.failed, 'error');
    input.value = '';
    show(settings);
    bridge.toast(apiKey === '' ? t.removed : t.saved, 'success');
  } catch {
    bridge.toast(t.failed, 'error');
  }
}

void api('GET').then(({ settings }) => show(settings));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (input.value.trim() !== '') void save(input.value.trim());
});
document.querySelector('#remove')!.addEventListener('click', () => void save(''));
