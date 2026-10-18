import { createAppBridge } from '@amable/app-bridge';

/** Runs inside the CRM iframe: talks to the CRM page through the bridge, to your backend with the session token. */

const bridge = createAppBridge();
bridge.autoResize();
bridge.onContext((context) => document.body.classList.toggle('dark', context.theme === 'dark'));

async function api(method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch('api/settings', {
    method,
    headers: { authorization: `Bearer ${await bridge.sessionToken()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return (await response.json()) as Record<string, unknown>;
}

const form = document.querySelector<HTMLFormElement>('#settings');
if (form !== null) {
  const greeting = form.elements.namedItem('greeting') as HTMLInputElement;
  void api('GET').then((settings) => {
    greeting.value = typeof settings['greeting'] === 'string' ? settings['greeting'] : '';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    api('POST', { greeting: greeting.value })
      .then(() => bridge.toast('Saved', 'success'))
      .catch(() => bridge.toast('Could not save', 'error'));
  });
}
