import { encode } from 'uqr';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { turnstileSiteKey } from './api';

/** Shared building blocks of the auth pages (plain Tailwind, theme tokens when present). */

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <img src="/brand/logo.png" alt="" className="size-6 object-contain" />
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">amabledata</p>
          </div>
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

export function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        {...props}
      />
    </label>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: { variant?: 'primary' | 'ghost' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'w-full rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50';
  const look =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:opacity-90'
      : 'text-muted-foreground hover:text-foreground underline-offset-4 hover:underline';
  return <button className={`${base} ${look} ${className}`} {...props} />;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  const look =
    tone === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
      : 'border-border bg-muted text-muted-foreground';
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${look}`}>
      {children}
    </p>
  );
}

/** otpauth:// URI rendered as an SVG QR code (no external service). */
export function QrCode({ value, size = 192 }: { value: string; size?: number }) {
  const qr = encode(value, { ecc: 'M', border: 2 });
  const cells: ReactNode[] = [];
  qr.data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) cells.push(<rect key={`${String(x)}-${String(y)}`} x={x} y={y} width={1} height={1} />);
    }),
  );
  return (
    <svg
      role="img"
      aria-label="QR code"
      viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
      width={size}
      height={size}
      className="mx-auto rounded bg-white fill-black p-1"
      shapeRendering="crispEdges"
    >
      {cells}
    </svg>
  );
}

export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: readonly string[]; onDone: () => void; doneLabel: string }) {
  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button onClick={onDone}>{doneLabel}</Button>
    </div>
  );
}

interface TurnstileApi {
  render(element: HTMLElement, options: { sitekey: string; callback: (token: string) => void }): string;
  remove(id: string): void;
}

function turnstileApi(): TurnstileApi | null {
  const value: unknown = Reflect.get(window, 'turnstile');
  return typeof value === 'object' && value !== null && 'render' in value ? (value as TurnstileApi) : null;
}

/**
 * Turnstile widget, loaded only when the installation has a site key. The
 * script is added by our own (nonce'd) bundle, which the strict CSP allows.
 */
export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const siteKey = turnstileSiteKey();
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(() => turnstileApi() !== null);

  useEffect(() => {
    if (siteKey === null || ready) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => setReady(true);
    document.head.appendChild(script);
  }, [siteKey, ready]);

  useEffect(() => {
    const api = turnstileApi();
    if (siteKey === null || !ready || api === null || ref.current === null) return;
    const id = api.render(ref.current, { sitekey: siteKey, callback: onToken });
    return () => api.remove(id);
  }, [siteKey, ready, onToken]);

  return siteKey === null ? null : <div ref={ref} className="flex justify-center" />;
}
