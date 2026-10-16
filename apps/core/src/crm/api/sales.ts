import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  activitySchema,
  appointmentSchema,
  calendarQuerySchema,
  calendarResponseSchema,
  createAppointmentSchema,
  createOpportunitySchema,
  createPipelineSchema,
  createStageSchema,
  createTaskSchema,
  deletedResponseSchema,
  idParamSchema,
  listAppointmentsQuerySchema,
  listOpportunitiesQuerySchema,
  listTasksQuerySchema,
  opportunitySchema,
  pageOf,
  pageQuerySchema,
  pipelineSchema,
  stageIdParamSchema,
  taskSchema,
  updateAppointmentSchema,
  updateOpportunitySchema,
  updatePipelineSchema,
  updateStageSchema,
  updateTaskSchema,
} from '@amable/api-types';
import { finishChange } from '../../booking/api';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from './core';

export function registerSalesRoutes(app: OpenAPIHono<AppEnv>): void {
  // ----------------------------------------------------------------- tasks
  const tasks = ['Tasks'];
  app.openapi(
    crmRoute('tasks:read', {
      method: 'get',
      path: '/tasks',
      tags: tasks,
      summary: 'List tasks',
      request: { query: listTasksQuerySchema },
      responses: { 200: json(pageOf(taskSchema), 'A page of tasks, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'tasks.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'post',
      path: '/tasks',
      tags: tasks,
      summary: 'Create a task',
      request: { body: jsonBody(createTaskSchema) },
      responses: { 201: json(taskSchema, 'The task') },
    }),
    async (c) => c.json(await callCrm(c, 'tasks.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('tasks:read', {
      method: 'get',
      path: '/tasks/{id}',
      tags: tasks,
      summary: 'Get a task',
      request: { params: idParamSchema },
      responses: { 200: json(taskSchema, 'The task') },
    }),
    async (c) => c.json(await callCrm(c, 'tasks.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'patch',
      path: '/tasks/{id}',
      tags: tasks,
      summary: 'Update a task',
      request: { params: idParamSchema, body: jsonBody(updateTaskSchema) },
      responses: { 200: json(taskSchema, 'The task') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'tasks.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'post',
      path: '/tasks/{id}/complete',
      tags: tasks,
      summary: 'Complete a task (emits task.completed)',
      request: { params: idParamSchema },
      responses: { 200: json(taskSchema, 'The task') },
    }),
    async (c) => c.json(await callCrm(c, 'tasks.complete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'post',
      path: '/tasks/{id}/reopen',
      tags: tasks,
      summary: 'Reopen a completed task',
      request: { params: idParamSchema },
      responses: { 200: json(taskSchema, 'The task') },
    }),
    async (c) => c.json(await callCrm(c, 'tasks.reopen', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'delete',
      path: '/tasks/{id}',
      tags: tasks,
      summary: 'Delete a task',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'tasks.delete', c.req.valid('param')), 200),
  );

  // ---------------------------------------------------------- appointments
  const appts = ['Appointments'];
  app.openapi(
    crmRoute('tasks:read', {
      method: 'get',
      path: '/appointments',
      tags: appts,
      summary: 'List appointments',
      description: '`from`/`to` select appointments overlapping the range; ordered by start.',
      request: { query: listAppointmentsQuerySchema },
      responses: { 200: json(pageOf(appointmentSchema), 'A page of appointments') },
    }),
    async (c) => c.json(await callCrm(c, 'appointments.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'post',
      path: '/appointments',
      tags: appts,
      summary: 'Create an appointment',
      request: { body: jsonBody(createAppointmentSchema) },
      responses: { 201: json(appointmentSchema, 'The appointment') },
    }),
    async (c) => c.json(await callCrm(c, 'appointments.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('tasks:read', {
      method: 'get',
      path: '/appointments/{id}',
      tags: appts,
      summary: 'Get an appointment',
      request: { params: idParamSchema },
      responses: { 200: json(appointmentSchema, 'The appointment') },
    }),
    async (c) => c.json(await callCrm(c, 'appointments.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'patch',
      path: '/appointments/{id}',
      tags: appts,
      summary:
        'Update an appointment (status=cancelled emits appointment.cancelled and cancels the linked booking, notifying the invitee)',
      request: { params: idParamSchema, body: jsonBody(updateAppointmentSchema) },
      responses: { 200: json(appointmentSchema, 'The appointment') },
    }),
    async (c) => {
      const result = await callCrm(c, 'booking.updateAppointment', {
        id: c.req.valid('param').id,
        data: c.req.valid('json'),
      });
      if (result.booking !== null) await finishChange(c, result.booking, null, true);
      return c.json(result.appointment, 200);
    },
  );
  app.openapi(
    crmRoute('tasks:write', {
      method: 'delete',
      path: '/appointments/{id}',
      tags: appts,
      summary: 'Delete an appointment (a linked booking is cancelled and the invitee notified)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const result = await callCrm(c, 'booking.deleteAppointment', c.req.valid('param'));
      if (result.booking !== null) await finishChange(c, result.booking, null, true);
      return c.json(result.appointment, 200);
    },
  );
  app.openapi(
    crmRoute('tasks:read', {
      method: 'get',
      path: '/calendar',
      tags: appts,
      summary: 'Calendar: appointments and due tasks in a range (max 92 days)',
      request: { query: calendarQuerySchema },
      responses: { 200: json(calendarResponseSchema, 'Calendar entries') },
    }),
    async (c) => c.json(await callCrm(c, 'calendar', c.req.valid('query')), 200),
  );

  // ------------------------------------------------------------- pipelines
  const pipelines = ['Pipelines'];
  app.openapi(
    crmRoute('opportunities:read', {
      method: 'get',
      path: '/pipelines',
      tags: pipelines,
      summary: 'List pipelines with their stages',
      responses: { 200: json(z.object({ data: z.array(pipelineSchema) }), 'Pipelines') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'pipelines.list', {}) }, 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/pipelines',
      tags: pipelines,
      summary: 'Create a pipeline',
      request: { body: jsonBody(createPipelineSchema) },
      responses: { 201: json(pipelineSchema, 'The pipeline') },
    }),
    async (c) => c.json(await callCrm(c, 'pipelines.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('opportunities:read', {
      method: 'get',
      path: '/pipelines/{id}',
      tags: pipelines,
      summary: 'Get a pipeline',
      request: { params: idParamSchema },
      responses: { 200: json(pipelineSchema, 'The pipeline') },
    }),
    async (c) => c.json(await callCrm(c, 'pipelines.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/pipelines/{id}',
      tags: pipelines,
      summary: 'Update a pipeline',
      request: { params: idParamSchema, body: jsonBody(updatePipelineSchema) },
      responses: { 200: json(pipelineSchema, 'The pipeline') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'pipelines.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/pipelines/{id}',
      tags: pipelines,
      summary: 'Delete an empty pipeline',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'pipelines.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/pipelines/{id}/stages',
      tags: pipelines,
      summary: 'Add a stage',
      request: { params: idParamSchema, body: jsonBody(createStageSchema) },
      responses: { 201: json(pipelineSchema, 'The pipeline') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'pipelines.createStage', {
          pipelineId: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/pipelines/{id}/stages/{stageId}',
      tags: pipelines,
      summary: 'Update a stage',
      request: { params: stageIdParamSchema, body: jsonBody(updateStageSchema) },
      responses: { 200: json(pipelineSchema, 'The pipeline') },
    }),
    async (c) => {
      const { id, stageId } = c.req.valid('param');
      return c.json(
        await callCrm(c, 'pipelines.updateStage', {
          pipelineId: id,
          stageId,
          data: c.req.valid('json'),
        }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/pipelines/{id}/stages/{stageId}',
      tags: pipelines,
      summary: 'Delete an unused stage',
      request: { params: stageIdParamSchema },
      responses: { 200: json(pipelineSchema, 'The pipeline') },
    }),
    async (c) => {
      const { id, stageId } = c.req.valid('param');
      return c.json(await callCrm(c, 'pipelines.deleteStage', { pipelineId: id, stageId }), 200);
    },
  );

  // --------------------------------------------------------- opportunities
  const opps = ['Opportunities'];
  app.openapi(
    crmRoute('opportunities:read', {
      method: 'get',
      path: '/opportunities',
      tags: opps,
      summary: 'List opportunities',
      request: { query: listOpportunitiesQuerySchema },
      responses: { 200: json(pageOf(opportunitySchema), 'A page of opportunities, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'opportunities.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('opportunities:write', {
      method: 'post',
      path: '/opportunities',
      tags: opps,
      summary: 'Create an opportunity',
      request: { body: jsonBody(createOpportunitySchema) },
      responses: { 201: json(opportunitySchema, 'The opportunity') },
    }),
    async (c) => c.json(await callCrm(c, 'opportunities.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('opportunities:read', {
      method: 'get',
      path: '/opportunities/{id}',
      tags: opps,
      summary: 'Get an opportunity',
      request: { params: idParamSchema },
      responses: { 200: json(opportunitySchema, 'The opportunity') },
    }),
    async (c) => c.json(await callCrm(c, 'opportunities.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('opportunities:write', {
      method: 'patch',
      path: '/opportunities/{id}',
      tags: opps,
      summary: 'Update an opportunity',
      description:
        'Changing `stage_id` records the move and emits `opportunity.stage_changed` (+ won/lost).',
      request: { params: idParamSchema, body: jsonBody(updateOpportunitySchema) },
      responses: { 200: json(opportunitySchema, 'The opportunity') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'opportunities.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('opportunities:write', {
      method: 'delete',
      path: '/opportunities/{id}',
      tags: opps,
      summary: 'Delete an opportunity',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'opportunities.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('opportunities:read', {
      method: 'get',
      path: '/opportunities/{id}/timeline',
      tags: opps,
      summary: 'Activity timeline of an opportunity',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(pageOf(activitySchema), 'Activities, newest first') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'timeline', {
          subject: 'opportunity',
          id: c.req.valid('param').id,
          ...c.req.valid('query'),
        }),
        200,
      ),
  );
}
