import {
  CREDENTIAL_EXPORT_COUNT_HEADER,
  CREDENTIAL_EXPORT_SKIPPED_HEADER,
  exportCredentialsRequestSchema,
  revealAccountPasswordRequestSchema,
} from '@firemail/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { contentDisposition } from '../http/contentDisposition.ts';
import type { AppContext } from '../http/context.ts';
import { HttpError, notFound, parseOrThrow } from '../http/errors.ts';
import { ok } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';
import { CredentialService } from '../services/credentials.ts';

/**
 * 明文凭据的两个出口。**这两个处理器不写任何日志**：不打请求体、不打响应、
 * 连"某某账号的密码被查看了"这种前缀都不打 —— 一旦养成习惯，迟早会有人顺手把值也带上。
 * fastify 默认只记 method/url/status，body 与响应本来就不进日志流。
 *
 * 归属与权限：
 *  - 显示密码 —— 登录用户，本人或管理员，别人的账号一律 404；
 *  - 全量导出 —— 仅管理员，且必须带显式确认。
 * 两个都有独立限流，比全局的 600/min 紧得多。
 */

/** 密码是一次一个地查的；一分钟点 5 次已经不像人在用了。 */
const REVEAL_RATE_LIMIT = { max: 5, timeWindow: '1 minute' };
/** 全量导出是备份动作，一小时几次绰绰有余；额度留了点余量给"点错了再来一次"。 */
const EXPORT_RATE_LIMIT = { max: 5, timeWindow: '1 hour' };

export function registerCredentialRoutes(app: FastifyInstance, ctx: AppContext): void {
  const credentials = new CredentialService({ db: ctx.db, box: ctx.box });

  app.post(
    '/credentials/reveal',
    { preHandler: app.requireAuth, config: { rateLimit: REVEAL_RATE_LIMIT } },
    async (request, reply) => {
      const auth = requireContext(request);
      const { accountId } = parseOrThrow(revealAccountPasswordRequestSchema, request.body);

      const outcome = credentials.revealPassword(accountId, {
        userId: auth.user.id,
        isAdmin: auth.user.isAdmin,
      });
      if (!outcome.ok) throw revealError(outcome.reason, accountId);

      return noStore(reply).send(ok(outcome.revealed));
    },
  );

  app.post(
    '/credentials/export',
    { preHandler: app.requireAdmin, config: { rateLimit: EXPORT_RATE_LIMIT } },
    async (request, reply) => {
      parseOrThrow(exportCredentialsRequestSchema, request.body ?? {});
      const result = credentials.exportAll();

      // 文件下载而不是 JSON：明文凭据不该被渲染进页面，也不该进任何一层前端状态
      return noStore(reply)
        .header('content-type', 'text/plain; charset=utf-8')
        .header(
          'content-disposition',
          contentDisposition({
            type: 'attachment',
            filename: exportFilename(Date.now()),
            fallback: 'firemail-credentials.txt',
          }),
        )
        .header(CREDENTIAL_EXPORT_COUNT_HEADER, String(result.exported))
        .header(CREDENTIAL_EXPORT_SKIPPED_HEADER, String(result.skipped.length))
        .send(result.text);
    },
  );
}

/** 明文凭据一律不可缓存，也不许被嗅探成别的类型。 */
function noStore(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .header('x-content-type-options', 'nosniff');
}

function revealError(reason: 'not_found' | 'no_password' | 'decrypt_failed', accountId: number) {
  if (reason === 'no_password') return notFound('该账号没有保存密码');
  if (reason === 'decrypt_failed') {
    return new HttpError('internal_error', '凭据解密失败，加密密钥可能与库里的密文不匹配');
  }
  return notFound(`账号 ${accountId} 不存在`);
}

/** `firemail-credentials-2026-09-04T02-30-00Z.txt`，只用 ASCII，冒号也去掉（Windows 文件名不收）。 */
function exportFilename(at: number): string {
  const stamp = new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `firemail-credentials-${stamp}.txt`;
}
