import type { CrmContext } from '../crm/context';
import * as due from './due';
import * as requests from './requests';
import * as signing from './signing';
import * as templates from './templates';

/**
 * Electronic signature operations of the TenantDb (merged into `crmOps`).
 * Synchronous, one transaction per call: R2 objects, PDF rendering, token
 * derivation and emails are handled by the worker / alarm around them.
 */
export const esignOps = {
  // templates
  'esign.templates.list': templates.listTemplates,
  'esign.templates.catalog': templates.templateCatalog,
  'esign.templates.get': templates.getTemplate,
  'esign.templates.create': templates.createTemplate,
  'esign.templates.update': templates.updateTemplate,
  'esign.templates.delete': templates.deleteTemplate,
  'esign.templates.setSource': templates.setTemplateSource,
  'esign.templates.setPageImage': templates.setTemplatePageImage,
  'esign.templates.file': templates.templateFile,
  // requests (staff / API / automations)
  'esign.requests.create': requests.createRequest,
  'esign.requests.createFromAutomation': requests.createRequestFromAutomation,
  'esign.requests.list': requests.listRequests,
  'esign.requests.get': requests.getRequest,
  'esign.requests.detail': requests.getRequestDetail,
  'esign.requests.void': requests.voidRequest,
  'esign.requests.remind': requests.remindRequest,
  'esign.requests.signerLink': requests.signerLinkFacts,
  'esign.requests.file': requests.requestFile,
  'esign.requests.retryFinalize': due.retryFinalize,
  'esign.signers.setTokenHash': requests.setTokenHash,
  // signer actions (public gateway)
  'esign.signer.view': signing.signerView,
  'esign.signer.fields': signing.signerFields,
  'esign.signer.otpIssue': signing.otpIssue,
  'esign.signer.otpVerify': signing.otpVerify,
  'esign.signer.complete': signing.completeSigning,
  'esign.signer.decline': signing.declineSigning,
  'esign.signer.file': signing.signerFile,
  // TenantDb alarm
  'esign.due': due.esignDue,
  'esign.markNotified': due.markNotified,
  'esign.mailUndelivered': due.mailUndelivered,
  'esign.finalizeContext': due.finalizeContext,
  'esign.finalizeLease': due.finalizeLease,
  'esign.markFinalized': due.markFinalized,
  'esign.markFinalizeFailed': due.markFinalizeFailed,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
