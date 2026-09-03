import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OAuthError,
  classifyNetworkError,
  classifyTokenError,
  computeBackoffMs,
  parseRetryAfterMs,
} from './errors.ts';

const classify = (status: number, body: unknown, retryAfter?: string): OAuthError =>
  classifyTokenError({
    status,
    body: body as Record<string, unknown>,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });

test('invalid_grant 系列一律判为终局错误', () => {
  for (const codes of [[70000], [70008], [700082], [50173], [9002313]]) {
    const error = classify(400, {
      error: 'invalid_grant',
      error_description: `AADSTS${codes[0]}: token 失效`,
      error_codes: codes,
    });
    assert.equal(error.kind, 'terminal');
    assert.equal(error.isTerminal, true);
    assert.match(error.publicMessage, /重新授权/);
  }
});

test('客户端配置类错误也是终局错误', () => {
  for (const code of ['invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope']) {
    assert.equal(classify(400, { error: code }).kind, 'terminal');
  }
});

test('未知的 4xx 错误码按终局处理——宁可让用户多点一次重新授权，也不要账号静默失效', () => {
  assert.equal(classify(400, { error: 'something_new' }).kind, 'terminal');
  assert.equal(classify(401, null).kind, 'terminal');
});

test('限流与服务端故障是临时错误', () => {
  assert.equal(classify(429, { error: 'too_many_requests' }).kind, 'transient');
  assert.equal(classify(500, null).kind, 'transient');
  assert.equal(classify(503, null).kind, 'transient');
  assert.equal(classify(408, null).kind, 'transient');
});

test('temporarily_unavailable / server_error 即使是 400 也算临时错误', () => {
  assert.equal(classify(400, { error: 'temporarily_unavailable' }).kind, 'transient');
  assert.equal(classify(400, { error: 'server_error' }).kind, 'transient');
  assert.equal(classify(400, { error: 'authorization_pending' }).kind, 'transient');
  assert.equal(classify(400, { error: 'slow_down' }).kind, 'transient');
});

test('网络错误与超时永远是临时错误，绝不据此判死账号', () => {
  assert.equal(classifyNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).kind, 'transient');
  const timeout = classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }));
  assert.equal(timeout.kind, 'transient');
  assert.equal(timeout.code, 'timeout');
});

test('错误信息里保留状态码与错误码，便于排查', () => {
  const error = classify(400, { error: 'invalid_request', error_description: '缺少参数' });
  assert.match(error.message, /HTTP 400/);
  assert.match(error.message, /invalid_request/);
  assert.equal(error.status, 400);
});

test('超长的 error_description 会被截断', () => {
  const error = classify(400, { error: 'x', error_description: 'a'.repeat(5000) });
  assert.ok((error.description?.length ?? 0) <= 301);
});

test('Retry-After 支持秒数与 HTTP-date', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfterMs('7'), 7000);
  assert.equal(parseRetryAfterMs('  30 '), 30_000);
  assert.equal(parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now), 12_000);
  assert.equal(parseRetryAfterMs('nonsense'), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test('429 会把 Retry-After 带进错误对象', () => {
  assert.equal(classify(429, { error: 'temporarily_unavailable' }, '15').retryAfterMs, 15_000);
});

test('退避是指数增长的，且带抖动落在 [d/2, d) 区间', () => {
  const lower = computeBackoffMs(3, { baseMs: 1000, random: () => 0 });
  const upper = computeBackoffMs(3, { baseMs: 1000, random: () => 0.999 });
  assert.equal(lower, 4000); // 1000 * 2^3 / 2
  assert.ok(upper > lower && upper < 8000);

  const previous = computeBackoffMs(0, { baseMs: 1000, random: () => 0 });
  assert.ok(lower > previous);
});

test('退避有上限', () => {
  assert.ok(computeBackoffMs(30, { baseMs: 1000, maxMs: 60_000, random: () => 0.999 }) <= 60_000);
});

test('Retry-After 优先于指数退避，只叠加不超过 1s 的抖动', () => {
  assert.equal(computeBackoffMs(5, { retryAfterMs: 7000, random: () => 0 }), 7000);
  const jittered = computeBackoffMs(5, { retryAfterMs: 7000, random: () => 0.5 });
  assert.ok(jittered >= 7000 && jittered < 8000);
});
