import { describe, expect, it } from 'vitest';
import {
  canRestart,
  deviceCodePhase,
  formatCountdown,
  isTerminalPhase,
  MIN_POLL_INTERVAL_MS,
  pollIntervalMs,
  reauthView,
} from './device-code.ts';
import type { DeviceCodeState } from './schemas.ts';

const NOW = 1_700_000_000_000;

function state(overrides: Partial<DeviceCodeState> = {}): DeviceCodeState {
  return {
    accountId: 1,
    status: 'pending',
    userCode: 'ABCD-1234',
    verificationUri: 'https://microsoft.com/devicelogin',
    message: null,
    intervalSeconds: 5,
    startedAt: NOW,
    expiresAt: NOW + 900_000,
    completedAt: null,
    error: null,
    ...overrides,
  };
}

describe('设备码状态机', () => {
  it('没有流程时是 idle', () => {
    expect(deviceCodePhase(null, NOW)).toBe('idle');
    expect(reauthView(null, NOW).shouldPoll).toBe(false);
  });

  it('发起中显示 starting', () => {
    expect(reauthView(null, NOW, true).phase).toBe('starting');
  });

  it('pending 且未过期时继续轮询', () => {
    const view = reauthView(state(), NOW + 10_000);
    expect(view.phase).toBe('pending');
    expect(view.shouldPoll).toBe(true);
    expect(view.userCode).toBe('ABCD-1234');
    expect(view.remainingMs).toBe(890_000);
  });

  it('过了 deadline 就判过期并停止轮询（旧版会永远停在 pending）', () => {
    const view = reauthView(state(), NOW + 900_001);
    expect(view.phase).toBe('expired');
    expect(view.shouldPoll).toBe(false);
    expect(view.remainingMs).toBe(0);
  });

  it('服务端的 expired_token / timeout 也归为过期', () => {
    for (const code of ['expired_token', 'timeout']) {
      const failed = state({ status: 'failed', error: { code, message: '过期了' } });
      expect(deviceCodePhase(failed, NOW)).toBe('expired');
    }
  });

  it('取消是独立终态，不当成失败', () => {
    const cancelled = state({ status: 'failed', error: { code: 'cancelled', message: '授权已取消' } });
    expect(deviceCodePhase(cancelled, NOW)).toBe('cancelled');
    expect(canRestart('cancelled')).toBe(true);
  });

  it('其它错误码是失败，并把错误原样带给界面', () => {
    const failed = state({
      status: 'failed',
      error: { code: 'invalid_client', message: '客户端 ID 不正确' },
    });
    const view = reauthView(failed, NOW);
    expect(view.phase).toBe('failed');
    expect(view.errorCode).toBe('invalid_client');
    expect(view.errorMessage).toBe('客户端 ID 不正确');
    expect(view.shouldPoll).toBe(false);
  });

  it('成功是终态，且不再轮询', () => {
    const done = state({ status: 'success', completedAt: NOW + 20_000 });
    const view = reauthView(done, NOW + 20_000);
    expect(view.phase).toBe('success');
    expect(view.shouldPoll).toBe(false);
    expect(isTerminalPhase(view.phase)).toBe(true);
    expect(canRestart(view.phase)).toBe(false);
  });

  it('轮询间隔跟随服务端，但有 1 秒下限（slow_down 会把它调大）', () => {
    expect(pollIntervalMs(state({ intervalSeconds: 5 }))).toBe(5_000);
    expect(pollIntervalMs(state({ intervalSeconds: 10 }))).toBe(10_000);
    expect(pollIntervalMs(null)).toBeGreaterThanOrEqual(MIN_POLL_INTERVAL_MS);
  });

  it('倒计时按 mm:ss 显示，且不会出现负数', () => {
    expect(formatCountdown(900_000)).toBe('15:00');
    expect(formatCountdown(65_000)).toBe('01:05');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});
