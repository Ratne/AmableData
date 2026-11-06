import type { OpenAPIHono } from '@hono/zod-openapi';
import { callCrm } from '../../crm/api/core';
import { registerEditLockRoutes } from '../../edit-lock/routes';
import type { AppEnv } from '../../middleware';

export function registerPageLockRoutes(router: OpenAPIHono<AppEnv>): void {
  registerEditLockRoutes(router, {
    kind: 'pages',
    basePath: '/pages',
    tag: 'Landing page edit lock',
    write: 'pages:write',
    read: 'pages:read',
    takeover: 'pages:publish',
    exists: (c, id) => callCrm(c, 'pages.get', { id }),
  });
}
