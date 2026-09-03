import {
  DeviceCodeService,
  MicrosoftOAuthClient,
  OAuthTokenService,
  OAuthTokenStore,
  OUTLOOK_DEVICE_CODE_SCOPE,
} from '../auth/oauth/index.ts';
import type { AppConfig } from '../config.ts';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db, Sqlite } from '../db/client.ts';
import { AccountCredentialResolver, createProviderRegistry, type ProviderRegistry } from '../providers/index.ts';
import { AccountService } from '../services/accounts.ts';
import { FolderService } from '../services/folders.ts';
import { MessageService } from '../services/messages.ts';
import { SearchService } from '../services/search.ts';
import { SendService, type TransportFactory } from '../services/send.ts';
import { SessionService } from '../services/sessions.ts';
import { UserService } from '../services/users.ts';
import { SseHub } from '../sse/hub.ts';
import { SseTicketStore } from '../sse/tickets.ts';
import { EventingSyncRunner } from '../sse/syncEvents.ts';
import { AttachmentFetcher } from '../storage/attachmentFetcher.ts';
import { AttachmentStore } from '../storage/attachmentStore.ts';
import { SyncScheduler } from '../sync/scheduler.ts';
import { connectVia, type ImapConnect, type SyncLogger } from '../sync/types.ts';
import { ImageProxy, loadImageProxySecret, type ImageProxyOptions } from './imageProxy.ts';
import { MessageQuery } from './messageQuery.ts';
import { SettingsStore } from './settingsStore.ts';
import { SummaryService } from './summary.ts';

/**
 * 组装根：所有服务在这里各建一份，之后靠参数传递，没有全局单例。
 * 测试注入自己的 `connect` / `oauthClient` 就能完全脱离网络。
 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  sqlite: Sqlite;
  box: SecretBox;

  sessions: SessionService;
  users: UserService;
  accounts: AccountService;
  folders: FolderService;
  messages: MessageService;
  messageQuery: MessageQuery;
  search: SearchService;
  summary: SummaryService;
  settings: SettingsStore;
  send: SendService;

  providers: ProviderRegistry;
  attachments: AttachmentFetcher;
  attachmentStore: AttachmentStore;
  imageProxy: ImageProxy;
  deviceCode: DeviceCodeService;

  runner: EventingSyncRunner;
  scheduler: SyncScheduler;
  hub: SseHub;
  tickets: SseTicketStore;

  readonly log: SyncLogger | undefined;
}

export interface ContextOptions {
  config: AppConfig;
  db: Db;
  sqlite: Sqlite;
  box: SecretBox;
  /** 不给就用 providers 注册表建真实 IMAP 连接。 */
  connect?: ImapConnect;
  oauthClient?: MicrosoftOAuthClient;
  /** 不给就用 providers 注册表建真实 SMTP 通道。测试注入假 transport 即可脱离网络。 */
  transport?: TransportFactory;
  /** 图片代理的调参，测试用来注入假 DNS 解析与放行本地地址。 */
  imageProxy?: Omit<ImageProxyOptions, 'secret'>;
  log?: SyncLogger;
  now?: () => number;
}

export function createContext(options: ContextOptions): AppContext {
  const { config, db, sqlite, box, log } = options;
  const now = options.now ?? Date.now;

  const sessions = new SessionService({ db, ttlMs: config.sessionTtlMs, now });
  const users = new UserService({ db, sqlite, sessions, now });
  const accounts = new AccountService({ db, box, now });
  const folders = new FolderService({ db });
  const settings = new SettingsStore({ sqlite, now });

  const oauthClient = options.oauthClient ?? new MicrosoftOAuthClient();
  const tokenStore = new OAuthTokenStore({ db, box });
  const tokens = new OAuthTokenService({ store: tokenStore, client: oauthClient, now });
  const deviceCode = new DeviceCodeService({
    store: tokenStore,
    client: oauthClient,
    scope: OUTLOOK_DEVICE_CODE_SCOPE,
    now,
  });

  const providers = createProviderRegistry({
    credentials: new AccountCredentialResolver({ box, tokens }),
  });
  const connect: ImapConnect = options.connect ?? connectVia((account) => providers.get(account.provider));

  const attachmentStore = new AttachmentStore({
    root: `${config.dataDir}/attachments`,
    maxBytes: config.maxUploadBytes,
  });
  const attachments = new AttachmentFetcher({
    db,
    store: attachmentStore,
    connect,
    ...(log ? { log } : {}),
  });

  const hub = new SseHub({
    maxPerUser: config.sseMaxPerUser,
    ...(log ? { log } : {}),
  });
  const tickets = new SseTicketStore({ now });

  const runner = new EventingSyncRunner(
    { db, sqlite, connect, ...(log ? { log } : {}) },
    hub,
    { concurrency: config.syncConcurrency },
  );
  const scheduler = new SyncScheduler(
    { db, runner },
    {
      ...(log ? { log } : {}),
      gapMs: config.syncGapMs,
      policy: {
        maxAttempts: config.syncMaxAttempts,
        budgetMs: config.syncAccountBudgetMs,
      },
      suspendAfterRounds: config.syncSuspendAfterRounds,
      suspendEnforce: config.syncSuspendEnforce,
      // 层级切换与自动暂停不属于任何单个账号，走广播
      onTier: (event) => hub.broadcast({ type: 'sync:tier', ...event }),
      onSuspend: (decision, account) => {
        if (!decision.enforced) return; // 只观察模式不打扰用户
        hub.publish(account.userId, {
          type: 'account:suspended',
          accountId: account.id,
          rounds: decision.rounds,
          error: decision.error,
        });
      },
    },
  );

  const imageProxy = new ImageProxy({
    secret: loadImageProxySecret(sqlite, box, now()),
    now,
    ...options.imageProxy,
  });

  const send = new SendService({
    db,
    accounts,
    attachmentStore,
    attachmentFetcher: attachments,
    providers,
    ...(options.transport ? { transport: options.transport } : {}),
    connect,
    hub,
    ...(log ? { log } : {}),
    now,
    maxMessageBytes: config.maxUploadBytes,
  });

  return {
    config,
    db,
    sqlite,
    box,
    sessions,
    users,
    accounts,
    folders,
    messages: new MessageService({ db, connect, ...(log ? { log } : {}), now }),
    messageQuery: new MessageQuery({ db, now }),
    search: new SearchService({ db, sqlite }),
    summary: new SummaryService({ db, now }),
    settings,
    send,
    providers,
    attachments,
    attachmentStore,
    imageProxy,
    deviceCode,
    runner,
    scheduler,
    hub,
    tickets,
    log,
  };
}
