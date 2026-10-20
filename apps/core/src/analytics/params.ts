import { z } from '@hono/zod-openapi';

/** `?site_id=` of the routes scoped to one analytics site. */
export const siteQuery = z.object({ site_id: z.string().min(1).max(64) });
/** `/{id}` of a site-scoped resource. */
export const idParam = z.object({ id: z.string().min(1).max(64) });
/** `/sites/{siteId}` path parameter. */
export const siteIdPath = z.object({ siteId: z.string().min(1).max(64) });
