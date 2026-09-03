import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.ts';

/**
 * 配置必须快速失败。
 * 一个写错的 PORT 会让容器起来但端口不通，一个写错的 CORS 会让浏览器静默拒绝所有请求——
 * 两者都比启动时报错难查得多。
 */

test('全部缺省时给出可用的默认值', () => {
  const config = loadConfig({});

  assert.equal(config.port, 3000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.dataDir, resolve('data'));
  assert.equal(config.dbPath, resolve('data/firemail.db'));
  assert.deepEqual(config.corsOrigins, [], '默认不开 CORS');
  assert.equal(config.cookieSecure, 'auto');
  assert.equal(config.trustProxy, false);
  assert.equal(config.syncSchedulerEnabled, true);
  assert.equal(config.isProduction, false);
});

test('空字符串按「没设置」处理（compose 的 ${VAR:-} 会传空串）', () => {
  const config = loadConfig({
    FIREMAIL_ENCRYPTION_KEY: '',
    FIREMAIL_CORS_ORIGINS: '',
    TZ: '',
    PORT: '',
  });

  assert.equal(config.encryptionKey, undefined);
  assert.deepEqual(config.corsOrigins, []);
  assert.equal(config.timeZone, undefined);
  assert.equal(config.port, 3000);
});

test('DB 路径跟随数据目录，显式指定时优先', () => {
  assert.equal(loadConfig({ FIREMAIL_DATA_DIR: '/srv/data' }).dbPath, '/srv/data/firemail.db');
  assert.equal(
    loadConfig({ FIREMAIL_DATA_DIR: '/srv/data', FIREMAIL_DB_PATH: '/other/x.db' }).dbPath,
    '/other/x.db',
  );
});

test('端口非法时报错，且错误信息指出是哪个变量', () => {
  for (const port of ['0', '70000', 'abc', '3000.5', '-1']) {
    assert.throws(
      () => loadConfig({ PORT: port }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /PORT/);
        return true;
      },
      `PORT=${port}`,
    );
  }
});

test('CORS 明确拒绝通配来源', () => {
  assert.throws(
    () => loadConfig({ FIREMAIL_CORS_ORIGINS: '*' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /通配/);
      return true;
    },
  );

  for (const value of ['mail.example.com', 'https://mail.example.com/path', 'not a url']) {
    assert.throws(() => loadConfig({ FIREMAIL_CORS_ORIGINS: value }), ConfigError, value);
  }

  assert.deepEqual(
    loadConfig({ FIREMAIL_CORS_ORIGINS: 'https://a.example.com, http://localhost:5173' })
      .corsOrigins,
    ['https://a.example.com', 'http://localhost:5173'],
  );
});

test('加密密钥只接受 32 字节的 hex 或 base64', () => {
  const hex = 'a'.repeat(64);
  assert.equal(loadConfig({ FIREMAIL_ENCRYPTION_KEY: hex }).encryptionKey, hex);

  const base64 = Buffer.alloc(32, 7).toString('base64');
  assert.equal(loadConfig({ FIREMAIL_ENCRYPTION_KEY: base64 }).encryptionKey, base64);

  for (const bad of ['too-short', 'a'.repeat(63), '!!!!']) {
    assert.throws(() => loadConfig({ FIREMAIL_ENCRYPTION_KEY: bad }), ConfigError, bad);
  }
});

test('时区必须是合法的 IANA 名字', () => {
  assert.equal(loadConfig({ TZ: 'Asia/Shanghai' }).timeZone, 'Asia/Shanghai');
  assert.throws(() => loadConfig({ TZ: 'Mars/Olympus' }), ConfigError);
});

test('布尔型变量接受常见写法，其余报错', () => {
  assert.equal(loadConfig({ FIREMAIL_TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ FIREMAIL_TRUST_PROXY: '1' }).trustProxy, true);
  assert.equal(loadConfig({ FIREMAIL_TRUST_PROXY: 'off' }).trustProxy, false);
  assert.throws(() => loadConfig({ FIREMAIL_TRUST_PROXY: 'maybe' }), ConfigError);

  assert.equal(loadConfig({ FIREMAIL_COOKIE_SECURE: 'auto' }).cookieSecure, 'auto');
  assert.equal(loadConfig({ FIREMAIL_COOKIE_SECURE: 'true' }).cookieSecure, true);
  assert.throws(() => loadConfig({ FIREMAIL_COOKIE_SECURE: 'sometimes' }), ConfigError);
});

test('数值型变量有范围限制', () => {
  assert.equal(loadConfig({ FIREMAIL_SYNC_CONCURRENCY: '8' }).syncConcurrency, 8);
  assert.throws(() => loadConfig({ FIREMAIL_SYNC_CONCURRENCY: '0' }), ConfigError);
  assert.throws(() => loadConfig({ FIREMAIL_SYNC_CONCURRENCY: '999' }), ConfigError);

  assert.equal(loadConfig({ FIREMAIL_MAX_UPLOAD_MB: '10' }).maxUploadBytes, 10 * 1024 * 1024);
  assert.equal(loadConfig({ FIREMAIL_SESSION_TTL_DAYS: '7' }).sessionTtlMs, 7 * 86_400_000);
  assert.throws(() => loadConfig({ FIREMAIL_SESSION_TTL_DAYS: '0' }), ConfigError);
});

test('三层同步的旋钮：重试、间隔、预算、升级门槛', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.syncConcurrency, 2, '并发默认值来自生产 A/B 实测');
  assert.equal(defaults.syncMaxAttempts, 3);
  assert.equal(defaults.syncGapMs, 2_000);
  assert.equal(defaults.syncAccountBudgetMs, 90_000);
  assert.equal(defaults.syncSuspendAfterRounds, 8);
  assert.equal(defaults.syncSuspendEnforce, false, '自动暂停默认只观察不执行');

  assert.equal(loadConfig({ FIREMAIL_SYNC_MAX_ATTEMPTS: '1' }).syncMaxAttempts, 1);
  assert.throws(() => loadConfig({ FIREMAIL_SYNC_MAX_ATTEMPTS: '0' }), ConfigError);
  assert.throws(() => loadConfig({ FIREMAIL_SYNC_MAX_ATTEMPTS: '6' }), ConfigError);

  assert.equal(loadConfig({ FIREMAIL_SYNC_GAP_MS: '0' }).syncGapMs, 0);
  assert.equal(loadConfig({ FIREMAIL_SYNC_ACCOUNT_BUDGET_MS: '30000' }).syncAccountBudgetMs, 30_000);
  assert.throws(() => loadConfig({ FIREMAIL_SYNC_ACCOUNT_BUDGET_MS: '1000' }), ConfigError);

  assert.equal(loadConfig({ FIREMAIL_SYNC_SUSPEND_AFTER_ROUNDS: '3' }).syncSuspendAfterRounds, 3);
  assert.throws(
    () => loadConfig({ FIREMAIL_SYNC_SUSPEND_AFTER_ROUNDS: '1' }),
    ConfigError,
    '一轮失败不算「反复失败」，门槛最小是 2',
  );
  assert.equal(loadConfig({ FIREMAIL_SYNC_SUSPEND_ENFORCE: 'true' }).syncSuspendEnforce, true);
});

test('日志级别只接受 pino 认识的取值', () => {
  assert.equal(loadConfig({ LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), ConfigError);
});

test('一次报出所有问题，而不是改一个跑一次', () => {
  try {
    loadConfig({ PORT: 'abc', LOG_LEVEL: 'verbose', TZ: 'Nowhere/Here' });
    assert.fail('应该抛错');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /PORT/);
    assert.match(error.message, /LOG_LEVEL/);
    assert.match(error.message, /TZ/);
  }
});
