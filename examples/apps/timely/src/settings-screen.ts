import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro: 'Defaults for new campaigns. Each campaign can change them.',
    locale: 'Language of the timer labels',
    preset: 'Look',
    duration: 'Evergreen duration (hours)',
    save: 'Save',
    saved: 'Saved',
    failed: 'Something went wrong',
  },
  it: {
    intro: 'Valori predefiniti per le nuove campagne. Ogni campagna può cambiarli.',
    locale: 'Lingua delle etichette del timer',
    preset: 'Aspetto',
    duration: 'Durata evergreen (ore)',
    save: 'Salva',
    saved: 'Salvato',
    failed: 'Qualcosa è andato storto',
  },
};

const bridge = createAppBridge();
bridge.autoResize();
let t = TEXT.en;

const form = document.getElementById('settings') as HTMLFormElement;
const status = document.getElementById('status') as HTMLElement;

function translate(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset['i18n'] as keyof typeof t;
    const value = t[key];
    if (typeof value === 'string') node.textContent = value;
  });
}

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  translate();
});

async function api(method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch('api/settings', {
    method,
    headers: { authorization: `Bearer ${await bridge.sessionToken()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as Record<string, unknown>;
}

function fill(settings: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (field !== null) field.value = String(value);
  }
}

document.getElementById('save')!.addEventListener('click', async () => {
  const data = new FormData(form);
  try {
    fill(
      await api('POST', {
        label_locale: data.get('label_locale'),
        preset: data.get('preset'),
        duration_hours: Number(data.get('duration_hours')),
      }),
    );
    bridge.toast(t.saved, 'success');
  } catch {
    bridge.toast(t.failed, 'error');
  }
});

translate();
api('GET')
  .then(fill)
  .catch(() => {
    status.textContent = t.failed;
  });
