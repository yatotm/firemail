import type { DeviceCodeState } from '@/lib/accounts/schemas';

/**
 * 设备码授权的客户端状态机。
 *
 * 旧版的轮询没有总时限：只要 websocket 没连上，界面就永远停在「等待授权」，
 * 用户不知道该继续等还是重新发起。新后端给了硬 deadline（设备码过期时刻与
 * 15 分钟上限的较早者），**前端必须把它当真**：过了 deadline 就停止轮询并如实
 * 显示「已过期」，而不是继续转圈。
 */

export type ReauthPhase = 'idle' | 'starting' | 'pending' | 'success' | 'failed' | 'expired' | 'cancelled';

/** 服务端建议的间隔可能是 5 秒，但也可能因 slow_down 变长；下限 1 秒防打死接口。 */
export const MIN_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** `failed` 里这两个错误码语义上是「码过期了」，与真正的失败分开显示。 */
const EXPIRY_CODES = new Set(['expired_token', 'timeout']);
const CANCEL_CODES = new Set(['cancelled']);

export interface ReauthView {
  phase: ReauthPhase;
  userCode: string | null;
  verificationUri: string | null;
  /** 服务端给的引导文案（微软会带上验证地址）。 */
  message: string | null;
  /** 距 deadline 还有多久，永不为负。 */
  remainingMs: number;
  shouldPoll: boolean;
  pollIntervalMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export function deviceCodePhase(state: DeviceCodeState | null, now: number): ReauthPhase {
  if (!state) return 'idle';
  if (state.status === 'success') return 'success';
  if (state.status === 'failed') {
    const code = state.error?.code ?? '';
    if (CANCEL_CODES.has(code)) return 'cancelled';
    return EXPIRY_CODES.has(code) ? 'expired' : 'failed';
  }
  // pending：服务端还没落终态，但 deadline 已过就不该再等了
  return now >= state.expiresAt ? 'expired' : 'pending';
}

export function isTerminalPhase(phase: ReauthPhase): boolean {
  return phase === 'success' || phase === 'failed' || phase === 'expired' || phase === 'cancelled';
}

export function pollIntervalMs(state: DeviceCodeState | null): number {
  if (!state) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, state.intervalSeconds * 1000);
}

export function reauthView(
  state: DeviceCodeState | null,
  now: number,
  starting = false,
): ReauthView {
  const phase = starting && !state ? 'starting' : deviceCodePhase(state, now);
  return {
    phase,
    userCode: state?.userCode ?? null,
    verificationUri: state?.verificationUri ?? null,
    message: state?.message ?? null,
    remainingMs: state ? Math.max(0, state.expiresAt - now) : 0,
    shouldPoll: phase === 'pending',
    pollIntervalMs: pollIntervalMs(state),
    errorCode: state?.error?.code ?? null,
    errorMessage: state?.error?.message ?? null,
  };
}

/** `mm:ss` 倒计时。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const REAUTH_PHASE_LABEL: Record<ReauthPhase, string> = {
  idle: '未开始',
  starting: '正在发起授权…',
  pending: '等待在浏览器中完成授权',
  success: '授权成功',
  failed: '授权失败',
  expired: '设备码已过期',
  cancelled: '已取消授权',
};

/** 终态里哪些还值得「再试一次」。 */
export function canRestart(phase: ReauthPhase): boolean {
  return phase === 'idle' || phase === 'failed' || phase === 'expired' || phase === 'cancelled';
}
