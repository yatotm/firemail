import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TICKET_TTL_MS, SseTicketStore } from './tickets.ts';

/**
 * SSE 票据。`EventSource` 不能设请求头，凭据只能进 URL，
 * 而 URL 会落进 access log / Referer / 浏览器历史——所以票必须短命且一次性。
 */

test('票据是高熵随机值，每次都不同', () => {
  const store = new SseTicketStore();
  const tickets = new Set(Array.from({ length: 20 }, () => store.issue(1).ticket));

  assert.equal(tickets.size, 20);
  for (const ticket of tickets) {
    assert.ok(ticket.length >= 40, '32 字节 base64url 至少 43 个字符');
    assert.match(ticket, /^[A-Za-z0-9_-]+$/);
  }
});

test('换票返回对应的用户，且只能用一次', () => {
  const store = new SseTicketStore();
  const { ticket } = store.issue(42);

  assert.equal(store.consume(ticket), 42);
  assert.equal(store.consume(ticket), null, '用过即废');
  assert.equal(store.size, 0);
});

test('过期票据无效，并且不会留在内存里', () => {
  const clock = { value: 1_000_000 };
  const store = new SseTicketStore({ now: () => clock.value, ttlMs: 30_000 });
  const { ticket, expiresAt } = store.issue(7);

  assert.equal(expiresAt, 1_030_000);
  clock.value = 1_029_999;
  const stillValid = new SseTicketStore({ now: () => clock.value, ttlMs: 30_000 });
  assert.equal(stillValid.consume('nope'), null);
  assert.equal(store.consume(ticket), 7);

  const expiring = store.issue(7).ticket;
  clock.value += 30_000;
  assert.equal(store.consume(expiring), null);
  assert.equal(store.size, 0);
});

test('未知票据、空串、非字符串一律返回 null', () => {
  const store = new SseTicketStore();
  assert.equal(store.consume('not-a-ticket'), null);
  assert.equal(store.consume(''), null);
  assert.equal(store.consume(undefined as unknown as string), null);
});

test('purge 只清过期的，未到期的留着', () => {
  const clock = { value: 0 };
  const store = new SseTicketStore({ now: () => clock.value, ttlMs: 1000 });
  store.issue(1);
  store.issue(2);

  clock.value = 500;
  const fresh = store.issue(3).ticket;

  clock.value = 1200;
  assert.equal(store.purge(), 2);
  assert.equal(store.size, 1);
  assert.equal(store.consume(fresh), 3);
});

test('数量封顶，被刷也不会无限增长', () => {
  const store = new SseTicketStore({ maxTickets: 5 });
  const tickets = Array.from({ length: 20 }, () => store.issue(1).ticket);

  assert.ok(store.size <= 5);
  assert.equal(store.consume(tickets.at(-1) as string), 1, '最新的票必须还在');
});

test('默认 TTL 是 30 秒量级，不是会话那种长期凭据', () => {
  assert.ok(DEFAULT_TICKET_TTL_MS <= 60_000);
});
