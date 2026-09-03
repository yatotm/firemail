import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDb, openSqlite, type Db } from '../db/client.ts';
import { applyMigrations } from '../db/migrate.ts';
import { sessions, users } from '../db/schema.ts';
import { SessionService, hashSessionToken } from './sessions.ts';

/**
 * 会话必须真的可吊销——旧版本的"登出"只是删了个 cookie，
 * 令牌本身直到过期为止一直有效，改密码也照样能用。
 */

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Ctx {
  db: Db;
  clock: { value: number };
  service: SessionService;
  rows: () => (typeof sessions.$inferSelect)[];
}

let ctx: Ctx;

function setup(options: { throttleMs?: number } = {}): Ctx {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);
  const clock = { value: NOW };

  db.insert(users)
    .values([
      { id: 1, username: 'owner', passwordHash: 'x' },
      { id: 2, username: 'other', passwordHash: 'x' },
    ])
    .run();

  return {
    db,
    clock,
    service: new SessionService({
      db,
      now: () => clock.value,
      ...(options.throttleMs === undefined ? {} : { lastUsedThrottleMs: options.throttleMs }),
    }),
    rows: () => db.select().from(sessions).all(),
  };
}

beforeEach(() => {
  ctx = setup();
});

test('令牌是高熵随机值，库里只存 sha256 哈希', () => {
  const { token, session } = ctx.service.create(1, { userAgent: 'curl/8', ip: '10.0.0.1' });

  // 32 字节 base64url = 43 个字符
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/);

  const row = ctx.rows()[0];
  assert.equal(row?.tokenHash, createHash('sha256').update(token).digest('hex'));
  assert.equal(row?.tokenHash.includes(token), false, '库里不能出现令牌本身');
  assert.equal(session.userAgent, 'curl/8');
  assert.equal(session.ip, '10.0.0.1');
  assert.equal(session.expiresAt, NOW + 30 * DAY);
});

test('每次创建的令牌都不同', () => {
  const tokens = new Set(Array.from({ length: 20 }, () => ctx.service.create(1).token));
  assert.equal(tokens.size, 20);
});

test('会话视图里没有 tokenHash', () => {
  const { session } = ctx.service.create(1);
  assert.equal(Object.hasOwn(session, 'tokenHash'), false);
  assert.deepEqual(
    Object.keys(session).sort(),
    ['createdAt', 'expiresAt', 'id', 'ip', 'lastUsedAt', 'userAgent', 'userId'],
  );
});

test('校验：有效令牌返回会话，未知令牌返回 null', () => {
  const { token, session } = ctx.service.create(1);

  assert.equal(ctx.service.verify(token)?.id, session.id);
  assert.equal(ctx.service.verify('definitely-not-a-token'), null);
  assert.equal(ctx.service.verify(''), null);
});

test('校验：过期会话返回 null 并顺手删掉', () => {
  const { token } = ctx.service.create(1, { ttlMs: 10 * MINUTE });

  ctx.clock.value = NOW + 10 * MINUTE - 1;
  assert.notEqual(ctx.service.verify(token), null, '还差 1ms 到期，仍然有效');

  ctx.clock.value = NOW + 10 * MINUTE;
  assert.equal(ctx.service.verify(token), null, '到期即失效');
  assert.equal(ctx.rows().length, 0, '过期行应被清理');
});

test('lastUsedAt 按节流窗口更新，避免每个请求都写库', () => {
  const c = setup({ throttleMs: 60_000 });
  const { token } = c.service.create(1);

  c.clock.value = NOW + 30_000;
  assert.equal(c.service.verify(token)?.lastUsedAt, NOW, '窗口内不更新');

  c.clock.value = NOW + 60_000;
  assert.equal(c.service.verify(token)?.lastUsedAt, NOW + 60_000);
  assert.equal(c.rows()[0]?.lastUsedAt?.getTime(), NOW + 60_000, '更新要落库');
});

test('吊销单个会话：按令牌、按 id，重复吊销返回 false', () => {
  const a = ctx.service.create(1);
  const b = ctx.service.create(1);

  assert.equal(ctx.service.revoke(a.token), true);
  assert.equal(ctx.service.verify(a.token), null, '登出后令牌立刻失效');
  assert.equal(ctx.service.revoke(a.token), false);

  assert.equal(ctx.service.revokeById(b.session.id), true);
  assert.equal(ctx.service.revokeById(b.session.id), false);
  assert.equal(ctx.rows().length, 0);
});

test('吊销全部：默认清空该用户所有会话，exceptId 保留当前这条', () => {
  const keep = ctx.service.create(1);
  ctx.service.create(1);
  ctx.service.create(1);
  const otherUser = ctx.service.create(2);

  assert.equal(ctx.service.revokeAllForUser(1, { exceptId: keep.session.id }), 2);
  assert.notEqual(ctx.service.verify(keep.token), null, '当前会话不该把自己踢下线');
  assert.notEqual(ctx.service.verify(otherUser.token), null, '别的用户不受影响');

  assert.equal(ctx.service.revokeAllForUser(1), 1);
  assert.equal(ctx.service.verify(keep.token), null);
  assert.equal(ctx.service.listForUser(1).length, 0);
  assert.equal(ctx.service.listForUser(2).length, 1);
});

test('listForUser 只列本人会话且不含令牌材料', () => {
  ctx.service.create(1, { userAgent: 'Firefox' });
  ctx.service.create(2);

  const list = ctx.service.listForUser(1);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.userAgent, 'Firefox');
  assert.equal(JSON.stringify(list).includes('tokenHash'), false);
});

test('purgeExpired 清掉所有到期会话，保留未到期的', () => {
  ctx.service.create(1, { ttlMs: 5 * MINUTE });
  const alive = ctx.service.create(1, { ttlMs: 60 * MINUTE });

  ctx.clock.value = NOW + 10 * MINUTE;
  assert.equal(ctx.service.purgeExpired(), 1);
  assert.equal(ctx.rows().length, 1);
  assert.notEqual(ctx.service.verify(alive.token), null);
});

test('删除用户会级联删掉他的会话', () => {
  const { token } = ctx.service.create(1);
  ctx.db.delete(users).where(eq(users.id, 1)).run();
  assert.equal(ctx.service.verify(token), null);
});

test('hashSessionToken 是稳定的单向映射', () => {
  assert.equal(hashSessionToken('abc'), hashSessionToken('abc'));
  assert.notEqual(hashSessionToken('abc'), hashSessionToken('abd'));
  assert.equal(hashSessionToken('abc').length, 64);
});
