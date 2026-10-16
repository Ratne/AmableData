/** Visual settings of the rendered email; per tenant or per template. */
export interface EmailTheme {
  /** Fixed content width in pixels. */
  readonly width: number;
  readonly backgroundColor: string;
  readonly contentBackgroundColor: string;
  readonly textColor: string;
  readonly mutedTextColor: string;
  readonly linkColor: string;
  readonly borderColor: string;
  readonly buttonColor: string;
  readonly buttonTextColor: string;
  readonly fontFamily: string;
}

export const DEFAULT_EMAIL_THEME: EmailTheme = {
  width: 600,
  backgroundColor: '#f4f4f5',
  contentBackgroundColor: '#ffffff',
  textColor: '#161616',
  mutedTextColor: '#737373',
  linkColor: '#2563eb',
  borderColor: '#e7e7e7',
  buttonColor: '#2563eb',
  buttonTextColor: '#ffffff',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};
