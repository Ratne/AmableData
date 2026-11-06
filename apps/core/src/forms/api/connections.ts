import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  connectionParamSchema,
  connectionTestResultSchema,
  createConnectionSchema,
  deletedResponseSchema,
  formConnectionSchema,
  formConnectionWithSecretSchema,
  formIdParamSchema,
  updateConnectionSchema,
  type FormConnectionWithSecret,
} from '@amable/api-types';
import { randomToken } from '@amable/auth';
import { ulid } from 'ulid';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { CrmError } from '../../crm/errors';
import { audit, getTenant, type AppEnv } from '../../middleware';
import { connectorOf } from '../connectors/registry';
import { encryptSecret, secretHint } from '../crypto';
import { testConnection } from '../process';
import { formsRuntime } from '../runtime';
import {
  connectionsTag,
  touchesConnectionSecrets,
  configIssues,
  checkedSecretHint,
} from './shared';

export function registerConnectionsRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms/{formId}/connections',
      tags: connectionsTag,
      summary: 'List the connections of a form (secrets are never returned)',
      request: { params: formIdParamSchema },
      responses: { 200: json(z.object({ data: z.array(formConnectionSchema) }), 'Connections') },
    }),
    async (c) =>
      c.json(
        {
          data: await callCrm(c, 'forms.listConnections', { formId: c.req.valid('param').formId }),
        },
        200,
      ),
  );
  router.openapi(
    crmRoute(
      'forms:connections_manage',
      {
        method: 'post',
        path: '/forms/{formId}/connections',
        tags: connectionsTag,
        summary: 'Create a connection (a webhook signing secret is returned once)',
        request: { params: formIdParamSchema, body: jsonBody(createConnectionSchema) },
        responses: { 201: json(formConnectionWithSecretSchema, 'The connection') },
      },
      { stepUp: true },
    ),
    async (c) => {
      const { formId } = c.req.valid('param');
      const body = c.req.valid('json');
      const connector = connectorOf(body.type);
      if (connector === null) throw new CrmError('bad_request', `unknown connector ${body.type}`);
      const id = ulid();
      const tenantId = getTenant(c).tenant.id;
      const box = c.get('services').secretBox;
      let secret: string | null = null;
      if (connector.secret === 'generated') secret = `whsec_${randomToken(24)}`;
      if (body.type === 'docuseal' || body.type === 'google_sheets') secret = body.secret;
      const hint = secret === null ? null : checkedSecretHint(connector, secret);
      const connection = await callCrm(c, 'forms.createConnection', {
        id,
        formId,
        type: body.type,
        name: body.name,
        enabled: body.enabled ?? true,
        config: await configIssues(c.env, tenantId, body.type, body.config),
        secretCiphertext: secret === null ? null : await encryptSecret(box, tenantId, id, secret),
        secretHint: hint,
      });
      await audit(c, 'forms.connection_created', {
        target: id,
        details: { form_id: formId, type: body.type },
      });
      const response: FormConnectionWithSecret = {
        ...connection,
        signing_secret: connector.secret === 'generated' ? secret : null,
      };
      return c.json(response, 201);
    },
  );
  router.openapi(
    crmRoute(
      'forms:connections_manage',
      {
        method: 'patch',
        path: '/forms/{formId}/connections/{connectionId}',
        tags: connectionsTag,
        summary: 'Update a connection (config is replaced and validated against its type)',
        request: { params: connectionParamSchema, body: jsonBody(updateConnectionSchema) },
        responses: { 200: json(formConnectionSchema, 'The connection') },
      },
      { stepUp: touchesConnectionSecrets },
    ),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const body = c.req.valid('json');
      const current = await callCrm(c, 'forms.getConnection', { formId, id: connectionId });
      const connector = connectorOf(current.type);
      if (body.secret !== undefined && connector?.secret !== 'api_key') {
        throw new CrmError('validation_failed', 'this connection has no API key', [
          { path: 'secret', message: 'not supported by this connector' },
        ]);
      }
      const tenantId = getTenant(c).tenant.id;
      const connection = await callCrm(c, 'forms.updateConnection', {
        formId,
        id: connectionId,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.config === undefined
          ? {}
          : { config: await configIssues(c.env, tenantId, current.type, body.config) }),
        ...(body.secret === undefined
          ? {}
          : {
              secretHint: checkedSecretHint(connector, body.secret),
              secretCiphertext: await encryptSecret(
                c.get('services').secretBox,
                tenantId,
                connectionId,
                body.secret,
              ),
            }),
      });
      await audit(c, 'forms.connection_updated', {
        target: connectionId,
        details: { form_id: formId, secret_changed: body.secret !== undefined },
      });
      return c.json(connection, 200);
    },
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'delete',
      path: '/forms/{formId}/connections/{connectionId}',
      tags: connectionsTag,
      summary: 'Delete a connection',
      request: { params: connectionParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const result = await callCrm(c, 'forms.deleteConnection', { formId, id: connectionId });
      await audit(c, 'forms.connection_deleted', {
        target: connectionId,
        details: { form_id: formId },
      });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute(
      'forms:connections_manage',
      {
        method: 'post',
        path: '/forms/{formId}/connections/{connectionId}/rotateSecret',
        tags: connectionsTag,
        summary: 'Generate a new webhook signing secret (returned once; the old one stops working)',
        request: { params: connectionParamSchema },
        responses: { 200: json(formConnectionWithSecretSchema, 'The connection') },
      },
      { stepUp: true },
    ),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const current = await callCrm(c, 'forms.getConnection', { formId, id: connectionId });
      if (connectorOf(current.type)?.secret !== 'generated') {
        throw new CrmError('bad_request', 'this connection has no signing secret');
      }
      const secret = `whsec_${randomToken(24)}`;
      const connection = await callCrm(c, 'forms.updateConnection', {
        formId,
        id: connectionId,
        secretCiphertext: await encryptSecret(
          c.get('services').secretBox,
          getTenant(c).tenant.id,
          connectionId,
          secret,
        ),
        secretHint: secretHint(secret),
      });
      await audit(c, 'forms.connection_secret_rotated', {
        target: connectionId,
        details: { form_id: formId },
      });
      return c.json({ ...connection, signing_secret: secret }, 200);
    },
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'post',
      path: '/forms/{formId}/connections/{connectionId}/test',
      tags: connectionsTag,
      summary: 'Deliver a sample submission through the connection',
      request: { params: connectionParamSchema },
      responses: { 200: json(connectionTestResultSchema, 'Test result') },
    }),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const form = await callCrm(c, 'forms.get', { id: formId });
      const connection = await callCrm(c, 'forms.connectionForWorker', {
        formId,
        id: connectionId,
      });
      const fields = (form.definition['fields'] ?? []) as Parameters<
        typeof testConnection
      >[0]['form']['fields'];
      const result = await testConnection({
        env: c.env,
        runtime: await formsRuntime(c.env),
        tenantId: getTenant(c).tenant.id,
        form: { id: form.id, name: form.name, fields },
        connection,
      });
      await audit(c, 'forms.connection_tested', {
        target: connectionId,
        details: { form_id: formId, status: result.status },
      });
      return c.json(result, 200);
    },
  );
}
