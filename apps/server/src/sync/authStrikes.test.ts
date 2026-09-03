import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthStrikes, DEFAULT_AUTH_STRIKE_THRESHOLD } from './authStrikes.ts';

/**
 * 认证失败的连续计数。要求只有四条：
 * 只有认证类失败加一、成功立刻清零、其它失败既不加也不清、按账号隔离。
 */

test('没失败过的账号计数为 0', () => {
  const strikes = new AuthStrikes();
  assert.equal(strikes.count(7), 0);
  assert.equal(strikes.size, 0);
});

test('连续认证失败逐次加一，record 返回更新后的次数', () => {
  const strikes = new AuthStrikes();

  assert.equal(strikes.record(1, 'auth'), 1);
  assert.equal(strikes.record(1, 'auth'), 2);
  assert.equal(strikes.record(1, 'auth'), 3);
  assert.equal(strikes.count(1), 3);
});

test('一次成功立刻清零：同步跑通了就证明凭据还能用', () => {
  const strikes = new AuthStrikes();
  strikes.record(1, 'auth');
  strikes.record(1, 'auth');

  assert.equal(strikes.record(1, null), 0);
  assert.equal(strikes.count(1), 0);
  assert.equal(strikes.size, 0, '清零后不留残留状态');
});

test('限流/抖动等其它失败既不加罚也不清零：它们没证明凭据可用', () => {
  const strikes = new AuthStrikes();
  strikes.record(1, 'auth');

  for (const kind of ['throttled', 'transient', 'unknown', 'smtp_disabled'] as const) {
    assert.equal(strikes.record(1, kind), 1, kind);
  }
});

test('计数按账号隔离', () => {
  const strikes = new AuthStrikes();
  strikes.record(1, 'auth');
  strikes.record(1, 'auth');

  assert.equal(strikes.count(1), 2);
  assert.equal(strikes.count(2), 0);
});

test('门槛默认 8，可配，且不接受小于 1 的值', () => {
  assert.equal(new AuthStrikes().threshold, DEFAULT_AUTH_STRIKE_THRESHOLD);
  assert.equal(DEFAULT_AUTH_STRIKE_THRESHOLD, 8, '实测最长的良性连续失败是 6 轮，门槛必须高于它');
  assert.equal(new AuthStrikes({ threshold: 3 }).threshold, 3);
  assert.equal(new AuthStrikes({ threshold: 0 }).threshold, 1);
  assert.equal(new AuthStrikes({ threshold: -5 }).threshold, 1);
});

test('clear 可以手动清零', () => {
  const strikes = new AuthStrikes();
  strikes.record(1, 'auth');
  strikes.clear(1);
  assert.equal(strikes.count(1), 0);
});
