import { z } from '@hono/zod-openapi';
import { customFieldEntityPathSchema, idSchema } from '@amable/api-types';

export const entityParam = z.object({ entity: customFieldEntityPathSchema });

export const entityIdParam = z.object({ entity: customFieldEntityPathSchema, id: idSchema });
