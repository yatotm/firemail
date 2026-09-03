import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthError } from '../auth/oauth/errors.ts';
import { isAuthFailure, smtpStatusOf } from './base.ts';
import {
  SMTP_SUBMISSION_DISABLED_MESSAGE,
  classifyMailFailure,
  credentialsWereResolved,
  isRetryableFailure,
  isSmtpSubmissionDisabled,
} from './failures.ts';
import { ProviderError } from './types.ts';

/**
 * 失败分类。
 *
 * 用例形状全部照抄 imapflow 1.7.x 真实产出的错误对象
 * （lib/imap-flow.js 的 settleRequest / connect，lib/commands/authenticate.js 的 handleAuthError），
 * 以及 nodemailer 在 535 上的实际异常，不是臆造的。
 */

const kind = (cause: unknown): string => classifyMailFailure(cause).kind;

/** imapflow：`tag NO [CODE] text` 会得到这样一个错误。 */
function imapNo(code: string, text: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('Command failed'), {
    responseStatus: 'NO',
    serverResponseCode: code,
    responseText: text,
    response: `x1 NO [${code}] ${text}`,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 限流：Outlook 在 IMAP 上表达「慢点」的每一种形状
// ---------------------------------------------------------------------------

test('限流：imapflow 解析出的 ETHROTTLE，退避时长来自服务端', () => {
  const error = Object.assign(new Error('Command failed'), {
    responseStatus: 'BAD',
    responseText: 'Request is throttled. Suggested Backoff Time: 92415 milliseconds',
    code: 'ETHROTTLE',
    throttleReset: 92_415,
  });

  const failure = classifyMailFailure(error);

  assert.equal(failure.kind, 'throttled');
  assert.equal(failure.retryAfterMs, 92_415);
  assert.ok(isRetryableFailure(failure));
});

test('限流：没有 ETHROTTLE code 时也能从 Backoff Time 文本里读出退避时长', () => {
  const error = Object.assign(new Error('Command failed'), {
    responseStatus: 'BAD',
    responseText: 'Request is throttled. Suggested Backoff Time: 30000 milliseconds',
  });

  const failure = classifyMailFailure(error);

  assert.equal(failure.kind, 'throttled');
  assert.equal(failure.retryAfterMs, 30_000);
});

test('限流：NO [UNAVAILABLE]', () => {
  assert.equal(kind(imapNo('UNAVAILABLE', 'Server unavailable. 15')), 'throttled');
});

test('限流：NO [THROTTLED] / [INUSE] / [LIMIT] 都算', () => {
  for (const code of ['THROTTLED', 'INUSE', 'LIMIT', 'TOOMANYREQUESTS']) {
    assert.equal(kind(imapNo(code, 'slow down')), 'throttled', code);
  }
});

test('限流：AUTHENTICATIONFAILED 但文案说 too many connections —— 这正是生产上把账号误标红的那一次', () => {
  const error = imapNo('AUTHENTICATIONFAILED', 'Too many concurrent connections. Try again later.', {
    authenticationFailed: true,
  });

  const failure = classifyMailFailure(error);

  assert.equal(failure.kind, 'throttled', 'authenticationFailed=true 不足以判定凭据失效');
  assert.equal(isAuthFailure(error), false, '绝不能提示用户重新授权');
});

test('限流：服务端 BYE 掐断连接，理由挂在 reason 上', () => {
  const error = Object.assign(new Error('Unexpected close'), {
    code: 'ClosedAfterConnectTLS',
    reason: 'Too many connections from this IP',
  });

  assert.equal(kind(error), 'throttled');
});

test('限流：只有 rate limit / server busy 文案，没有任何结构化字段', () => {
  assert.equal(kind(new Error('Rate limit exceeded, try again later')), 'throttled');
  assert.equal(kind(new Error('Server is busy')), 'throttled');
});

// ---------------------------------------------------------------------------
// 网络抖动
// ---------------------------------------------------------------------------

test('抖动：imapflow 的超时家族与 socket 错误都算 transient', () => {
  for (const code of [
    'CONNECT_TIMEOUT',
    'GREETING_TIMEOUT',
    'UPGRADE_TIMEOUT',
    'ETIMEOUT',
    'NoConnection',
    'EConnectionClosed',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
  ]) {
    const error = Object.assign(new Error('boom'), { code });
    assert.equal(kind(error), 'transient', code);
    assert.ok(isRetryableFailure(classifyMailFailure(error)), code);
  }
});

test('抖动：NO [SERVERBUG] 是服务端自己的问题，不是账号的问题', () => {
  assert.equal(kind(imapNo('SERVERBUG', 'internal error')), 'transient');
});

test('配置错误不算抖动：ENOTFOUND / ECONNREFUSED 必须落到 unknown，否则永远不会被标红', () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED']) {
    const failure = classifyMailFailure(Object.assign(new Error('boom'), { code }));
    assert.equal(failure.kind, 'unknown', code);
    assert.equal(isRetryableFailure(failure), false, code);
  }
});

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

test('认证：干净的 NO [AUTHENTICATIONFAILED] 才判定凭据被拒', () => {
  const error = imapNo('AUTHENTICATIONFAILED', 'Invalid credentials', {
    authenticationFailed: true,
  });

  assert.equal(kind(error), 'auth');
  assert.equal(isAuthFailure(error), true);
});

test('认证：AUTHORIZATIONFAILED / EXPIRED 同样是 auth', () => {
  assert.equal(kind(imapNo('AUTHORIZATIONFAILED', 'nope')), 'auth');
  assert.equal(kind(imapNo('EXPIRED', 'account expired')), 'auth');
});

test('认证：nodemailer 的 EAUTH 与 530/534/538 数字码', () => {
  assert.equal(kind(Object.assign(new Error('Invalid login'), { code: 'EAUTH' })), 'auth');
  for (const responseCode of [530, 534, 535, 538]) {
    assert.equal(kind(Object.assign(new Error('nope'), { responseCode })), 'auth', String(responseCode));
  }
});

test('认证的文本兜底刻意收窄：光有 login / password 字样不再算凭据失效', () => {
  assert.equal(kind(new Error('Too many login attempts, please retry')), 'throttled');
  assert.equal(kind(new Error('password change detected on the server')), 'unknown');
  assert.equal(kind(new Error('Authentication failed')), 'auth');
});

// ---------------------------------------------------------------------------
// 邮箱侧关闭 SMTP 提交
// ---------------------------------------------------------------------------

test('535 5.7.139：识别成 smtp_disabled，而不是凭据失效', () => {
  const error = Object.assign(
    new Error(
      'Invalid login: 535 5.7.139 Authentication unsuccessful, ' +
        'SmtpClientAuthentication is disabled for the Mailbox. ' +
        'Visit https://aka.ms/smtp_auth_disabled for more information.',
    ),
    { code: 'EAUTH', responseCode: 535 },
  );

  assert.equal(kind(error), 'smtp_disabled');
  assert.equal(isSmtpSubmissionDisabled(error), true);
  assert.equal(isAuthFailure(error), false, '不能走到「需要重新授权」那条路径上');
  assert.equal(smtpStatusOf(error), 'disabled');
});

test('535 5.7.139 的提示必须说清重新授权没用，并给出官方链接', () => {
  assert.match(SMTP_SUBMISSION_DISABLED_MESSAGE, /重新授权不能解决/);
  assert.match(SMTP_SUBMISSION_DISABLED_MESSAGE, /https:\/\/aka\.ms\/smtp_auth_disabled/);
  assert.match(SMTP_SUBMISSION_DISABLED_MESSAGE, /收信/);
  assert.doesNotMatch(SMTP_SUBMISSION_DISABLED_MESSAGE, /设备码/);
});

test('真的凭据不对时 535 仍然是 auth', () => {
  const error = Object.assign(new Error('Invalid login: 535 5.7.3 Authentication unsuccessful'), {
    code: 'EAUTH',
    responseCode: 535,
  });

  assert.equal(kind(error), 'auth');
  assert.equal(smtpStatusOf(error), 'auth_error');
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test('边界：null / undefined / 空对象 / 字符串都不会抛，落到 unknown', () => {
  for (const cause of [null, undefined, {}, 'boom', 42]) {
    const failure = classifyMailFailure(cause);
    assert.equal(failure.kind, 'unknown');
    assert.equal(failure.retryAfterMs, null);
    assert.equal(isRetryableFailure(failure), false);
  }
});

test('边界：throttleReset 为 0 或非数字时不给出退避建议', () => {
  for (const throttleReset of [0, -1, 'soon', null]) {
    const failure = classifyMailFailure(
      Object.assign(new Error('x'), { code: 'ETHROTTLE', throttleReset }),
    );
    assert.equal(failure.kind, 'throttled');
    assert.equal(failure.retryAfterMs, null, String(throttleReset));
  }
});

test('边界：serverResponseCode 大小写与空白不影响判定', () => {
  assert.equal(kind(Object.assign(new Error('x'), { serverResponseCode: ' unavailable ' })), 'throttled');
});

// ---------------------------------------------------------------------------
// 包装层：connectImap 会把底层错误包成 ProviderError
// ---------------------------------------------------------------------------

test('穿透 ProviderError：结构化字段在 cause 上，外层只有翻译过的中文消息', () => {
  const inner = imapNo('UNAVAILABLE', 'Server unavailable. 15', { authenticationFailed: true });
  const wrapped = new ProviderError('IMAP 连接失败: Command failed', inner);

  const failure = classifyMailFailure(wrapped);

  assert.equal(failure.kind, 'throttled', '只看最外层会判成 unknown，账号就会被错误标红');
  assert.equal(isRetryableFailure(failure), true);
});

test('穿透 ProviderError：nodemailer 的 535 5.7.139 包一层后仍然是 smtp_disabled', () => {
  const inner = Object.assign(
    new Error('Invalid login: 535 5.7.139 SmtpClientAuthentication is disabled for the Mailbox.'),
    { code: 'EAUTH', responseCode: 535 },
  );
  assert.equal(kind(new ProviderError('SMTP 连接失败', inner)), 'smtp_disabled');
});

test('穿透有上限，自引用的错误链不会死循环', () => {
  const loop = new Error('boom') as Error & { cause?: unknown };
  loop.cause = loop;

  assert.equal(kind(loop), 'unknown');
});

test('整条链都没有结论时返回最外层的 unknown', () => {
  const inner = Object.assign(new Error('inner'), { code: 'ENOTFOUND' });
  const failure = classifyMailFailure(new ProviderError('外层', inner));

  assert.equal(failure.kind, 'unknown');
});

// ---------------------------------------------------------------------------
// TLS 握手：生产上偶发，端口与 secure 都没错
// ---------------------------------------------------------------------------

/** node 把 OpenSSL 的失败编成 ERR_SSL_* + reason/library，见 tls_validate_record_header。 */
function tlsError(reason: string, code: string): Error {
  return Object.assign(new Error(`58A2:error:0A00010B:SSL routines:tls_validate_record_header:${reason}:x.c:77:`), {
    code,
    reason,
    library: 'SSL routines',
  });
}

test('TLS 记录层/握手失败算网络抖动：会重试，且绝不动账号状态', () => {
  const failure = classifyMailFailure(tlsError('wrong version number', 'ERR_SSL_WRONG_VERSION_NUMBER'));

  assert.equal(failure.kind, 'transient');
  assert.equal(isRetryableFailure(failure), true);
  assert.equal(failure.signal, 'ERR_SSL_WRONG_VERSION_NUMBER');
});

test('TLS 抖动包在 ProviderError 里同样能认出来', () => {
  const inner = tlsError('packet length too long', 'ERR_SSL_PACKET_LENGTH_TOO_LONG');
  assert.equal(kind(new ProviderError('IMAP 连接失败: ...', inner)), 'transient');
});

test('证书校验失败不算抖动：那是配置或中间人问题，必须有人看见', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    assert.equal(kind(Object.assign(new Error('cert'), { code })), 'unknown', code);
  }
});

// ---------------------------------------------------------------------------
// OAuth：刷新这一步的失败自己就是结论，不该再从文本里猜
// ---------------------------------------------------------------------------

test('刷新被拒（terminal）就是认证失败：否则会落到 unknown，把账号标成普通 error', () => {
  const dead = new OAuthError('refresh token 无效或已被吊销，需要重新授权', {
    kind: 'terminal',
    code: 'invalid_grant',
    status: 400,
    aadCodes: [70000],
  });

  const failure = classifyMailFailure(dead);

  assert.equal(failure.kind, 'auth');
  assert.equal(isRetryableFailure(failure), false);
  assert.equal(isAuthFailure(dead), true);
});

test('刷新时的临时故障是抖动：一次 429 / 网络错误不该让账号变红', () => {
  const blip = new OAuthError('Microsoft 授权服务暂时不可用（HTTP 429 / http_429）', {
    kind: 'transient',
    code: 'http_429',
    status: 429,
    retryAfterMs: 30_000,
  });

  const failure = classifyMailFailure(blip);

  assert.equal(failure.kind, 'transient');
  assert.equal(failure.retryAfterMs, 30_000, '服务端给的 Retry-After 要带出来');
  assert.equal(isRetryableFailure(failure), true);
});

// ---------------------------------------------------------------------------
// 凭据到手与否：判「是不是真要重新授权」唯一不含歧义的信号
// ---------------------------------------------------------------------------

test('凭据解析成功之后才失败的错误带着标记，且能穿透包装层读出来', () => {
  const inner = imapNo('AUTHENTICATIONFAILED', 'AUTHENTICATE failed.', { authenticationFailed: true });
  const wrapped = new ProviderError('Outlook IMAP 认证被拒绝。', inner, { credentialsResolved: true });

  assert.equal(wrapped.credentialsResolved, true);
  assert.equal(credentialsWereResolved(wrapped), true);
  assert.equal(kind(wrapped), 'auth', '仍然是认证类失败，只是不再等于「凭据失效」');
});

test('没走到凭据那一步的失败没有标记；null / 字符串等非对象也不会抛', () => {
  assert.equal(credentialsWereResolved(new ProviderError('IMAP 连接失败')), false);
  assert.equal(
    credentialsWereResolved(
      new OAuthError('refresh token 已过期', { kind: 'terminal', code: 'invalid_grant' }),
    ),
    false,
  );
  for (const cause of [null, undefined, 'boom', 42, {}]) {
    assert.equal(credentialsWereResolved(cause), false, String(cause));
  }
});
