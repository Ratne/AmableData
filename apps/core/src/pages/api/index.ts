import type { OpenAPIHono } from '@hono/zod-openapi';
import { callCrm } from '../../crm/api/core';
import { registerFolderRoutes } from '../../folders/routes';
import type { AppEnv } from '../../middleware';
import { registerPageRecordRoutes } from './pages';
import { registerExportImportRoutes } from './export-import';
import { registerDraftRoutes } from './draft';
import { registerPublishingRoutes } from './publishing';
import { registerPageLockRoutes } from './edit-lock';
import { registerSavedSectionsRoutes } from './saved-sections';
import { registerPersonalClipboardRoutes } from './personal-clipboard';
import { registerMediaRoutes } from './media';

/** Landing pages REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerPagesRoutes(router: OpenAPIHono<AppEnv>): void {
  registerFolderRoutes(router, {
    path: '/pageFolders',
    tag: 'Landing page folders',
    items: 'landing pages',
    read: 'pages:read',
    write: 'pages:write',
    backend: {
      list: (c) => callCrm(c, 'pages.folders.list', {}),
      get: (c, input) => callCrm(c, 'pages.folders.get', input),
      create: (c, input) => callCrm(c, 'pages.folders.create', input),
      update: (c, input) => callCrm(c, 'pages.folders.update', input),
      delete: (c, input) => callCrm(c, 'pages.folders.delete', input),
      moveItems: (c, input) => callCrm(c, 'pages.folders.moveItems', input),
    },
  });

  registerPageRecordRoutes(router);
  registerExportImportRoutes(router);
  registerDraftRoutes(router);
  registerPublishingRoutes(router);
  registerPageLockRoutes(router);
  registerSavedSectionsRoutes(router);
  registerPersonalClipboardRoutes(router);
  registerMediaRoutes(router);
}
