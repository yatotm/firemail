import type { FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { bootstrapDatabase, KeyMismatchError } from './db/bootstrap.ts';
import { buildApp } from './http/app.ts';
import { createContext, type AppContext } from './http/context.ts';
import type { SyncLogger } from './sync/types.ts';

/**
 * 进程入口。
 *
 * 启动顺序不能换：配置 → 数据库（迁移 + 密钥指纹核对）→ 服务装配 → HTTP → 定时同步。
 * 密钥不匹配时 `bootstrapDatabase` 会直接抛错——总好过应用跑起来、
 * 29 个账号却在后台悄悄全部认证失败。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // TZ 必须在任何 Date 格式化之前生效
  if (config.timeZone) process.env['TZ'] = config.timeZone;

  const bootstrapped = bootstrapDatabase({
    dataDir: config.dataDir,
    dbPath: config.dbPath,
  });

  // 日志先于服务建立：同步引擎与 HTTP 必须写同一条流，
  // 否则后台同步的报错只会消失在 stdout 之外
  const logger = pino({ level: config.logLevel });
  const ctx = createContext({
    config,
    db: bootstrapped.db,
    sqlite: bootstrapped.sqlite,
    box: bootstrapped.box,
    log: toSyncLogger(logger),
  });

  const app = await buildApp({ ctx, startedAt: Date.now(), loggerInstance: logger });

  installShutdown(app, ctx, config, () => bootstrapped.sqlite.close());

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      dbPath: bootstrapped.dbPath,
      dataDir: bootstrapped.dataDir,
      keySource: bootstrapped.key.source,
      migrations: bootstrapped.migrations.applied.length,
    },
    'FireMail 已启动',
  );

  if (config.syncSchedulerEnabled) {
    ctx.scheduler.start();
    app.log.info(
      {
        // 后台基线是串行的，concurrency 只管用户发起的批量 / 单账号同步
        background: { serial: true, gapMs: config.syncGapMs, budgetMs: config.syncAccountBudgetMs },
        userInitiatedConcurrency: config.syncConcurrency,
        maxAttempts: config.syncMaxAttempts,
        suspend: {
          afterRounds: config.syncSuspendAfterRounds,
          enforce: config.syncSuspendEnforce,
        },
      },
      '三层同步调度已启动',
    );
  } else {
    app.log.warn('周期同步被 FIREMAIL_SYNC_SCHEDULER=false 关闭');
  }
}

/**
 * 优雅停机：拒收新发信 → 关掉 SSE 长连接 → 停止接受新连接、停表、等在跑的同步与发信 → 关库。
 *
 * SSE 必须先关：那是永不结束的响应，`app.close()` 会一直等它，最后被 deadline 强杀。
 * 同步与发信共用一个有限的宽限期，超时就走人——同步正在写的那一封会在下一轮重来，
 * 而拖着不退出会被编排系统 SIGKILL，那才真的可能写坏。
 *
 * 发信必须**先关门再等**：`POST /messages/send` 是 202 + 后台跑 SMTP，
 * 停机期间再受理一封就等于承诺了一件没人会兑现的事。
 */
function installShutdown(
  app: FastifyInstance,
  ctx: AppContext,
  config: AppConfig,
  closeDb: () => void,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, '收到停机信号，开始收尾');

    const deadline = setTimeout(() => {
      app.log.error({ timeoutMs: config.shutdownTimeoutMs }, '收尾超时，强制退出');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();

    try {
      ctx.send.stopAccepting();
      ctx.hub.closeAll();
      ctx.tickets.clear();
      // 排空只拿走 80% 预算，剩下的留给关库与最后几行日志；没跑完的任务由 drain 自己记。
      // 不能给满：那样上面的 deadline 会先到，走的就是 exit(1) 强杀，日志也来不及写
      const drainMs = Math.floor(config.shutdownTimeoutMs * 0.8);
      await Promise.all([app.close(), ctx.scheduler.stop(), ctx.send.drain(drainMs)]);
    } catch (error) {
      app.log.error({ err: error }, '收尾过程中出错');
    } finally {
      clearTimeout(deadline);
      try {
        closeDb();
      } catch (error) {
        app.log.error({ err: error }, '关闭数据库失败');
      }
      process.exit(0);
    }
  };

  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('SIGINT', (signal) => void shutdown(signal));
}

/** pino 的 `(meta, message)` 与同步引擎的 `(message, meta)` 参数顺序相反，这里翻译一次。 */
function toSyncLogger(logger: Logger): SyncLogger {
  return {
    debug: (message, meta) => logger.debug(meta ?? {}, message),
    info: (message, meta) => logger.info(meta ?? {}, message),
    warn: (message, meta) => logger.warn(meta ?? {}, message),
    error: (message, meta) => logger.error(meta ?? {}, message),
  };
}

try {
  await main();
} catch (error) {
  // 启动期的错误没有 logger 可用，也不该被 JSON 日志格式吃掉换行
  if (error instanceof ConfigError || error instanceof KeyMismatchError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`启动失败: ${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
}
