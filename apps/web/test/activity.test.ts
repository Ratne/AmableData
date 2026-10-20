// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

const pending: Array<() => void> = [];
const fetchMock = vi.fn<typeof fetch>(
  () =>
    new Promise<Response>((resolve) => {
      pending.push(() => resolve(new Response('{}')));
    }),
);

let installActivityTracking: () => void;

beforeAll(async () => {
  window.fetch = fetchMock;
  ({ installActivityTracking } = await import('../src/lib/activity'));
  installActivityTracking();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function button(html: string): HTMLElement {
  document.body.innerHTML = html;
  const found = document.body.querySelector<HTMLElement>('button');
  if (found === null) throw new Error('no button');
  return found;
}

describe('request feedback on the activated button', () => {
  it('marks the clicked button busy until its request settles', async () => {
    const el = button('<button><span>Save</span></button>');
    el.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const request = window.fetch('/api/contacts', { method: 'POST' });
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect('busy' in el.dataset).toBe(true);
    pending.shift()?.();
    await request;
    await flush();
    expect(el.hasAttribute('aria-busy')).toBe(false);
    expect('busy' in el.dataset).toBe(false);
  });

  it('marks the submitter of a form', async () => {
    document.body.innerHTML = '<form><button type="submit">Sign in</button></form>';
    const form = document.querySelector('form');
    const submitter = document.querySelector('button');
    if (form === null || submitter === null) throw new Error('missing');
    form.addEventListener('submit', (e) => e.preventDefault());
    form.requestSubmit(submitter);
    const request = window.fetch('/auth/login', { method: 'POST' });
    expect(submitter.getAttribute('aria-busy')).toBe('true');
    pending.shift()?.();
    await request;
    await flush();
    expect(submitter.hasAttribute('aria-busy')).toBe(false);
  });

  it('leaves switches, other origins and requests long after the click alone', async () => {
    const toggle = button('<button role="switch">On</button>');
    toggle.click();
    const own = window.fetch('/api/settings', { method: 'PATCH' });
    expect(toggle.hasAttribute('aria-busy')).toBe(false);
    pending.shift()?.();
    await own;

    const plain = button('<button>Open</button>');
    plain.click();
    const external = window.fetch('https://example.com/x');
    expect(plain.hasAttribute('aria-busy')).toBe(false);
    pending.shift()?.();
    await external;

    vi.useFakeTimers({ toFake: ['performance'] });
    plain.click();
    vi.advanceTimersByTime(1_000);
    const late = window.fetch('/api/poll');
    expect(plain.hasAttribute('aria-busy')).toBe(false);
    vi.useRealTimers();
    pending.shift()?.();
    await late;
  });
});
