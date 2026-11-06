import { z } from '@hono/zod-openapi';

export const activeQuery = z.object({ active: z.enum(['true', 'false']).optional() });
