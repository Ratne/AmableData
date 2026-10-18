import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro:
      'Mapbox suggests addresses while you type on the contact page, with more complete data than the built-in OpenStreetMap search, including streets and house numbers in small towns. Searches use your own Mapbox account: it has a monthly free tier, then bills by its price list. If Mapbox does not answer, OpenStreetMap is used.',
    tokenHint:
      "Create a token under Tokens on account.mapbox.com, with no URL restrictions: requests come from the app's server, not the browser. It is checked with Mapbox and stored encrypted.",
    token: 'Mapbox access token',
    permanent: 'Permanent geocoding',
    permanentHint:
      'Mapbox terms allow keeping results only with permanent geocoding, which is priced apart from the free tier. The CRM stores the chosen address: check costs and terms on the Mapbox site before deciding.',
    save: 'Save',
    remove: 'Remove token',
    configured: (hint: string) => `Token saved (${hint}): address suggestions come from Mapbox.`,
    missing: 'No token yet: address suggestions come from OpenStreetMap.',
    saved: 'Settings saved',
    removed: 'Token removed',
    invalid: 'Mapbox refused this token (it starts with pk. or sk.)',
    unavailable: 'Mapbox did not answer, try again',
    failed: 'Could not save',
  },
  it: {
    intro:
      'Mapbox suggerisce gli indirizzi mentre scrivi nella scheda contatto, con dati più completi della ricerca OpenStreetMap integrata, anche su vie e civici dei piccoli comuni. Le ricerche usano il tuo account Mapbox: offre una quota gratuita mensile, oltre si paga secondo il suo listino. Se Mapbox non risponde si usa OpenStreetMap.',
    tokenHint:
      'Crea un token in Tokens su account.mapbox.com, senza restrizioni URL: le richieste partono dal server dell’app, non dal browser. Viene verificato con Mapbox e salvato cifrato.',
    token: 'Token di accesso Mapbox',
    permanent: 'Geocodifica permanente',
    permanentHint:
      'Le condizioni di Mapbox permettono di conservare i risultati solo con la geocodifica permanente, che ha un listino diverso dalla quota gratuita. Il CRM salva l’indirizzo scelto: verifica costi e condizioni sul sito di Mapbox prima di decidere.',
    save: 'Salva',
    remove: 'Rimuovi token',
    configured: (hint: string) => `Token salvato (${hint}): i suggerimenti arrivano da Mapbox.`,
    missing: 'Nessun token: i suggerimenti arrivano da OpenStreetMap.',
    saved: 'Impostazioni salvate',
    removed: 'Token rimosso',
    invalid: 'Mapbox ha rifiutato questo token (inizia con pk. o sk.)',
    unavailable: 'Mapbox non ha risposto, riprova',
    failed: 'Salvataggio non riuscito',
  },
};

const bridge = createAppBridge();
bridge.autoResize();
let t = TEXT.en;

interface Settings {
  configured?: boolean;
  hint?: string | null;
  permanent?: boolean;
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
const tokenInput = form.elements.namedItem('token') as HTMLInputElement;
const permanentInput = form.elements.namedItem('permanent') as HTMLInputElement;
let current: Settings = {};

const show = (settings: Settings) => {
  current = settings;
  status.textContent = settings.configured === true ? t.configured(settings.hint ?? '') : t.missing;
  permanentInput.checked = settings.permanent === true;
};

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = t[node.dataset['i18n'] as keyof typeof t];
    if (typeof value === 'string') node.textContent = value;
  }
  show(current);
});

async function save(body: { token?: string; permanent?: boolean }, done: string): Promise<void> {
  try {
    const { status: code, settings } = await api('POST', body);
    if (code === 422) return bridge.toast(t.invalid, 'error');
    if (code === 502) return bridge.toast(t.unavailable, 'error');
    if (code >= 400) return bridge.toast(t.failed, 'error');
    tokenInput.value = '';
    show(settings);
    bridge.toast(done, 'success');
  } catch {
    bridge.toast(t.failed, 'error');
  }
}

void api('GET').then(({ settings }) => show(settings));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  void save({ ...(token === '' ? {} : { token }), permanent: permanentInput.checked }, t.saved);
});
document
  .querySelector('#remove')!
  .addEventListener('click', () => void save({ token: '' }, t.removed));
