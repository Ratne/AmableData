import { editLockClientMessageSchema, type EditLockState } from '@amable/api-types';
import { DurableObject } from 'cloudflare:workers';
import { insertAudit } from '../auth/store';
import type { Env } from '../env';
import { EDIT_SESSION_HEADERS, EditLock, type LockSnapshot } from './lock';

interface Attachment {
  connId: string;
  userId: string;
  userName: string;
  canTakeover: boolean;
  tenantId: string;
  pageId: string;
}

const STORAGE_KEY = 'lock';

/**
 * Editing lock of one landing page (one instance per page, `<tenantId>:<pageId>`):
 * exclusive mode, FIFO waiters, heartbeat grace, forced takeover. Clients hold
 * a hibernatable WebSocket; the lock logic is the pure `EditLock`, persisted
 * after every change so it survives hibernation.
 */
export class EditSession extends DurableObject<Env> {
  private lock = new EditLock();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<LockSnapshot>(STORAGE_KEY);
      if (stored !== undefined) this.lock = new EditLock(stored);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const h = EDIT_SESSION_HEADERS;
    const userId = request.headers.get(h.userId);
    if (userId === null || userId === '') return new Response('missing identity', { status: 400 });
    const attachment: Attachment = {
      connId: crypto.randomUUID(),
      userId,
      userName: request.headers.get(h.userName) ?? '',
      canTakeover: request.headers.get(h.canTakeover) === '1',
      tenantId: request.headers.get(h.tenantId) ?? '',
      pageId: request.headers.get(h.pageId) ?? '',
    };
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    const now = Date.now();
    this.lock.expire(now);
    this.lock.join(attachment, now);
    await this.commit();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Draft saves are allowed to the holder, or to anyone while nobody is editing (API keys). */
  async canSave(userId: string): Promise<boolean> {
    if (this.lock.expire(Date.now())) await this.commit();
    return this.lock.holder === null || this.lock.holds(userId);
  }

  async status(userId: string): Promise<EditLockState> {
    if (this.lock.expire(Date.now())) await this.commit();
    return this.lock.stateFor(null, userId);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me === null || typeof message !== 'string' || message.length > 1000) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const msg = editLockClientMessageSchema.safeParse(parsed);
    if (!msg.success) return;
    const now = Date.now();
    const expired = this.lock.expire(now);
    if (msg.data.type === 'heartbeat') {
      // A socket that outlived its grace period (e.g. a sleeping laptop) queues again.
      const rejoined = !this.lock.isMember(me.connId) && this.lock.join(me, now);
      this.lock.heartbeat(me.connId, now);
      if (expired || rejoined) await this.commit();
      else await this.persist();
      return;
    }
    if (msg.data.type === 'release') {
      this.lock.leave(me.connId, now);
      await this.commit();
      return;
    }
    if (!me.canTakeover) {
      ws.send(JSON.stringify({ type: 'error', error: 'forbidden', message: 'takeover requires pages:publish' }));
      return;
    }
    const { changed, previous } = this.lock.takeover(me.connId, now);
    if (changed) {
      await insertAudit(this.env.DB, {
        tenantId: me.tenantId || null,
        actorUserId: me.userId,
        actorType: 'user',
        action: 'pages.lock_takeover',
        target: me.pageId || null,
        details: { previous_holder: previous?.userId ?? null },
        ip: null,
        now,
      }).catch((error: unknown) => console.error('[edit-session] audit failed', error));
    }
    await this.commit();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.drop(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.drop(ws);
  }

  override async alarm(): Promise<void> {
    this.lock.expire(Date.now());
    await this.commit();
  }

  private async drop(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me === null) return;
    this.lock.leave(me.connId, Date.now());
    await this.commit();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, this.lock.snapshot());
    const next = this.lock.nextExpiry();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** Persists and pushes the state to every connected client. */
  private async commit(): Promise<void> {
    await this.persist();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att === null) continue;
      try {
        ws.send(JSON.stringify(this.lock.stateFor(att.connId)));
      } catch {
        // closed socket: the runtime drops it
      }
    }
  }
}
