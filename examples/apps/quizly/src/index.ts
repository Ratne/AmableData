import { createWorker, type Env } from './app';

const worker = createWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, (task) => ctx.waitUntil(task)),
};
