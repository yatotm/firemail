import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_COOLDOWN_MULTIPLIER, SyncCooldown } from './cooldown.ts';

/**
 * 被限流账号的临时降频。
 * 要求只有三条：只惩罚真被限流的、惩罚有上限、成功一次立刻恢复。
 */

test('没有被限流过的账号倍数恒为 1', () => {
  const cooldown = new SyncCooldown();
  assert.equal(cooldown.multiplier(7), 1);
  assert.equal(cooldown.size, 0);
});

test('连续被限流：倍数按 2 的幂增长', () => {
  const cooldown = new SyncCooldown();

  cooldown.record(1, 'throttled');
  assert.equal(cooldown.multiplier(1), 2);
  cooldown.record(1, 'throttled');
  assert.equal(cooldown.multiplier(1), 4);
  cooldown.record(1, 'throttled');
  assert.equal(cooldown.multiplier(1), 8);
});

test('惩罚有上限，不会把账号冷却到永远不收信', () => {
  const cooldown = new SyncCooldown();
  for (let i = 0; i < 20; i += 1) cooldown.record(1, 'throttled');
  assert.equal(cooldown.multiplier(1), MAX_COOLDOWN_MULTIPLIER);
});

test('上限可配', () => {
  const cooldown = new SyncCooldown({ maxMultiplier: 2 });
  cooldown.record(1, 'throttled');
  cooldown.record(1, 'throttled');
  assert.equal(cooldown.multiplier(1), 2);
});

test('成功一次立刻解除：上游限流是瞬时的，恢复也应该是瞬时的', () => {
  const cooldown = new SyncCooldown();
  cooldown.record(1, 'throttled');
  cooldown.record(1, 'throttled');

  cooldown.record(1, null);

  assert.equal(cooldown.multiplier(1), 1);
  assert.equal(cooldown.size, 0, '解除后不留残留状态');
});

test('其它失败既不加罚也不解除：坏账号不该靠失败洗掉限流惩罚', () => {
  const cooldown = new SyncCooldown();
  cooldown.record(1, 'throttled');

  for (const kind of ['auth', 'unknown', 'transient', 'smtp_disabled'] as const) {
    cooldown.record(1, kind);
    assert.equal(cooldown.multiplier(1), 2, kind);
  }
});

test('冷却是按账号隔离的', () => {
  const cooldown = new SyncCooldown();
  cooldown.record(1, 'throttled');
  cooldown.record(1, 'throttled');

  assert.equal(cooldown.multiplier(1), 4);
  assert.equal(cooldown.multiplier(2), 1);
});

test('clear 可以手动解除', () => {
  const cooldown = new SyncCooldown();
  cooldown.record(1, 'throttled');
  cooldown.clear(1);
  assert.equal(cooldown.multiplier(1), 1);
});
