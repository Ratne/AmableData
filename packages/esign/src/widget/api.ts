import type { OtpSendResult, OtpVerifyResult, SigningSubmit, SigningView } from '../types';
import { collectBrowser } from './browser';

/** HTTP client of the edge signing routes (same origin, the link token is in the base path). */

export interface ApiFailure {
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly details: ReadonlyArray<{ path: string; message: string }>;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

async function post<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, value: parsed as T };
    return {
      ok: false,
      failure: {
        status: response.status,
        error: typeof parsed['error'] === 'string' ? parsed['error'] : 'error',
        message: typeof parsed['message'] === 'string' ? parsed['message'] : '',
        details: Array.isArray(parsed['details']) ? (parsed['details'] as ApiFailure['details']) : [],
      },
    };
  } catch {
    return { ok: false, failure: { status: 0, error: 'network', message: '', details: [] } };
  }
}

export class SigningApi {
  constructor(readonly base: string) {}

  pageUrl(index: number): string {
    return `${this.base}/pages/${String(index)}`;
  }

  documentUrl(): string {
    return `${this.base}/document`;
  }

  open(): Promise<ApiResult<SigningView>> {
    return post(`${this.base}/open`, { browser: collectBrowser() });
  }

  sendCode(): Promise<ApiResult<OtpSendResult>> {
    return post(`${this.base}/otp/send`, { browser: collectBrowser() });
  }

  verifyCode(code: string): Promise<ApiResult<OtpVerifyResult>> {
    return post(`${this.base}/otp/verify`, { code, browser: collectBrowser() });
  }

  complete(submit: Omit<SigningSubmit, 'browser'>): Promise<ApiResult<SigningView>> {
    return post(`${this.base}/complete`, { ...submit, browser: collectBrowser() });
  }

  decline(reason: string): Promise<ApiResult<SigningView>> {
    return post(`${this.base}/decline`, { reason, browser: collectBrowser() });
  }
}
