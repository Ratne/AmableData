export { PERMISSIONS, ROLES, ROLE_PERMISSIONS, roleHasPermission } from './permissions';
export type { Permission, Role } from './permissions';

export { EVENT_TYPES, CRM_EVENT_TYPES, COMMERCE_EVENT_TYPES } from './events';
export type {
  EventType,
  DomainEvent,
  CrmEventPayloads,
  CrmEventType,
  CrmOutboxEvent,
  CommerceEventPayloads,
  CommerceEventType,
  OutboxEventPayloads,
  OutboxEventType,
  OutboxEvent,
  EventActor,
} from './events';
export { PUBLISHING_EVENT_TYPES } from './publishing-events';
export { CONVERSATION_EVENT_TYPES } from './conversation-events';
export type { ConversationEventPayloads, ConversationEventType } from './conversation-events';
export { OAUTH_SCOPES, devOAuthProvider, unavailableOAuthProvider } from './oauth';
export type {
  OAuthProviderId,
  OAuthScope,
  OAuthAccountRef,
  OAuthAccessToken,
  OAuthConnectStart,
  OAuthTokenProvider,
} from './oauth';
export type {
  PublishingEventPayloads,
  PublishingEventType,
  PublicSourceFacts,
  BookingFacts,
} from './publishing-events';

export {
  EMAIL_SEND_QUEUE,
  allowAllQuotaGuard,
  AUTOMATION_EVENT_TYPES,
  TRANSACTIONAL_EMAIL_PURPOSES,
} from './automation';
export type {
  EmailSendRequest,
  EmailSendContent,
  EmailSendSource,
  TransactionalEmailPurpose,
  QuotaGuard,
  QuotaCheck,
  QuotaDecision,
  AutomationEventPayloads,
  AutomationEventType,
  AutomationInboundEvent,
} from './automation';

export type {
  EmailMarketingProvider,
  MarketingEmail,
  SendEmailResult,
  ProviderTenant,
  DomainVerification,
  DomainVerificationStatus,
  DnsRecord,
} from './providers/email-marketing';
export type { SystemEmail, SystemEmailProvider } from './providers/system-email';
export {
  PostShibaEmailMarketingProvider,
  ProviderNotImplementedError,
  POSTSHIBA_DEFAULT_BASE_URL,
} from './providers/postshiba';
export type { PostShibaConfig } from './providers/postshiba';
export { NotifySystemEmailProvider } from './providers/notify';
export type { NotifyServiceConfig } from './providers/notify';
export { ConsoleEmailMarketingProvider, ConsoleSystemEmailProvider } from './providers/console';
export { EmailProviderError } from './providers/email-marketing';
export { FakeEmailMarketingProvider } from './providers/fake';
export { CloudflareSystemEmailProvider, UnconfiguredSystemEmailProvider } from './providers/cloudflare-email';
export type { CloudflareSystemEmailConfig, SendEmailBindingLike } from './providers/cloudflare-email';
export {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleOAuthError,
  GoogleOAuthTokenProvider,
} from './providers/google-oauth';
export type { GoogleOAuthConfig, OAuthFetch, OAuthKeyValueStore, OAuthSealer } from './providers/google-oauth';

export {
  CONTACT_TOKEN_PARAM,
  signEmailToken,
  verifyEmailToken,
  signContactToken,
  verifyContactToken,
} from './email/tokens';
export type {
  EmailTokenKind,
  EmailTokenPayload,
  ClickTokenPayload,
  OpenTokenPayload,
  UnsubscribeTokenPayload,
  ContactTokenPayload,
} from './email/tokens';
export { EMAIL_EVENT_TYPES } from './email/events';
export type { EmailEventPayloads, EmailEventType, EmailOutboxEvent } from './email/events';

export { ANALYTICS_AUTOMATION_EVENTS, RESERVED_ANALYTICS_GOALS } from './analytics';
export type {
  AnalyticsAutomationEventPayloads,
  AnalyticsAutomationEventType,
  AnalyticsGoalPayload,
  AnalyticsPageVisitedPayload,
} from './analytics';
