/**
 * HTTP 层的测试脚手架：真库 + 真 fastify + 假 IMAP，全程 `app.inject()`，不开监听端口。
 *
 * 不是 `.test.ts`，`node --test` 不会把它当用例收集；放在 src 下是为了和被测代码
 * 走同一套 TS 配置（noUncheckedIndexedAccess 等）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { AppConfig } from '../../config.ts';
import { SecretBox, generateKey } from '../../crypto/secretBox.ts';
import { createDb, openSqlite, type Db, type Sqlite } from '../../db/client.ts';
import { applyMigrations } from '../../db/migrate.ts';
import { accounts, folders, messages, users } from '../../db/schema.ts';
import { hashPassword } from '../../auth/passwordHash.ts';
import type { TransportFactory } from '../../services/send.ts';
import type { ImapConnect } from '../../sync/types.ts';
import { buildApp } from '../app.ts';
import { createContext, type AppContext } from '../context.ts';
import type { ImageProxyOptions } from '../imageProxy.ts';

const scratchDirs: string[] = [];

export function cleanupScratch(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface TestAppOptions {
  connect?: ImapConnect;
  /** 假 SMTP 通道；不给就走真实 provider（测试里不会真的连出去）。 */
  transport?: TransportFactory;
  imageProxy?: Omit<ImageProxyOptions, 'secret'>;
  config?: Partial<AppConfig>;
  /** 建一个 `<dataDir>/web/index.html`，用来验证 SPA 回退。 */
  withWebDist?: boolean;
  now?: () => number;
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  sqlite: Sqlite;
  dir: string;
  close(): Promise<void>;
}

export function testConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    isProduction: false,
    timeZone: 'UTC',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    dataDir: dir,
    dbPath: join(dir, 'test.db'),
    webDir: join(dir, 'web'),
    encryptionKey: undefined,
    corsOrigins: [],
    trustProxy: false,
    cookieSecure: 'auto',
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    syncConcurrency: 2,
    syncSchedulerEnabled: false,
    maxUploadBytes: 1024 * 1024,
    sseMaxPerUser: 3,
    shutdownTimeoutMs: 5000,
    ...overrides,
  };
}

export async function makeApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'firemail-http-'));
  scratchDirs.push(dir);

  const config = testConfig(dir, options.config ?? {});
  if (options.withWebDist) {
    mkdirSync(config.webDir, { recursive: true });
    writeFileSync(join(config.webDir, 'index.html'), '<!doctype html><title>FireMail</title>');
    writeFileSync(join(config.webDir, 'app.js'), 'console.log(1)');
  }

  const sqlite = openSqlite({ path: config.dbPath });
  applyMigrations(sqlite);
  const db = createDb(sqlite);

  const ctx = createContext({
    config,
    db,
    sqlite,
    box: new SecretBox(generateKey()),
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.imageProxy ? { imageProxy: options.imageProxy } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const app = await buildApp({ ctx, logger: false });

  return {
    app,
    ctx,
    db,
    sqlite,
    dir,
    close: async () => {
      ctx.hub.closeAll();
      await app.close();
      sqlite.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 用户与登录
// ---------------------------------------------------------------------------

export interface TestUser {
  id: number;
  username: string;
  password: string;
  isAdmin: boolean;
}

export function seedUser(
  db: Db,
  options: { username?: string; password?: string; isAdmin?: boolean } = {},
): TestUser {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'correct-horse';
  const row = db
    .insert(users)
    .values({
      username,
      passwordHash: hashPassword(password),
      isAdmin: options.isAdmin ?? true,
    })
    .returning()
    .get();
  return { id: row.id, username, password, isAdmin: row.isAdmin };
}

export interface Session {
  cookie: string;
  token: string;
  user: TestUser;
}

/** 走真正的登录接口拿 cookie；顺带验证 Set-Cookie 的属性。 */
export async function login(test: TestApp, user: TestUser): Promise<Session> {
  const response = await test.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: user.username, password: user.password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`登录失败: ${response.statusCode} ${response.body}`);
  }

  const cookie = response.cookies.find((c) => c.name === 'fm_session');
  if (!cookie) throw new Error('登录响应里没有会话 cookie');
  return { cookie: `fm_session=${cookie.value}`, token: cookie.value, user };
}

/** 带 cookie + Origin 的请求。Origin 必须给，否则被 CSRF 检查拒掉——这正是它的用途。 */
export function authed(
  test: TestApp,
  session: Session,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  return test.app.inject({
    ...options,
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost',
      ...options.headers,
    },
  });
}

export function bearer(
  test: TestApp,
  token: string,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  return test.app.inject({
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
}

export function body<T = Record<string, unknown>>(response: LightMyRequestResponse): T {
  return JSON.parse(response.body) as T;
}

export function data<T>(response: LightMyRequestResponse): T {
  const parsed = body<{ ok: boolean; data?: T; error?: unknown }>(response);
  if (parsed.ok !== true) {
    throw new Error(`期望成功响应，实际是 ${response.statusCode} ${response.body}`);
  }
  return parsed.data as T;
}

export function error(response: LightMyRequestResponse): { code: string; message: string; fields?: Record<string, string[]> } {
  const parsed = body<{ ok: boolean; error: { code: string; message: string; fields?: Record<string, string[]> } }>(
    response,
  );
  if (parsed.ok !== false) {
    throw new Error(`期望错误响应，实际是 ${response.statusCode} ${response.body}`);
  }
  return parsed.error;
}

// ---------------------------------------------------------------------------
// 邮箱数据
// ---------------------------------------------------------------------------

export interface SeedAccountOptions {
  email?: string;
  provider?: string;
  authType?: string;
  password?: string;
  refreshToken?: string;
  clientId?: string;
  status?: string;
  syncEnabled?: boolean;
}

export function seedAccount(
  test: TestApp,
  userId: number,
  options: SeedAccountOptions = {},
): number {
  const box = test.ctx.box;
  return test.db
    .insert(accounts)
    .values({
      userId,
      email: options.email ?? 'a@outlook.com',
      provider: options.provider ?? 'outlook',
      authType: options.authType ?? 'oauth2',
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      passwordEnc: options.password === undefined ? null : box.encrypt(options.password),
      oauthClientId: options.clientId ?? 'client-abc',
      oauthRefreshTokenEnc:
        options.refreshToken === undefined ? null : box.encrypt(options.refreshToken),
      status: options.status ?? 'active',
      syncEnabled: options.syncEnabled ?? true,
    })
    .returning()
    .get().id;
}

export function seedFolder(
  test: TestApp,
  accountId: number,
  path: string,
  specialUse: string | null = null,
  name?: string,
): number {
  return test.db
    .insert(folders)
    .values({ accountId, path, name: name ?? path, specialUse })
    .returning()
    .get().id;
}

export interface SeedMessageOptions {
  uid?: number;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  from?: string;
  receivedAt?: number;
  isRead?: boolean;
  isStarred?: boolean;
  isDeleted?: boolean;
  hasAttachments?: boolean;
  threadId?: string;
  messageId?: string;
}

let nextUid = 1000;

export function seedMessage(
  test: TestApp,
  accountId: number,
  folderId: number,
  options: SeedMessageOptions = {},
): number {
  return test.db
    .insert(messages)
    .values({
      accountId,
      folderId,
      uid: options.uid ?? nextUid++,
      subject: options.subject ?? '测试邮件',
      snippet: options.snippet ?? null,
      bodyText: options.bodyText ?? null,
      bodyHtml: options.bodyHtml ?? null,
      fromAddress: options.from ?? 'sender@example.com',
      fromName: null,
      receivedAt: new Date(options.receivedAt ?? Date.now()),
      isRead: options.isRead ?? false,
      isStarred: options.isStarred ?? false,
      isDeleted: options.isDeleted ?? false,
      hasAttachments: options.hasAttachments ?? false,
      threadId: options.threadId ?? null,
      messageId: options.messageId ?? null,
    })
    .returning()
    .get().id;
}
