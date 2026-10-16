import type { CrmContext } from '../crm/context';
import * as connections from './connections';
import * as forms from './forms';
import * as submissions from './submissions';

/**
 * Forms operations of the TenantDb (merged into `crmOps`). Synchronous, one
 * transaction per call: encryption, Turnstile, connectors and queues run in
 * the worker around them (see gateway.ts, process.ts, api.ts).
 */
export const formsOps = {
  'forms.list': forms.listForms,
  'forms.get': forms.getForm,
  'forms.create': forms.createForm,
  'forms.update': forms.updateForm,
  'forms.delete': forms.deleteForm,
  'forms.duplicate': forms.duplicateForm,
  'forms.archive': forms.archiveForm,
  'forms.restore': forms.restoreForm,
  'forms.public': forms.publicForm,
  // submissions
  'forms.storeSubmission': submissions.storeSubmission,
  'forms.loadSubmission': submissions.loadSubmission,
  'forms.applySubmission': submissions.applySubmission,
  'forms.failSubmission': submissions.failSubmission,
  'forms.recordDelivery': submissions.recordDelivery,
  'forms.listSubmissions': submissions.listSubmissions,
  'forms.getSubmission': submissions.getSubmission,
  'forms.deleteSubmission': submissions.deleteSubmission,
  'forms.contactSubmissions': submissions.listContactSubmissions,
  'forms.contactSubmission': submissions.getContactSubmission,
  // connections
  'forms.listConnections': connections.listConnections,
  'forms.getConnection': connections.getConnection,
  'forms.connectionForWorker': connections.connectionForWorker,
  'forms.createConnection': connections.createConnection,
  'forms.updateConnection': connections.updateConnection,
  'forms.deleteConnection': connections.deleteConnection,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
