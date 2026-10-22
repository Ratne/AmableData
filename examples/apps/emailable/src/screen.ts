import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro:
      'Emailable checks whether an email address really receives mail, without sending anything to it. Every new contact (created in the CRM, from a form or an import) is verified with your account, one credit per address.',
    deliverable: 'Deliverable: the mailbox exists and accepts mail.',
    undeliverable:
      'Undeliverable: it does not exist (tag "Invalid email"); forms with blocking validation reject it and suggest the fix of a misspelled domain.',
    risky:
      'Risky: it may bounce, e.g. role or catch-all addresses (tag "Risky email"). Disposable addresses also get "Disposable email".',
    automation:
      'In automations, the "Verify email" block returns state and score for the next steps.',
    credits: (credits: number) => ` Credits left: ${credits.toLocaleString('en')}.`,
    key: 'Emailable API key',
    save: 'Save',
    remove: 'Remove key',
    configured: (last4: string) => `Key saved (…${last4}).`,
    missing: 'No key yet: contacts are not verified.',
    saved: 'Key saved',
    removed: 'Key removed',
    invalid: 'Emailable refused this key',
    unavailable: 'Emailable did not answer, try again',
    failed: 'Could not save',
  },
  it: {
    intro:
      'Emailable controlla se un indirizzo email riceve davvero posta, senza inviargli nulla. Ogni nuovo contatto (creato nel CRM, da un form o da un import) viene verificato con il tuo account, un credito per indirizzo.',
    deliverable: 'Deliverable: la casella esiste e accetta posta.',
    undeliverable:
      'Undeliverable: non esiste (tag "Invalid email"); i form con validazione bloccante lo rifiutano e suggeriscono la correzione di un dominio scritto male.',
    risky:
      'Risky: potrebbe rimbalzare, per esempio indirizzi di ruolo o catch-all (tag "Risky email"). Gli indirizzi usa e getta ricevono anche "Disposable email".',
    automation:
      'Nelle automazioni, il blocco "Verifica email" restituisce stato e punteggio per i passi successivi.',
    credits: (credits: number) => ` Crediti rimasti: ${credits.toLocaleString('it')}.`,
    key: 'Chiave API Emailable',
    save: 'Salva',
    remove: 'Rimuovi chiave',
    configured: (last4: string) => `Chiave salvata (…${last4}).`,
    missing: 'Nessuna chiave: i contatti non vengono verificati.',
    saved: 'Chiave salvata',
    removed: 'Chiave rimossa',
    invalid: 'Emailable ha rifiutato questa chiave',
    unavailable: 'Emailable non ha risposto, riprova',
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
  credits?: number | null;
  error?: string;
}

async function api(
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; settings: Settings }> {
  const response = await fetch('api/settings', {
    method,
    headers: {
      authorization: `Bearer ${await bridge.sessionToken()}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, settings: (await response.json()) as Settings };
}

const status = document.querySelector<HTMLElement>('#status')!;
const form = document.querySelector<HTMLFormElement>('#settings')!;
const input = form.elements.namedItem('api_key') as HTMLInputElement;

const show = (settings: Settings) => {
  status.textContent =
    settings.configured === true
      ? t.configured(settings.last4 ?? '') +
        (typeof settings.credits === 'number' ? t.credits(settings.credits) : '')
      : t.missing;
};

async function save(apiKey: string): Promise<void> {
  try {
    const { status: code, settings } = await api('POST', { api_key: apiKey });
    if (code === 422) return bridge.toast(t.invalid, 'error');
    if (code === 502) return bridge.toast(t.unavailable, 'error');
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
