import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { loadOrCreateKey, KeyStoreError } from '../../../apps/server/src/crypto/keyStore.ts';
import { SecretBoxError } from '../../../apps/server/src/crypto/secretBox.ts';
import { MigrationError } from '../../../apps/server/src/db/migrate.ts';
import { LegacySourceError } from './legacy.ts';
import { MigrationAbort, runMigration } from './run.ts';
import { formatReport, verifyMigrationFiles } from './verify.ts';

const USAGE = `花火邮箱 v1 → v2 数据迁移

用法:
  node --experimental-strip-types tools/migrate-legacy/src/cli.ts --from <old.db> --to <new.db> [选项]

选项:
  --from <path>      旧库 huohuo_email.db（只读打开）
  --to <path>        新库路径，不存在会自动建并跑迁移
  --data-dir <path>  数据目录，放 .encryption-key 和 attachments/（默认取 --to 所在目录）
  --dry-run          全程走一遍并回滚，只报告不落库
  --verify-only      不写入，只对已迁移的新库做校验
  -h, --help         显示本帮助

退出码: 0 成功 / 1 校验不通过 / 2 参数或 IO 错误

注意: 旧应用大约每 60 秒轮换一次 refresh_token。--verify-only 必须对着
      当初迁移用的那个快照跑，对着还在写的生产库跑会因为令牌轮换而误报。`;

export async function main(argv: string[]): Promise<number> {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        'data-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'verify-only': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`参数错误: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.from || !options.to) {
    console.error(`必须同时提供 --from 与 --to\n\n${USAGE}`);
    return 2;
  }

  const fromPath = resolve(options.from);
  const toPath = resolve(options.to);
  const dataDir = resolve(options['data-dir'] ?? dirname(toPath));
  const verifyOnly = options['verify-only'];

  // 先确认源库存在，免得为一次注定失败的运行生成并留下一把没用的密钥
  if (!existsSync(fromPath)) {
    console.error(`失败: 源数据库不存在: ${fromPath}`);
    return 2;
  }

  try {
    // 校验模式绝不生成新密钥：拿一把新钥匙去校验，只会把 29 个账号全判成失败
    const { key, source, fingerprint } = loadOrCreateKey({
      dataDir,
      allowGenerate: !verifyOnly,
      log: (m) => console.warn(m),
    });
    console.log(`加密密钥来源: ${source}，指纹 ${fingerprint}`);

    if (!verifyOnly) {
      const result = runMigration({
        fromPath,
        toPath,
        dataDir,
        key,
        dryRun: options['dry-run'],
        log: (m) => console.log(m),
      });
      console.log(
        `迁移统计: ${JSON.stringify(result.stats)}${result.alreadyMigrated ? '（复用已有迁移）' : ''}`,
      );
      if (result.stats.unparsedTimestamps > 0) {
        console.warn(`警告: ${result.stats.unparsedTimestamps} 个时间戳无法解析，已置空`);
      }
      if (result.dryRun) {
        console.log('--dry-run 结束，未写入任何数据，跳过校验。');
        return 0;
      }
    }

    const report = verifyMigrationFiles({ fromPath, toPath, dataDir, key });
    console.log(formatReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    if (isExpected(error)) {
      console.error(`失败: ${(error as Error).message}`);
      return 2;
    }
    console.error(error);
    return 2;
  }
}

/** 预期内的错误只打一行人话，不刷栈；其余错误保留完整栈便于排障。 */
function isExpected(error: unknown): boolean {
  return (
    error instanceof KeyStoreError ||
    error instanceof MigrationAbort ||
    error instanceof LegacySourceError ||
    error instanceof MigrationError ||
    error instanceof SecretBoxError
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
