import type {
  CreateAutomationInput,
  CreateFolderInput,
  MoveFolderItemsInput,
  UpdateFolderInput,
  EnrollContactInput,
  ListAutomationsQuery,
  ListContactEnrollmentsQuery,
  ListEnrollmentsQuery,
  SaveDraftInput,
  TriggerApiGoalInput,
  UpdateAutomationInput,
} from '@amable/api-types';
import type { SqlDb } from '../crm/db/sql';
import { CrmError } from '../crm/errors';
import type { CrmResult } from '../crm/ops';
import type { AutomationEngine, EngineActor } from './engine';

type Id = { id: string };

/**
 * Every operation the Engine DO exposes to the REST layer, keyed by name
 * (single RPC entry point `Engine.automation`, like `TenantDb.crm`).
 */
export const automationOps = {
  'automations.list': (e: AutomationEngine, _a: EngineActor, input: ListAutomationsQuery) =>
    e.listAutomations(input),
  'automations.get': (e: AutomationEngine, _a: EngineActor, input: Id) => e.getAutomation(input),
  'automations.create': (e: AutomationEngine, a: EngineActor, input: CreateAutomationInput) =>
    e.createAutomation(a, input),
  'automations.update': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; data: UpdateAutomationInput },
  ) => e.updateAutomation(input),
  'automations.delete': (e: AutomationEngine, _a: EngineActor, input: Id) =>
    e.deleteAutomation(input),
  'automations.saveDraft': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; data: SaveDraftInput },
  ) => e.saveDraft(input),
  'automations.validate': (e: AutomationEngine, _a: EngineActor, input: Id) =>
    e.validateDraft(input),
  'automations.publish': (e: AutomationEngine, a: EngineActor, input: Id) => e.publish(a, input),
  'automations.unpublish': (e: AutomationEngine, _a: EngineActor, input: Id) => e.unpublish(input),
  'automations.versions': (e: AutomationEngine, _a: EngineActor, input: Id) =>
    e.listVersions(input),
  'automations.version': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; versionId: string },
  ) => e.getVersion(input),
  'automations.restoreVersion': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; versionId: string },
  ) => e.restoreVersion(input),
  'automations.enrollments': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; query: ListEnrollmentsQuery },
  ) => e.listEnrollments(input),
  'automations.enrollment': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; enrollmentId: string },
  ) => e.getEnrollment(input),
  'automations.enroll': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; data: EnrollContactInput },
  ) => e.enrollContact(input),
  'automations.removeContact': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; contactId: string },
  ) => e.removeContact(input),
  'contacts.enrollments': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { contactId: string; query: ListContactEnrollmentsQuery },
  ) => e.contactEnrollments(input),
  'contacts.enrollmentCounts': (e: AutomationEngine, _a: EngineActor, input: { contactId: string }) =>
    e.contactEnrollmentCounts(input),
  'automations.stats': (e: AutomationEngine, _a: EngineActor, input: Id) => e.stats(input),
  'automations.signingSecret': (e: AutomationEngine, _a: EngineActor, input: Id) =>
    e.getSigningSecret(input),
  'automations.rotateSigningSecret': (e: AutomationEngine, _a: EngineActor, input: Id) =>
    e.rotateSigningSecret(input),
  'goals.triggerApi': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { callName: string; data: TriggerApiGoalInput },
  ) => e.triggerApiGoal(input),
  'folders.list': (e: AutomationEngine, _a: EngineActor, _input: Record<string, never>) =>
    e.folders.tree(),
  'folders.get': (e: AutomationEngine, _a: EngineActor, input: Id) => e.folders.get(input),
  'folders.create': (e: AutomationEngine, _a: EngineActor, input: CreateFolderInput) =>
    e.folders.create(input),
  'folders.update': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; data: UpdateFolderInput },
  ) => e.folders.update(input),
  'folders.delete': (
    e: AutomationEngine,
    _a: EngineActor,
    input: { id: string; mode: 'empty' | 'move_to_parent' },
  ) => e.folders.delete(input),
  'folders.moveItems': (e: AutomationEngine, _a: EngineActor, input: MoveFolderItemsInput) =>
    e.folders.moveItems(input),
  'settings.get': (e: AutomationEngine, _a: EngineActor, _input: Record<string, never>) =>
    e.getSettings(),
  'settings.update': (e: AutomationEngine, _a: EngineActor, input: { time_zone: string }) =>
    e.updateSettings(input),
} satisfies Record<string, (engine: AutomationEngine, actor: EngineActor, input: never) => unknown>;

export type AutomationOps = typeof automationOps;
export type AutomationOpName = keyof AutomationOps;
export type AutomationOpInput<K extends AutomationOpName> = Parameters<AutomationOps[K]>[2];
export type AutomationOpOutput<K extends AutomationOpName> = Awaited<ReturnType<AutomationOps[K]>>;

export function isAutomationOp(op: string): op is AutomationOpName {
  return Object.hasOwn(automationOps, op);
}

/**
 * Runs one operation: the synchronous part inside one SQLite transaction
 * (async operations open their own), then re-arms the scheduler. Domain errors
 * become `{ ok: false }` results; anything else surfaces as a 500.
 */
export async function runAutomationOp(
  db: SqlDb,
  engine: AutomationEngine,
  actor: EngineActor,
  op: string,
  input: unknown,
): Promise<CrmResult<unknown>> {
  if (!isAutomationOp(op)) {
    return {
      ok: false,
      error: new CrmError('bad_request', `unknown automation operation ${op}`).toShape(),
    };
  }
  const fn = automationOps[op] as (
    engine: AutomationEngine,
    actor: EngineActor,
    input: unknown,
  ) => unknown;
  try {
    const value = await db.transaction(() => fn(engine, actor, input));
    await engine.arm();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CrmError) return { ok: false, error: error.toShape() };
    throw error;
  }
}
