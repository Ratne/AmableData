import { renderSystemEmail, resolveLocale, type SystemEmailKind, type SystemEmailVars } from '@amable/i18n';
import type { AuthServices } from './services';

/**
 * Sends a system email through the configured SystemEmailProvider, rendered in
 * the recipient's language. OTP codes and links are awaited by the caller (sent
 * immediately); notices go through `defer` so the response is not delayed.
 */
export async function sendSystemEmail<K extends SystemEmailKind>(
  services: AuthServices,
  to: string,
  locale: string,
  kind: K,
  vars: SystemEmailVars[K],
): Promise<void> {
  const resolved = resolveLocale(locale);
  const rendered = renderSystemEmail(
    kind,
    resolved,
    vars,
    services.brandLogoUrl === undefined ? {} : { logoUrl: services.brandLogoUrl },
  );
  await services.email.send({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    locale: resolved,
  });
}
