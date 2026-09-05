import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupScratch, makeDb } from '../sync/__testkit__/index.ts';
import { LogStore } from './store.ts';

after(cleanupScratch);

let clock = 1_800_000_000_000;

function store(options: { maxMb?: number; level?: 'debug' | 'info' | 'warn' | 'error' } = {}) {
  const db = makeDb();
  const log = new LogStore({ sqlite: db.sqlite, now: () => clock });
  if (options.maxMb !== undefined || options.level !== undefined) {
    log.setConfig({
      ...(options.maxMb === undefined ? {} : { maxMb: options.maxMb }),
      ...(options.level === undefined ? {} : { level: options.level }),
    });
  }
  return { log, close: db.close };
}

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 30, time: clock, pid: 1, hostname: 'h', ...fields });
}

// ---------------------------------------------------------------------------
// 写入与解析
// ---------------------------------------------------------------------------

test('把 pino 的一行拆成级别、正文与 meta', () => {
  const { log, close } = store();
  log.ingest(line({ level: 40, msg: '账号同步失败', accountId: 7, attempts: 3 }));

  const [entry] = log.query({ limit: 10 }).entries;
  assert.equal(entry?.level, 'warn');
  assert.equal(entry?.message, '账号同步失败');
  assert.equal(entry?.accountId, 7);
  assert.deepEqual(entry?.meta, { accountId: 7, attempts: 3 });
  close();
});

test('pid / hostname / time 这些每行都有的字段不进 meta', () => {
  const { log, close } = store();
  log.ingest(line({ msg: '一条日志' }));
  assert.equal(log.query({ limit: 10 }).entries[0]?.meta, null);
  close();
});

test('坏 JSON、空正文都直接丢掉，不抛错', () => {
  const { log, close } = store();
  log.ingest('这不是 JSON');
  log.ingest(line({ msg: '' }));
  log.ingest('{"level":30}');
  assert.equal(log.query({ limit: 10 }).entries.length, 0);
  close();
});

test('writable() 一次写进多行也能全部收下，并且绝不向上抛', () => {
  const { log, close } = store();
  const sink = log.writable();
  sink.write(`${line({ msg: '第一条' })}\n${line({ msg: '第二条' })}\n`);
  sink.write('半行坏数据{');
  assert.equal(log.query({ limit: 10 }).entries.length, 2);
  close();
});

// ---------------------------------------------------------------------------
// 详细程度
// ---------------------------------------------------------------------------

test('普通模式丢掉 debug 行，详细模式留下', () => {
  const { log, close } = store({ level: 'info' });
  log.ingest(line({ level: 20, msg: '一条 debug' }));
  assert.equal(log.query({ limit: 10 }).entries.length, 0);

  log.setConfig({ level: 'debug' });
  log.ingest(line({ level: 20, msg: '一条 debug' }));
  assert.equal(log.query({ limit: 10 }).entries.length, 1);
  close();
});

/**
 * HTTP 访问日志是条数最多的一类，而它对「后台同步为什么失败」毫无帮助。
 * 它是 info 级的，光靠级别门槛挡不住，所以单独归成「详细模式才留」。
 */
test('普通模式不记 HTTP 访问日志，否则同步的线索会被请求流水淹掉', () => {
  const { log, close } = store({ level: 'info' });
  log.ingest(line({ msg: 'incoming request', req: { method: 'GET', url: '/api/summary' } }));
  log.ingest(line({ msg: 'request completed', res: { statusCode: 200 } }));
  log.ingest(line({ msg: '账号 3 同步完成', accountId: 3 }));

  const entries = log.query({ limit: 10 }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.message, '账号 3 同步完成');

  log.setConfig({ level: 'debug' });
  log.ingest(line({ msg: 'incoming request', req: { method: 'GET', url: '/api/summary' } }));
  assert.equal(log.query({ limit: 10 }).entries.length, 2);
  close();
});

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

test('按级别过滤取的是「这一级及以上」', () => {
  const { log, close } = store();
  log.ingest(line({ level: 30, msg: 'info 的' }));
  log.ingest(line({ level: 40, msg: 'warn 的' }));
  log.ingest(line({ level: 50, msg: 'error 的' }));

  const warn = log.query({ level: 'warn', limit: 10 }).entries.map((e) => e.message);
  assert.deepEqual(warn, ['error 的', 'warn 的']);
  close();
});

test('搜索是正文的子串匹配', () => {
  const { log, close } = store();
  log.ingest(line({ msg: '账号 outlook 同步完成' }));
  log.ingest(line({ msg: '账号 gmail 同步完成' }));

  assert.deepEqual(
    log.query({ q: 'outlook', limit: 10 }).entries.map((e) => e.message),
    ['账号 outlook 同步完成'],
  );
  close();
});

test('搜索里的 % 和 _ 是字面量，不是通配符', () => {
  const { log, close } = store();
  log.ingest(line({ msg: '失败率 100% 的账号' }));
  log.ingest(line({ msg: '完全无关的一条' }));

  assert.equal(log.query({ q: '100%', limit: 10 }).entries.length, 1);
  assert.equal(log.query({ q: '%', limit: 10 }).entries.length, 1, '% 不该匹配所有行');
  close();
});

test('按日期区间取', () => {
  const { log, close } = store();
  const base = clock;
  for (const offset of [0, 60_000, 120_000]) {
    clock = base + offset;
    log.ingest(line({ msg: `第 ${String(offset / 60_000)} 分钟` }));
  }
  clock = base;

  const middle = log.query({ from: base + 30_000, to: base + 90_000, limit: 10 }).entries;
  assert.deepEqual(middle.map((e) => e.message), ['第 1 分钟']);
  close();
});

test('最新的排在最前，翻页用 before 往旧里走', () => {
  const { log, close } = store();
  for (let i = 1; i <= 5; i++) log.ingest(line({ msg: `第 ${String(i)} 条` }));

  const first = log.query({ limit: 2 });
  assert.deepEqual(first.entries.map((e) => e.message), ['第 5 条', '第 4 条']);
  assert.equal(first.hasMore, true);

  const next = log.query({ limit: 2, before: first.entries[1]?.id as number });
  assert.deepEqual(next.entries.map((e) => e.message), ['第 3 条', '第 2 条']);

  const last = log.query({ limit: 2, before: next.entries[1]?.id as number });
  assert.deepEqual(last.entries.map((e) => e.message), ['第 1 条']);
  assert.equal(last.hasMore, false);
  close();
});

test('after 只取更新的那些，实时追加靠它', () => {
  const { log, close } = store();
  log.ingest(line({ msg: '旧的' }));
  const cursor = log.query({ limit: 1 }).entries[0]?.id as number;

  log.ingest(line({ msg: '新的一' }));
  log.ingest(line({ msg: '新的二' }));

  assert.deepEqual(
    log.query({ after: cursor, limit: 10 }).entries.map((e) => e.message),
    ['新的二', '新的一'],
  );
  close();
});

// ---------------------------------------------------------------------------
// 容量上限与循环清理
// ---------------------------------------------------------------------------

test('超过上限从最旧的开始删，占用回落到水位线以下', () => {
  const { log, close } = store({ maxMb: 1 });
  const max = 1024 * 1024;
  const filler = 'x'.repeat(4096);

  for (let i = 0; i < 400; i++) log.ingest(line({ msg: `${String(i)} ${filler}` }));

  const status = log.status();
  assert.ok(status.bytes <= max, `占用 ${String(status.bytes)} 应当不超过上限 ${String(max)}`);
  assert.ok(status.count > 0, '不该被清空');

  // 删的是最旧的：最新那条必须还在
  const newest = log.query({ limit: 1 }).entries[0];
  assert.ok(newest?.message.startsWith('399 '), `最新的一条应当保留，实际是 ${String(newest?.message.slice(0, 12))}`);
  close();
});

test('调小上限当场生效，不用等下一条日志进来', () => {
  const { log, close } = store({ maxMb: 8 });
  const filler = 'x'.repeat(4096);
  for (let i = 0; i < 300; i++) log.ingest(line({ msg: `${String(i)} ${filler}` }));
  const before = log.status().bytes;

  log.setConfig({ maxMb: 1 });

  assert.ok(log.status().bytes < before);
  assert.ok(log.status().bytes <= 1024 * 1024);
  close();
});

test('上限小到装不下一条时也不会清空成 0 条', () => {
  const { log, close } = store({ maxMb: 1 });
  log.ingest(line({ msg: 'x'.repeat(20_000) }));
  log.setConfig({ maxMb: 1 });
  assert.ok(log.status().count >= 1);
  close();
});

test('清空之后占用归零', () => {
  const { log, close } = store();
  log.ingest(line({ msg: '一条' }));
  assert.ok(log.status().bytes > 0);

  log.clear();
  assert.equal(log.status().count, 0);
  assert.equal(log.status().bytes, 0);
  close();
});

test('配置存进库，重开一个 store 还在', () => {
  const db = makeDb();
  new LogStore({ sqlite: db.sqlite }).setConfig({ level: 'debug', maxMb: 64 });

  const reopened = new LogStore({ sqlite: db.sqlite });
  assert.deepEqual(reopened.config(), { level: 'debug', maxMb: 64 });
  db.close();
});

test('库里的配置坏掉也要能起来，退回默认值', () => {
  const db = makeDb();
  db.sqlite
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('firemail.logs.config', '{ 这不是 JSON', Date.now());

  assert.deepEqual(new LogStore({ sqlite: db.sqlite }).config(), { level: 'info', maxMb: 32 });
  db.close();
});

test('重开时把已有的占用算回来，不会从 0 开始漏算', () => {
  const db = makeDb();
  const first = new LogStore({ sqlite: db.sqlite });
  first.ingest(line({ msg: '一条' }));
  const bytes = first.status().bytes;

  assert.equal(new LogStore({ sqlite: db.sqlite }).status().bytes, bytes);
  db.close();
});
