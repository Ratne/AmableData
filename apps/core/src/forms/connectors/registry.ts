import type { ConnectorInfo, ConnectorType } from '@amable/api-types';
import type { FormsRuntime } from '../runtime';
import { docusealConnector } from './docuseal';
import { emailNotificationConnector } from './email-notification';
import { googleSheetsConnector } from './google-sheets';
import type { Connector } from './types';
import { webhookConnector } from './webhook';

/** Every connector, by type. Adding one: implement `Connector` and list it here (and in CONNECTOR_TYPES). */
export const CONNECTORS: { readonly [K in ConnectorType]: Connector<unknown> } = {
  webhook: webhookConnector as Connector<unknown>,
  google_sheets: googleSheetsConnector as Connector<unknown>,
  email_notification: emailNotificationConnector as Connector<unknown>,
  docuseal: docusealConnector as Connector<unknown>,
};

export function connectorOf(type: string): Connector<unknown> | null {
  return Object.hasOwn(CONNECTORS, type) ? CONNECTORS[type as ConnectorType] : null;
}

export function connectorCatalog(runtime: FormsRuntime): ConnectorInfo[] {
  return Object.values(CONNECTORS).map((c) => ({
    type: c.type,
    secret: c.secret,
    oauth_provider: c.oauthProvider,
    available: c.available(runtime),
  }));
}
