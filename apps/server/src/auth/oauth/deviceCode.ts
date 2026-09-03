import { OAuthError } from './errors.ts';
import type { MicrosoftOAuthClient } from './microsoftClient.ts';
import { OAuthPersistError, type OAuthTokenStore } from './tokenStore.ts';

/**
 * 设备码重新授权。refresh token 真的死掉时（密码变更 / 长期未用 / 被吊销），
 * 这是唯一不需要浏览器回调地址就能救回账号的路子。
 *
 * 旧实现的问题是"轮询到天荒地老"：没有总时限，没有 slow_down 处理，失败也不落状态。
 * 这里给了硬性 deadline，并且成功后走与刷新完全相同的落库路径。
 */

/** slow_down 时按 RFC 8628 的建议把间隔加 5 秒。 */
const SLOW_DOWN_STEP_SECONDS = 5;
/** 无论服务端说 expires_in 多久，总时长不超过这个上限。 */
const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000;
/** 网络抖动时的轮询重试上限，超过就判失败——设备码本身很快会过期，硬扛没有意义。 */
const MAX_TRANSIENT_POLLS = 5;

export type DeviceCodeStatus = 'pending' | 'success' | 'failed';

/** 可以安全交给 API 层轮询/推送的状态，不含 device_code 与任何 token。 */
export interface DeviceCodeFlowState {
  accountId: number;
  status: DeviceCodeStatus;
  userCode: string;
  verificationUri: string;
  message: string | null;
  intervalSeconds: number;
  startedAt: number;
  /** 授权码本身的过期时刻，与轮询 deadline 取较早者。 */
  expiresAt: number;
  completedAt: number | null;
  error: { code: string; message: string } | null;
}

export interface DeviceCodeServiceOptions {
  store: OAuthTokenStore;
  client: MicrosoftOAuthClient;
  scope?: string;
  maxDurationMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Flow {
  state: DeviceCodeFlowState;
  deviceCode: string;
  clientId: string;
  deadline: number;
  cancelled: boolean;
  done: Promise<DeviceCodeFlowState>;
}

export class DeviceCodeService {
  readonly #store: OAuthTokenStore;
  readonly #client: MicrosoftOAuthClient;
  readonly #scope: string | undefined;
  readonly #maxDurationMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #logger: DeviceCodeServiceOptions['logger'];
  readonly #flows = new Map<number, Flow>();

  constructor(options: DeviceCodeServiceOptions) {
    this.#store = options.store;
    this.#client = options.client;
    this.#scope = options.scope;
    this.#maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /** 发起授权：返回给用户看的 user_code / 验证地址，随后在后台轮询。 */
  async start(accountId: number): Promise<DeviceCodeFlowState> {
    const existing = this.#flows.get(accountId);
    if (existing && existing.state.status === 'pending') this.cancel(accountId);

    const account = this.#store.loadAccount(accountId);
    const grant = await this.#client.requestDeviceCode({
      clientId: account.clientId,
      ...(this.#scope === undefined ? {} : { scope: this.#scope }),
    });

    const startedAt = this.#now();
    const deadline = Math.min(
      startedAt + grant.expiresInSeconds * 1000,
      startedAt + this.#maxDurationMs,
    );

    const state: DeviceCodeFlowState = {
      accountId,
      status: 'pending',
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      message: grant.message,
      intervalSeconds: grant.intervalSeconds,
      startedAt,
      expiresAt: deadline,
      completedAt: null,
      error: null,
    };
    const flow: Flow = {
      state,
      deviceCode: grant.deviceCode,
      clientId: account.clientId,
      deadline,
      cancelled: false,
      done: Promise.resolve(state), // 占位，下一行立刻换成真正的轮询 promise
    };
    this.#flows.set(accountId, flow);
    // 后台轮询：不 await，但保留 promise 供 wait() 使用；catch 防止 unhandled rejection
    flow.done = this.#poll(flow).catch(() => flow.state);
    return flow.state;
  }

  /** 当前状态快照，供 API 层轮询或推送。 */
  get(accountId: number): DeviceCodeFlowState | null {
    return this.#flows.get(accountId)?.state ?? null;
  }

  /** 等到流程结束（成功或失败）。 */
  async wait(accountId: number): Promise<DeviceCodeFlowState> {
    const flow = this.#flows.get(accountId);
    if (!flow) throw new Error(`账号 ${accountId} 没有进行中的设备码授权`);
    return flow.done;
  }

  cancel(accountId: number): boolean {
    const flow = this.#flows.get(accountId);
    if (!flow || flow.state.status !== 'pending') return false;
    flow.cancelled = true;
    this.#fail(flow, 'cancelled', '授权已取消');
    return true;
  }

  /** 清掉已结束的流程记录，避免长跑进程里无限堆积。 */
  forget(accountId: number): void {
    const flow = this.#flows.get(accountId);
    if (flow && flow.state.status !== 'pending') this.#flows.delete(accountId);
  }

  async #poll(flow: Flow): Promise<DeviceCodeFlowState> {
    let transientPolls = 0;

    while (!flow.cancelled) {
      const waitMs = flow.state.intervalSeconds * 1000;
      if (this.#now() + waitMs > flow.deadline) {
        return this.#fail(flow, 'timeout', '设备码授权超时，用户未在有效期内完成授权');
      }
      await this.#sleep(waitMs);
      if (flow.cancelled) break;

      try {
        const tokenSet = await this.#client.redeemDeviceCode({
          clientId: flow.clientId,
          deviceCode: flow.deviceCode,
        });
        // 与刷新走同一条落库路径：写库失败即视为授权失败
        this.#store.persistTokenSet(flow.state.accountId, tokenSet, this.#now());
        flow.state.status = 'success';
        flow.state.completedAt = this.#now();
        return flow.state;
      } catch (error) {
        const outcome = this.#classifyPoll(error, flow);
        if (outcome.kind === 'stop') return flow.state;
        if (outcome.kind === 'transient') {
          transientPolls += 1;
          if (transientPolls > MAX_TRANSIENT_POLLS) {
            return this.#fail(flow, outcome.error.code, outcome.error.publicMessage);
          }
        }
      }
    }

    return flow.state;
  }

  /** continue = 继续轮询；transient = 继续但计入网络失败次数；stop = 流程已结束。 */
  #classifyPoll(
    error: unknown,
    flow: Flow,
  ): { kind: 'continue' } | { kind: 'transient'; error: OAuthError } | { kind: 'stop' } {
    if (error instanceof OAuthPersistError) {
      this.#logger?.warn('设备码授权成功但 token 落库失败', { accountId: flow.state.accountId });
      this.#fail(flow, 'persist_failed', error.message);
      return { kind: 'stop' };
    }
    if (!(error instanceof OAuthError)) {
      this.#fail(flow, 'internal_error', (error as Error)?.message ?? '未知错误');
      return { kind: 'stop' };
    }

    switch (error.code) {
      case 'authorization_pending':
        return { kind: 'continue' };
      case 'slow_down':
        flow.state.intervalSeconds += SLOW_DOWN_STEP_SECONDS;
        return { kind: 'continue' };
      case 'expired_token':
        this.#fail(flow, error.code, '设备码已过期，请重新发起授权');
        return { kind: 'stop' };
      default:
        if (error.kind === 'transient') return { kind: 'transient', error };
        this.#fail(flow, error.code, error.publicMessage);
        return { kind: 'stop' };
    }
  }

  #fail(flow: Flow, code: string, message: string): DeviceCodeFlowState {
    flow.state.status = 'failed';
    flow.state.completedAt = this.#now();
    flow.state.error = { code, message };
    return flow.state;
  }
}
