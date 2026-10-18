import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro:
      'Connect a WhatsApp number through Kapso: conversations land in the shared inbox, and automations can send approved templates.',
    step1: '1. Kapso API key',
    keyHint: 'Create it in Kapso under Project settings → API keys.',
    key: 'API key',
    save: 'Save',
    remove: 'Remove',
    step2: '2. WhatsApp number',
    pick: 'Number of the Kapso project',
    use: 'Use this number',
    disconnect: 'Disconnect',
    newTitle: 'Connect a new number',
    newHint:
      "Opens Meta's signup in a new tab: use a new number, or keep the WhatsApp Business app on your phone (coexistence). Come back here when it is done.",
    connect: 'Connect a number with Kapso',
    keySaved: (last4: string) => `Key saved (…${last4}).`,
    noKey: 'No key yet.',
    connected: (n: string) => `Connected: ${n}. Messages arrive in the inbox.`,
    sandbox:
      'This is a Kapso sandbox number: it only talks to phones that joined the sandbox, and cannot send templates.',
    notConnected: 'No number connected yet.',
    none: 'The project has no number yet: connect one below.',
    saved: 'Saved',
    invalid: 'Kapso refused this key',
    failed: 'Something went wrong',
    opened: 'Finish the signup in the new tab, then reload this page.',
  },
  it: {
    intro:
      'Collega un numero WhatsApp tramite Kapso: le conversazioni arrivano nella inbox condivisa e le automazioni possono inviare template approvati.',
    step1: '1. Chiave API di Kapso',
    keyHint: 'Creala in Kapso da Project settings → API keys.',
    key: 'Chiave API',
    save: 'Salva',
    remove: 'Rimuovi',
    step2: '2. Numero WhatsApp',
    pick: 'Numero del progetto Kapso',
    use: 'Usa questo numero',
    disconnect: 'Scollega',
    newTitle: 'Collega un nuovo numero',
    newHint:
      "Apre la registrazione Meta in una nuova scheda: usa un numero nuovo, oppure tieni l'app WhatsApp Business sul telefono (coexistence). Torna qui quando hai finito.",
    connect: 'Collega un numero con Kapso',
    keySaved: (last4: string) => `Chiave salvata (…${last4}).`,
    noKey: 'Nessuna chiave.',
    connected: (n: string) => `Collegato: ${n}. I messaggi arrivano nella inbox.`,
    sandbox:
      'È un numero sandbox di Kapso: parla solo con i telefoni entrati nella sandbox e non può inviare template.',
    notConnected: 'Nessun numero collegato.',
    none: 'Il progetto non ha ancora numeri: collegane uno qui sotto.',
    saved: 'Salvato',
    invalid: 'Kapso ha rifiutato questa chiave',
    failed: 'Qualcosa è andato storto',
    opened: 'Completa la registrazione nella nuova scheda, poi ricarica questa pagina.',
  },
};

interface PhoneNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  name: string | null;
  kind: string | null;
}

interface State {
  configured?: boolean;
  last4?: string;
  number?: PhoneNumber | null;
  numbers?: PhoneNumber[] | null;
  error?: string | null;
}

const bridge = createAppBridge();
bridge.autoResize();
let t = TEXT.en;
let state: State = {};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const label = (n: PhoneNumber) =>
  [n.display_phone_number, n.name, n.kind === 'sandbox' ? 'sandbox' : null]
    .filter(Boolean)
    .join(' · ') || n.phone_number_id;

function render(): void {
  $('#key-status').textContent =
    state.configured === true ? t.keySaved(state.last4 ?? '') : t.noKey;
  $('#number-section').hidden = state.configured !== true;
  const number = state.number ?? null;
  $('#number-status').textContent =
    state.error != null
      ? state.error
      : number === null
        ? t.notConnected
        : `${t.connected(label(number))}${number.kind === 'sandbox' ? ` ${t.sandbox}` : ''}`;
  const select = $<HTMLSelectElement>('#numbers');
  select.replaceChildren(
    ...(state.numbers ?? []).map((n) => {
      const option = document.createElement('option');
      option.value = n.phone_number_id;
      option.textContent = label(n);
      option.selected = n.phone_number_id === number?.phone_number_id;
      return option;
    }),
  );
  if ((state.numbers ?? []).length === 0 && state.configured === true && state.error == null)
    $('#number-status').textContent = t.none;
  $('#disconnect').hidden = number === null;
}

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = t[node.dataset['i18n'] as keyof typeof t];
    if (typeof value === 'string') node.textContent = value;
  }
  render();
});

async function call(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${await bridge.sessionToken()}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function update(path: string, body: unknown, invalidMessage = t.failed): Promise<void> {
  try {
    const result = await call(path, 'POST', body);
    if (result.status >= 400)
      return bridge.toast(
        typeof result.body['error'] === 'string'
          ? `${invalidMessage}: ${result.body['error']}`
          : invalidMessage,
        'error',
      );
    state = result.body as State;
    render();
    bridge.toast(t.saved, 'success');
  } catch {
    bridge.toast(t.failed, 'error');
  }
}

void call('api/settings', 'GET').then(({ body }) => {
  state = body as State;
  render();
});

const keyForm = $<HTMLFormElement>('#key-form');
keyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = keyForm.elements.namedItem('api_key') as HTMLInputElement;
  if (input.value.trim() === '') return;
  void update('api/settings', { api_key: input.value.trim() }, t.invalid).then(() => {
    input.value = '';
  });
});
$('#remove-key').addEventListener('click', () => void update('api/settings', { api_key: '' }));
$('#use-number').addEventListener('click', () => {
  const id = $<HTMLSelectElement>('#numbers').value;
  if (id !== '') void update('api/number', { phone_number_id: id });
});
$('#disconnect').addEventListener(
  'click',
  () => void update('api/number', { phone_number_id: null }),
);
$('#connect').addEventListener('click', () => {
  // Open the tab synchronously (popup blockers), then point it at the setup link.
  const tab = window.open('about:blank', '_blank');
  void call('api/connect', 'POST', {})
    .then(({ status, body }) => {
      if (status >= 400 || typeof body['url'] !== 'string') {
        tab?.close();
        return bridge.toast(typeof body['error'] === 'string' ? body['error'] : t.failed, 'error');
      }
      if (tab === null) window.open(body['url'], '_blank', 'noopener');
      else tab.location.href = body['url'];
      bridge.toast(t.opened, 'info');
    })
    .catch(() => {
      tab?.close();
      bridge.toast(t.failed, 'error');
    });
});
