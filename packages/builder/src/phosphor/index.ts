import { hasPhosphor, PHOSPHOR_WEIGHTS, registerPhosphor, type PhosphorWeight } from '../icons';

type Pack = Promise<{ default: Record<string, string> }>;

const PACKS: Record<PhosphorWeight, () => Pack> = {
  regular: () => import('./regular'),
  thin: () => import('./thin'),
  light: () => import('./light'),
  bold: () => import('./bold'),
  fill: () => import('./fill'),
  duotone: () => import('./duotone'),
};

const pending = new Map<PhosphorWeight, Promise<void>>();

/** Load and register one Phosphor weight (no-op once registered). */
export function loadPhosphor(weight: PhosphorWeight): Promise<void> {
  if (hasPhosphor(weight)) return Promise.resolve();
  let p = pending.get(weight);
  if (!p) {
    p = PACKS[weight]().then((m) => registerPhosphor(weight, m.default));
    pending.set(weight, p);
  }
  return p;
}

/** Weights referenced anywhere in a value (e.g. a builder document). */
export function phosphorWeightsIn(value: unknown): PhosphorWeight[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const found = new Set<PhosphorWeight>();
  for (const m of text.matchAll(/"ph(?:-(thin|light|bold|fill|duotone))?:[a-z0-9-]+"/g)) {
    found.add((m[1] as PhosphorWeight | undefined) ?? 'regular');
  }
  return PHOSPHOR_WEIGHTS.filter((w) => found.has(w));
}

/** Weights referenced by `value` that still need to be loaded. */
export function missingPhosphorWeights(value: unknown): PhosphorWeight[] {
  return phosphorWeightsIn(value).filter((w) => !hasPhosphor(w));
}

export function loadPhosphorCatalog(): Promise<ReadonlyArray<readonly [string, string]>> {
  return import('./catalog').then((m) => m.PHOSPHOR_CATALOG);
}
