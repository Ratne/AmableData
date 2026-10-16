import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { FormsApiError } from '../src/features/forms/api/client';
import { isStepUpRequired, registerStepUpPrompt, stepUpFetch } from '../src/lib/step-up';

const stepUpResponse = () =>
  new Response(JSON.stringify({ error: 'step_up_required' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('isStepUpRequired', () => {
  it('recognises the code on every feature client error and on raw bodies', () => {
    expect(isStepUpRequired(new ApiError(403, 'step_up_required'))).toBe(true);
    expect(isStepUpRequired(new FormsApiError(403, 'step_up_required', null, []))).toBe(true);
    expect(isStepUpRequired({ error: 'step_up_required' })).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isStepUpRequired(new ApiError(403, 'forbidden'))).toBe(false);
    expect(isStepUpRequired(new FormsApiError(403, 'session_required', null, []))).toBe(false);
    expect(isStepUpRequired(new Error('step_up_required'))).toBe(false);
    expect(isStepUpRequired(null)).toBe(false);
    expect(isStepUpRequired('step_up_required')).toBe(false);
  });
});

describe('stepUpFetch', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    unregister?.();
    unregister = null;
    vi.unstubAllGlobals();
  });

  it('asks for the second factor and replays the same request once verified', async () => {
    fetchMock.mockResolvedValueOnce(stepUpResponse()).mockResolvedValueOnce(ok());
    const prompt = vi.fn(() => Promise.resolve(true));
    unregister = registerStepUpPrompt(prompt);
    const init: RequestInit = { method: 'POST', body: JSON.stringify({ name: 'x' }) };

    const response = await stepUpFetch('/api/v2/t/demo/forms/f1/connections', init);

    expect(response.status).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/v2/t/demo/forms/f1/connections', init]);
  });

  it('returns the original 403 when the user closes the dialog', async () => {
    fetchMock.mockResolvedValueOnce(stepUpResponse());
    unregister = registerStepUpPrompt(() => Promise.resolve(false));

    const response = await stepUpFetch('/api/t/demo/backups', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'step_up_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a failing prompt as cancelled', async () => {
    fetchMock.mockResolvedValueOnce(stepUpResponse());
    unregister = registerStepUpPrompt(() => Promise.reject(new Error('start failed')));

    expect((await stepUpFetch('/api/x', { method: 'POST' })).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one prompt between concurrent requests', async () => {
    fetchMock
      .mockResolvedValueOnce(stepUpResponse())
      .mockResolvedValueOnce(stepUpResponse())
      .mockResolvedValue(ok());
    const prompt = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5)),
    );
    unregister = registerStepUpPrompt(prompt);

    const [a, b] = await Promise.all([
      stepUpFetch('/api/a', { method: 'POST' }),
      stepUpFetch('/api/b', { method: 'POST' }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('leaves other 403s and the no-prompt case untouched', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    unregister = registerStepUpPrompt(prompt);
    expect((await stepUpFetch('/api/x')).status).toBe(403);
    unregister();
    unregister = null;

    fetchMock.mockResolvedValueOnce(stepUpResponse());
    expect((await stepUpFetch('/api/x', { method: 'POST' })).status).toBe(403);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not replay a streamed body', async () => {
    fetchMock.mockResolvedValueOnce(stepUpResponse());
    const prompt = vi.fn(() => Promise.resolve(true));
    unregister = registerStepUpPrompt(prompt);

    const response = await stepUpFetch('/api/x', { method: 'POST', body: new ReadableStream() });

    expect(response.status).toBe(403);
    expect(prompt).not.toHaveBeenCalled();
  });
});
