import {
  accountListQuerySchema,
  bulkImportAccountsRequestSchema,
  createAccountRequestSchema,
  updateAccountRequestSchema,
  type Account,
} from '@firemail/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { badRequest, notFound, parseOrThrow, upstreamError } from '../http/errors.ts';
import { idParam, pageOf } from '../http/params.ts';
import { ok, paginateArray } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

/** 设备码授权会打到微软，限流比普通接口紧：一个账号同时也只该有一个流程。 */
const REAUTH_RATE_LIMIT = { max: 5, timeWindow: '1 minute' };
/** 「测试连接」的硬时限。provider 自身也有超时，这里是不让 HTTP 请求被拖住的第二道闸。 */
const VERIFY_TIMEOUT_MS = 25_000;

const syncEnabledSchema = z.object({ enabled: z.boolean() });

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth };

  app.get('/accounts', guard, async (request) => {
    const auth = requireContext(request);
    const query = parseOrThrow(accountListQuerySchema, request.query ?? {});
    const accounts = ctx.accounts.list(auth.user.id, query);
    return ok(paginateArray(withSignatures(ctx, accounts), pageOf(request)));
  });

  app.post('/accounts', guard, async (request, reply) => {
    const auth = requireContext(request);
    const body = parseOrThrow(createAccountRequestSchema, request.body);
    const account = ctx.accounts.create(auth.user.id, body);
    if (body.signatureHtml !== undefined) {
      ctx.settings.setSignature(account.id, body.signatureHtml);
    }
    return reply.code(201).send(ok(withSignature(ctx, account)));
  });

  app.post('/accounts/import', guard, async (request, reply) => {
    const auth = requireContext(request);
    const body = parseOrThrow(bulkImportAccountsRequestSchema, request.body);
    return reply.code(201).send(ok(ctx.accounts.bulkImport(auth.user.id, body)));
  });

  app.get('/accounts/:id', guard, async (request) => {
    return ok(withSignature(ctx, requireAccount(ctx, request)));
  });

  app.patch('/accounts/:id', guard, async (request) => {
    const auth = requireContext(request);
    const id = requireAccount(ctx, request).id;
    const body = parseOrThrow(updateAccountRequestSchema, request.body);

    const account = ctx.accounts.update(auth.user.id, id, body);
    if (body.signatureHtml !== undefined) ctx.settings.setSignature(id, body.signatureHtml);
    return ok(withSignature(ctx, account));
  });

  app.delete('/accounts/:id', guard, async (request) => {
    const auth = requireContext(request);
    const id = requireAccount(ctx, request).id;
    ctx.accounts.remove(auth.user.id, id);
    ctx.settings.setSignature(id, null);
    return ok({});
  });

  app.put('/accounts/:id/sync-enabled', guard, async (request) => {
    const auth = requireContext(request);
    const id = requireAccount(ctx, request).id;
    const { enabled } = parseOrThrow(syncEnabledSchema, request.body);
    return ok(withSignature(ctx, ctx.accounts.update(auth.user.id, id, { syncEnabled: enabled })));
  });

  /**
   * 立即同步。**不等结果**：一次同步可能跑几分钟，旧版本让 HTTP 请求阻塞在
   * `future.result(timeout=300)` 上，而前端的 axios 超时是 10 秒——
   * 用户永远看到超时，同步其实在跑。这里改成 202 + SSE 推进度。
   */
  app.post('/accounts/:id/sync', guard, async (request, reply) => {
    const account = requireAccount(ctx, request);
    const row = ctx.accounts.getRow(account.id);
    if (!row) throw notFound(`账号 ${account.id} 不存在`);
    if (ctx.runner.isSyncing(account.id)) {
      return reply.code(202).send(ok({ accountId: account.id, status: 'already_running' }));
    }

    void ctx.runner
      .run(row)
      .catch((error: unknown) => request.log.error({ err: error }, '手动同步失败'));

    return reply.code(202).send(ok({ accountId: account.id, status: 'started' }));
  });

  app.post('/accounts/:id/test', guard, async (request) => {
    const account = requireAccount(ctx, request);
    const row = ctx.accounts.getRow(account.id);
    if (!row) throw notFound(`账号 ${account.id} 不存在`);

    const provider = ctx.providers.get(row.provider);
    return ok(await withDeadline(provider.verify(row), VERIFY_TIMEOUT_MS, '测试连接超时'));
  });

  registerReauthRoutes(app, ctx);
}

/**
 * 设备码重新授权。三个端点分别是「发起 / 查状态 / 取消」，
 * 轮询由前端做——把轮询放在服务端就又变成一个能挂 15 分钟的 HTTP 请求。
 */
function registerReauthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth, config: { rateLimit: REAUTH_RATE_LIMIT } };

  app.post('/accounts/:id/reauth', guard, async (request, reply) => {
    const account = requireAccount(ctx, request);
    if (account.authType !== 'oauth2') {
      throw badRequest('只有 OAuth 账号才需要重新授权');
    }

    const state = await withDeadline(
      ctx.deviceCode.start(account.id),
      VERIFY_TIMEOUT_MS,
      '发起设备码授权超时',
    );
    return reply.code(202).send(ok(state));
  });

  app.get('/accounts/:id/reauth', { preHandler: app.requireAuth }, async (request) => {
    const account = requireAccount(ctx, request);
    const state = ctx.deviceCode.get(account.id);
    if (!state) throw notFound('该账号没有进行中的授权流程');
    return ok(state);
  });

  app.delete('/accounts/:id/reauth', { preHandler: app.requireAuth }, async (request) => {
    const account = requireAccount(ctx, request);
    const cancelled = ctx.deviceCode.cancel(account.id);
    ctx.deviceCode.forget(account.id);
    return ok({ cancelled });
  });
}

/** 归属校验的唯一入口：所有 `/accounts/:id/*` 都必须先过这里。 */
export function requireAccount(ctx: AppContext, request: FastifyRequest): Account {
  const auth = requireContext(request);
  const id = idParam(request);
  const account = ctx.accounts.get(auth.user.id, id);
  if (!account) throw notFound(`账号 ${id} 不存在`);
  return account;
}

function withSignature(ctx: AppContext, account: Account): Account {
  return { ...account, signatureHtml: ctx.settings.signature(account.id) };
}

function withSignatures(ctx: AppContext, accounts: Account[]): Account[] {
  const signatures = ctx.settings.signatures(accounts.map((a) => a.id));
  return accounts.map((account) => ({
    ...account,
    signatureHtml: signatures.get(account.id) ?? null,
  }));
}

/** 有网络参与的操作必须有自己的时限，不能指望调用方断开连接就会释放资源。 */
async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(upstreamError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
