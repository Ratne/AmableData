/**
 * Curated inline SVG icon set (Lucide-style, stroke = currentColor) plus social
 * brand glyphs (fill = currentColor). Referenced by name from widget settings so
 * the rendered page stays self-contained (no icon font / external request).
 */
const P = (paths: string): string =>
  `<svg class="b-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const F = (paths: string): string =>
  `<svg class="b-svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${paths}</svg>`;

const ICONS: Record<string, string> = {
  sparkles: P('<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>'),
  heart: P('<path d="M20.8 8.6a5 5 0 0 0-8.8-3 5 5 0 0 0-8.8 3c0 4.4 8.8 10 8.8 10s8.8-5.6 8.8-10z"/>'),
  leaf: P('<path d="M11 20A7 7 0 0 1 4 13c0-4 3-8 9-9 1 6-1 12-2 16z"/><path d="M4 20c4-6 8-8 13-9"/>'),
  star: P('<path d="M12 3l2.9 6 6.1.9-4.5 4.3 1.1 6.1L12 17.8 6.4 20.3l1.1-6.1L3 9.9 9.1 9z"/>'),
  check: P('<path d="M20 6L9 17l-5-5"/>'),
  "check-circle": P('<circle cx="12" cy="12" r="9"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  shield: P('<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/>'),
  clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  gift: P('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M4 12v8h16v-8"/><path d="M12 8v12"/><path d="M12 8S10 3 7.5 4.5 9.5 8 12 8zM12 8s2-5 4.5-3.5S14.5 8 12 8z"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  users: P('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 21c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M17 6.2a3.5 3.5 0 0 1 0 6.6"/><path d="M18 15.5c2.6.5 4 2.4 4 5.5"/>'),
  calendar: P('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
  phone: P('<path d="M6 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/>'),
  mail: P('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  "map-pin": P('<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  award: P('<circle cx="12" cy="9" r="5"/><path d="M9 13.5L7.5 21 12 18l4.5 3L15 13.5"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  clipboard: P('<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4a2 2 0 0 1 6 0"/><path d="M9 11h6M9 15h4"/>'),
  scissors: P('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 8l12 8M8 16l12-8"/>'),
  droplet: P('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
  flower: P('<circle cx="12" cy="12" r="2.5"/><path d="M12 9.5A2.5 2.5 0 1 0 12 4a2.5 2.5 0 0 0 0 5.5zM12 14.5A2.5 2.5 0 1 1 12 20a2.5 2.5 0 0 1 0-5.5zM9.5 12A2.5 2.5 0 1 1 4 12a2.5 2.5 0 0 1 5.5 0zM14.5 12A2.5 2.5 0 1 0 20 12a2.5 2.5 0 0 0-5.5 0z"/>'),
  zap: P('<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>'),
  target: P('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>'),
  smile: P('<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>'),
  "trending-up": P('<path d="M3 17l6-6 4 4 7-7"/><path d="M17 8h4v4"/>'),
  "thumbs-up": P('<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 2l-1 6h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 20 21H7"/>'),
  crown: P('<path d="M3 8l4 4 5-7 5 7 4-4-2 12H5z"/>'),
  gem: P('<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M9 3l-3 6 6 12 6-12-3-6"/>'),
  "arrow-right": P('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  "chevron-down": P('<path d="M6 9l6 6 6-6"/>'),
  play: P('<path d="M6 4l14 8-14 8z"/>'),
  home: P('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  settings: P('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'),
};

const SOCIAL: Record<string, string> = {
  facebook: F('<path d="M14 9h3V6h-3c-2 0-3 1-3 3v2H8v3h3v6h3v-6h2.5l.5-3H14V9.5c0-.3.2-.5.5-.5z"/>'),
  instagram: P('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/>'),
  x: F('<path d="M17 3h3l-7 8 8 10h-6l-4-5-5 5H3l7-9L3 3h6l4 5z"/>'),
  linkedin: F('<path d="M6.5 8H4v11h2.5zM5.2 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM20 19v-6c0-3-1.6-4.4-3.7-4.4-1.7 0-2.5 1-2.9 1.6V8H11v11h2.5v-6.1c0-1.3.9-1.9 1.8-1.9s1.7.6 1.7 1.9V19z"/>'),
  youtube: F('<path d="M22 12s0-3-.4-4.4a2.6 2.6 0 0 0-1.8-1.8C18 5.4 12 5.4 12 5.4s-6 0-7.8.4A2.6 2.6 0 0 0 2.4 7.6C2 9 2 12 2 12s0 3 .4 4.4a2.6 2.6 0 0 0 1.8 1.8c1.8.4 7.8.4 7.8.4s6 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8C22 15 22 12 22 12zM10 15V9l5 3z"/>'),
  whatsapp: F('<path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2zm5.3 14c-.2.6-1.2 1.2-1.7 1.2-.4 0-1 .1-3.2-.9-2.7-1.2-4.4-4-4.5-4.2-.1-.2-1-1.4-1-2.7s.6-1.9.9-2.1c.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.2.1.4.1.6-.1l.7-.9c.2-.2.4-.2.6-.1l1.9.9c.2.1.4.2.4.3.1.2.1.6 0 1z"/>'),
  telegram: F('<path d="M21.9 4.3l-3 14c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.4.4-.9.4l.3-4.7 8.5-7.7c.4-.3-.1-.5-.6-.2L7 12.6l-4.5-1.4c-1-.3-1-1 .2-1.4l17-6.6c.8-.3 1.5.2 1.2 1.5z"/>'),
};

/** Return the inline SVG for an icon name, or empty string if unknown. */
export function icon(name: unknown): string {
  if (typeof name !== "string") return "";
  return ICONS[name.trim().toLowerCase()] ?? "";
}

/** Return a social brand glyph, or a generic link glyph as fallback. */
export function socialIcon(network: unknown): string {
  if (typeof network !== "string") return ICONS["arrow-right"]!;
  return SOCIAL[network.trim().toLowerCase()] ?? ICONS["arrow-right"]!;
}

/** All known icon names (for the editor picker). */
export const ICON_NAMES = Object.keys(ICONS);
