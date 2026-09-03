import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { encodeLegacyPbkdf2 } from '../auth/passwordHash.ts';
import { createDb, openSqlite, type Db, type Sqlite } from '../db/client.ts';
import { applyMigrations } from '../db/migrate.ts';
import { users } from '../db/schema.ts';
import { SessionService } from './sessions.ts';
import { UserService, UserServiceError } from './users.ts';

/** 登录用户。重点在两处旧版本的安全缺口：改密码不吊销会话、明文口令。 */

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'staple-battery-horse';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

interface Ctx {
  db: Db;
  sqlite: Sqlite;
  sessions: SessionService;
  service: UserService;
}

let ctx: Ctx;

function setup(): Ctx {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);
  const sessions = new SessionService({ db, now: () => NOW });

  return {
    db,
    sqlite,
    sessions,
    service: new UserService({ db, sqlite, sessions, now: () => NOW }),
  };
}

const hashOf = (c: Ctx, id: number): string =>
  c.db.select().from(users).where(eq(users.id, id)).get()?.passwordHash ?? '';

beforeEach(() => {
  ctx = setup();
});

/* ---------------------------------------------------------------- 建号 */

test('第一个用户强制成为管理员，口令以 scrypt 哈希落库', () => {
  const user = ctx.service.create({ username: 'owner', password: PASSWORD, isAdmin: false });

  assert.equal(user.isAdmin, true, '否则这套系统没人管得了');
  assert.equal(ctx.service.count(), 1);

  const stored = hashOf(ctx, user.id);
  assert.match(stored, /^scrypt\$32768,8,1\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(stored.includes(PASSWORD), false, '绝不存明文');
});

test('之后的用户默认不是管理员；用户视图不含口令哈希', () => {
  ctx.service.create({ username: 'owner', password: PASSWORD });
  const second = ctx.service.create({ username: 'second', password: PASSWORD });

  assert.equal(second.isAdmin, false);
  assert.equal(Object.hasOwn(second, 'passwordHash'), false);
  assert.equal(JSON.stringify(ctx.service.list()).includes('passwordHash'), false);
});

test('用户名重复报 conflict；非法用户名/口令报 bad_request', () => {
  ctx.service.create({ username: 'owner', password: PASSWORD });

  assert.throws(
    () => ctx.service.create({ username: 'owner', password: PASSWORD }),
    (e: unknown) => e instanceof UserServiceError && e.code === 'conflict',
  );
  for (const bad of [{ username: 'ab', password: PASSWORD }, { username: 'has space', password: PASSWORD }, { username: 'fine', password: 'short' }]) {
    assert.throws(
      () => ctx.service.create(bad),
      (e: unknown) => e instanceof UserServiceError && e.code === 'bad_request',
    );
  }
});

test('自助注册：第一个用户永远放行，之后受开关控制', () => {
  assert.doesNotThrow(() => ctx.service.register({ username: 'first', password: PASSWORD }));

  assert.equal(ctx.service.isRegistrationAllowed(), false, '默认关闭');
  assert.throws(
    () => ctx.service.register({ username: 'second', password: PASSWORD }),
    (e: unknown) => e instanceof UserServiceError && e.code === 'forbidden',
  );

  ctx.service.setRegistrationAllowed(true);
  assert.doesNotThrow(() => ctx.service.register({ username: 'second', password: PASSWORD }));

  ctx.service.setRegistrationAllowed(false);
  assert.throws(() => ctx.service.register({ username: 'third', password: PASSWORD }), UserServiceError);
});

/* ---------------------------------------------------------------- 登录 */

test('登录成功刷新 lastLoginAt；口令错与用户不存在都返回 null', () => {
  const user = ctx.service.create({ username: 'owner', password: PASSWORD });

  const ok = ctx.service.authenticate('owner', PASSWORD);
  assert.equal(ok?.id, user.id);
  assert.equal(ok?.lastLoginAt, NOW);

  assert.equal(ctx.service.authenticate('owner', 'wrong-password'), null);
  assert.equal(ctx.service.authenticate('ghost', PASSWORD), null, '不区分"用户不存在"和"口令错"');
  assert.equal(ctx.service.authenticate('  owner  ', PASSWORD)?.id, user.id, '用户名两端空白被忽略');
});

test('旧库的 PBKDF2 口令仍能登录，并在登录成功后升级为 scrypt', () => {
  const user = ctx.service.create({ username: 'legacy', password: PASSWORD });

  // 复刻旧 Python：salt 是那串十六进制**文本**的 UTF-8 字节
  const saltText = randomBytes(16).toString('hex');
  const legacyHash = pbkdf2Sync(PASSWORD, Buffer.from(saltText, 'utf8'), 100_000, 32, 'sha256').toString('hex');
  ctx.db
    .update(users)
    .set({ passwordHash: encodeLegacyPbkdf2(saltText, legacyHash) })
    .where(eq(users.id, user.id))
    .run();

  assert.notEqual(ctx.service.authenticate('legacy', PASSWORD), null);
  assert.match(hashOf(ctx, user.id), /^scrypt\$/, '登录成功后无感升级');
  assert.notEqual(ctx.service.authenticate('legacy', PASSWORD), null, '升级后仍能登录');
});

test('口令哈希格式损坏时按登录失败处理，不把内部错误抛给调用方', () => {
  const user = ctx.service.create({ username: 'broken', password: PASSWORD });
  ctx.db.update(users).set({ passwordHash: 'garbage' }).where(eq(users.id, user.id)).run();

  assert.equal(ctx.service.authenticate('broken', PASSWORD), null);
});

/* ---------------------------------------------------------------- 改口令与会话 */

test('改口令后其他设备的会话全部失效，当前会话可以保留', () => {
  const user = ctx.service.create({ username: 'owner', password: PASSWORD });
  const current = ctx.sessions.create(user.id);
  const phone = ctx.sessions.create(user.id);
  const laptop = ctx.sessions.create(user.id);

  ctx.service.changePassword(user.id, PASSWORD, NEW_PASSWORD, { keepSessionId: current.session.id });

  assert.notEqual(ctx.sessions.verify(current.token), null, '发起改密码的这台设备不该被踢');
  assert.equal(ctx.sessions.verify(phone.token), null);
  assert.equal(ctx.sessions.verify(laptop.token), null);

  assert.equal(ctx.service.authenticate('owner', PASSWORD), null, '旧口令立刻作废');
  assert.notEqual(ctx.service.authenticate('owner', NEW_PASSWORD), null);
});

test('不给 keepSessionId 时改口令会踢掉全部会话', () => {
  const user = ctx.service.create({ username: 'owner', password: PASSWORD });
  const only = ctx.sessions.create(user.id);

  ctx.service.changePassword(user.id, PASSWORD, NEW_PASSWORD);
  assert.equal(ctx.sessions.verify(only.token), null);
});

test('当前口令不对时拒绝改密，且不动任何会话', () => {
  const user = ctx.service.create({ username: 'owner', password: PASSWORD });
  const session = ctx.sessions.create(user.id);

  assert.throws(
    () => ctx.service.changePassword(user.id, 'wrong-password', NEW_PASSWORD),
    (e: unknown) => e instanceof UserServiceError && e.code === 'unauthorized',
  );
  assert.notEqual(ctx.sessions.verify(session.token), null);
  assert.notEqual(ctx.service.authenticate('owner', PASSWORD), null);
});

test('新口令不合法时整个操作失败，旧口令仍然有效', () => {
  const user = ctx.service.create({ username: 'owner', password: PASSWORD });

  assert.throws(() => ctx.service.changePassword(user.id, PASSWORD, 'short'), UserServiceError);
  assert.notEqual(ctx.service.authenticate('owner', PASSWORD), null);
});

test('管理员重置他人口令：不需要旧口令，该用户全部会话作废', () => {
  ctx.service.create({ username: 'admin', password: PASSWORD });
  const victim = ctx.service.create({ username: 'victim', password: PASSWORD });
  const session = ctx.sessions.create(victim.id);

  ctx.service.resetPassword(victim.id, NEW_PASSWORD);

  assert.equal(ctx.sessions.verify(session.token), null);
  assert.notEqual(ctx.service.authenticate('victim', NEW_PASSWORD), null);
  assert.throws(() => ctx.service.resetPassword(999, NEW_PASSWORD), UserServiceError);
});

test('改口令 / 重置口令对不存在的用户报 not_found', () => {
  assert.throws(
    () => ctx.service.changePassword(999, PASSWORD, NEW_PASSWORD),
    (e: unknown) => e instanceof UserServiceError && e.code === 'not_found',
  );
});

/* ---------------------------------------------------------------- 管理员 */

test('不能取消最后一个管理员，也不能删掉最后一个管理员', () => {
  const admin = ctx.service.create({ username: 'admin', password: PASSWORD });
  const member = ctx.service.create({ username: 'member', password: PASSWORD });

  assert.throws(
    () => ctx.service.setAdmin(admin.id, false),
    (e: unknown) => e instanceof UserServiceError && e.code === 'forbidden',
  );
  assert.throws(() => ctx.service.remove(admin.id), UserServiceError);

  // 有第二个管理员之后就可以了
  assert.equal(ctx.service.setAdmin(member.id, true).isAdmin, true);
  assert.equal(ctx.service.setAdmin(admin.id, false).isAdmin, false);
  assert.doesNotThrow(() => ctx.service.remove(admin.id));
  assert.equal(ctx.service.get(admin.id), null);
});

test('查询接口：get / getByUsername / count 的空结果', () => {
  assert.equal(ctx.service.count(), 0);
  assert.equal(ctx.service.get(1), null);
  assert.equal(ctx.service.getByUsername('nobody'), null);

  const user = ctx.service.create({ username: 'owner', password: PASSWORD });
  assert.equal(ctx.service.getByUsername('owner')?.id, user.id);
  assert.equal(ctx.service.count(), 1);
  assert.throws(() => ctx.service.setAdmin(999, true), UserServiceError);
  assert.throws(() => ctx.service.remove(999), UserServiceError);
});
