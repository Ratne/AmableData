import { createWorker, type Env } from './app';

const worker = createWorker();

export default {
  fetch: (request: Request, env: Env) => worker.fetch(request, env),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(worker.scheduled(env)),
};
