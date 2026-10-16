import { z } from "zod";

/**
 * Global design tokens for a canvas document.
 * Rendered as CSS custom properties (`--b-*`) on the document root, so widget
 * style controls can reference them via `var(--b-color-primary)` etc.
 */
export const builderTokensSchema = z.object({
  /** Brand primary color. */
  primary: z.string().default("#2563eb"),
  /** Brand secondary color. */
  secondary: z.string().default("#7c3aed"),
  /** Accent / highlight color. */
  accent: z.string().default("#f59e0b"),
  /** Default body text color. */
  text: z.string().default("#334155"),
  /** Default heading color. */
  heading: z.string().default("#0f172a"),
  /** Page background. */
  background: z.string().default("#ffffff"),
  /** Muted surface (alternating bands, cards). */
  muted: z.string().default("#f4f5f7"),
  /** Hairline border color. */
  border: z.string().default("#e2e8f0"),
  /** Heading font family. */
  fontHeading: z.string().default("Poppins"),
  /** Body font family. */
  fontBody: z.string().default("Inter"),
  /** Base border radius. */
  radius: z.string().default("0.5rem"),
  /** Large border radius (feature cards, media). */
  radiusLg: z.string().default("1rem"),
  /** Boxed content width. */
  containerWidth: z.string().default("1140px"),
});
export type BuilderTokens = z.infer<typeof builderTokensSchema>;

/** The token keys that represent a color, offered as global swatches in the UI. */
export const COLOR_TOKEN_KEYS = [
  "primary",
  "secondary",
  "accent",
  "text",
  "heading",
  "background",
  "muted",
  "border",
] as const;
export type ColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];

/** CSS custom-property name for a token key (e.g. "primary" -> "--b-color-primary"). */
export function colorVar(key: ColorTokenKey): string {
  return `var(--b-color-${key})`;
}

/** Emit the `:root` CSS custom properties for a token set. */
export function tokensToCss(tokens: BuilderTokens): string {
  return `:root{
--b-color-primary:${tokens.primary};
--b-color-secondary:${tokens.secondary};
--b-color-accent:${tokens.accent};
--b-color-text:${tokens.text};
--b-color-heading:${tokens.heading};
--b-color-background:${tokens.background};
--b-color-muted:${tokens.muted};
--b-color-border:${tokens.border};
--b-font-heading:${JSON.stringify(tokens.fontHeading)},system-ui,sans-serif;
--b-font-body:${JSON.stringify(tokens.fontBody)},system-ui,sans-serif;
--b-radius:${tokens.radius};
--b-radius-lg:${tokens.radiusLg};
--b-container:${tokens.containerWidth};
}`;
}

/** The Google Font families used by a token set (for the fonts <link>). */
export function tokenFontFamilies(tokens: BuilderTokens): string[] {
  return Array.from(new Set([tokens.fontHeading, tokens.fontBody].filter(Boolean)));
}
