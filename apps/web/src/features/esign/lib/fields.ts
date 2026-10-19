import type { EsignField, EsignFieldType, EsignPage, EsignParty } from '@amable/api-types';

/** Default size of a new field, as a fraction of the page width and of the page width again for the height. */
const DEFAULT_SIZE: Record<EsignFieldType, { w: number; h: number }> = {
  signature: { w: 0.26, h: 0.09 },
  initials: { w: 0.1, h: 0.06 },
  text: { w: 0.28, h: 0.04 },
  number: { w: 0.16, h: 0.04 },
  date: { w: 0.18, h: 0.04 },
  checkbox: { w: 0.03, h: 0.03 },
  select: { w: 0.24, h: 0.04 },
  radio: { w: 0.24, h: 0.1 },
  image: { w: 0.22, h: 0.16 },
  signed_date: { w: 0.18, h: 0.04 },
};

export const PARTY_COLORS = ['#4f46e5', '#db2777', '#0d9488', '#d97706', '#7c3aed', '#0284c7', '#65a30d', '#dc2626', '#475569', '#c026d3'] as const;

export const MIN_SIZE = 0.01;

export function newFieldId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `f${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('')}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A field of `type` centred on (cx, cy), kept inside the page. */
export function newField(type: EsignFieldType, partyId: string, page: EsignPage, cx: number, cy: number): EsignField {
  const size = DEFAULT_SIZE[type];
  const w = size.w;
  const h = Math.min(0.5, (size.h * page.width) / page.height);
  return {
    id: newFieldId(),
    type,
    party_id: partyId,
    page: page.index,
    x: round(clamp(cx - w / 2, 0, 1 - w)),
    y: round(clamp(cy - h / 2, 0, 1 - h)),
    w: round(w),
    h: round(h),
    required: type !== 'checkbox',
    label: '',
    options: type === 'select' || type === 'radio' ? ['1', '2'] : [],
  };
}

export function newParty(existing: readonly EsignParty[], name: string): EsignParty {
  const ids = new Set(existing.map((p) => p.id));
  let n = existing.length + 1;
  while (ids.has(`party-${String(n)}`)) n += 1;
  const color = PARTY_COLORS[existing.length % PARTY_COLORS.length] ?? PARTY_COLORS[0];
  return { id: `party-${String(n)}`, name, color };
}

export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function partyColor(parties: readonly EsignParty[], partyId: string): string {
  const index = parties.findIndex((p) => p.id === partyId);
  return parties[index]?.color ?? PARTY_COLORS[Math.max(0, index) % PARTY_COLORS.length] ?? PARTY_COLORS[0];
}

/** Every page has its image and every party at least one field (same rule as the server). */
export function templateReady(pages: readonly EsignPage[], parties: readonly EsignParty[], fields: readonly EsignField[]): boolean {
  return (
    pages.length > 0 &&
    pages.every((p) => p.has_image) &&
    parties.length > 0 &&
    parties.every((party) => fields.some((f) => f.party_id === party.id && f.page < pages.length))
  );
}
