import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { notFound, toEnvelope } from '../http/errors.ts';

export const API_PREFIX = '/api';

/**
 * 前端静态资源 + SPA 回退。
 *
 * 关键约束：**回退不能吞掉 `/api/*`**。旧版本对任何未匹配的 GET 都返回 index.html，
 * 于是前端把一份 HTML 当 JSON 解析，报出来的错永远是「Unexpected token <」，
 * 真正的「路由不存在」被藏得死死的。
 *
 * `wildcard: false` 让 @fastify/static 在启动时按文件建路由，
 * 不注册 `/*` 通配路由，未命中的请求才会落到这里的 notFound 处理器。
 */
export async function registerStatic(app: FastifyInstance, webDir: string): Promise<void> {
  const hasIndex = existsSync(join(webDir, 'index.html'));

  if (hasIndex) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      index: ['index.html'],
      // 带内容哈希的资源可以长缓存；index.html 单独在回退里设 no-cache
      maxAge: '7d',
      immutable: true,
    });
  } else {
    app.log.warn({ webDir }, '未找到前端构建产物，仅提供 API');
  }

  app.setNotFoundHandler((request, reply) => {
    if (!hasIndex || isApiRequest(request.url) || !isDocumentRequest(request.method)) {
      return reply
        .code(404)
        .send(toEnvelope(notFound(`找不到 ${request.method} ${request.url.split('?')[0]}`)));
    }
    // SPA 的路由在客户端，任何前端路径都返回同一份 index.html。
    // index.html 绝不能长缓存，否则前端发版后老用户一直拿到旧的 asset 引用；
    // cacheControl: false 是必须的——否则 @fastify/static 会用注册时的 7d 覆盖这里
    return reply
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .sendFile('index.html', { cacheControl: false });
  });
}

function isApiRequest(url: string): boolean {
  return url === API_PREFIX || url.startsWith(`${API_PREFIX}/`) || url.startsWith(`${API_PREFIX}?`);
}

function isDocumentRequest(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}
