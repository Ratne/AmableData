import type {
  CreateFolderInput,
  MoveFolderItemsInput,
  UpdateFolderInput,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import * as library from './library';
import * as pages from './pages';

/**
 * Landing page operations of the TenantDb (merged into `crmOps`). Synchronous,
 * one transaction per call: R2 writes, the edit lock DO and rendering run in
 * the worker around them (see api.ts, gateway.ts).
 */
export const pagesOps = {
  'pages.list': pages.listPages,
  'pages.get': pages.getPage,
  'pages.create': pages.createPage,
  'pages.update': pages.updatePage,
  'pages.delete': pages.deletePage,
  'pages.restore': pages.restorePage,
  'pages.duplicate': pages.duplicatePage,
  'pages.saveDraft': pages.saveDraft,
  'pages.publish': pages.publishPage,
  'pages.unpublish': pages.unpublishPage,
  'pages.versions': pages.listVersions,
  'pages.restoreVersion': pages.restoreVersion,
  'pages.resolve': pages.resolvePage,
  'pages.sitemap': pages.sitemapPages,
  // saved sections
  'pages.listSavedSections': library.listSavedSections,
  'pages.createSavedSection': library.createSavedSection,
  'pages.updateSavedSection': library.updateSavedSection,
  'pages.deleteSavedSection': library.deleteSavedSection,
  // media
  'pages.listMedia': library.listMedia,
  'pages.createMedia': library.createMedia,
  'pages.getMedia': library.getMedia,
  'pages.mediaByFile': library.mediaByFile,
  'pages.deleteMedia': library.deleteMedia,
  // folders
  'pages.folders.list': (ctx: CrmContext, _input: Record<string, never>) => pages.pageFolders(ctx).tree(),
  'pages.folders.get': (ctx: CrmContext, input: { id: string }) => pages.pageFolders(ctx).get(input),
  'pages.folders.create': (ctx: CrmContext, input: CreateFolderInput) => pages.pageFolders(ctx).create(input),
  'pages.folders.update': (ctx: CrmContext, input: { id: string; data: UpdateFolderInput }) =>
    pages.pageFolders(ctx).update(input),
  'pages.folders.delete': (ctx: CrmContext, input: { id: string; mode: 'empty' | 'move_to_parent' }) =>
    pages.pageFolders(ctx).delete(input),
  'pages.folders.moveItems': (ctx: CrmContext, input: MoveFolderItemsInput) =>
    pages.pageFolders(ctx).moveItems(input),
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
