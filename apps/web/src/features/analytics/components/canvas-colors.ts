export type Rgb = readonly [number, number, number];

/**
 * Resolves theme colours (`var(--primary)`, …) to RGB through a probe element:
 * custom properties are not resolved by `getPropertyValue`, `color` is.
 */
export function resolveColors<K extends string>(
  host: HTMLElement,
  tokens: Readonly<Record<K, string>>,
): Record<K, Rgb> {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const out = {} as Record<K, Rgb>;
  for (const key of Object.keys(tokens) as K[]) {
    probe.style.color = tokens[key];
    const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
    const parts = match?.[1]?.split(/[\s,/]+/).map(Number) ?? [];
    out[key] = [parts[0] ?? 128, parts[1] ?? 128, parts[2] ?? 128];
  }
  probe.remove();
  return out;
}

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
