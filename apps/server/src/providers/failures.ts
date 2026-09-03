/**
 * IMAP / SMTP 建连失败的统一分类。
 *
 * 为什么必须在「认证失败」之前判限流：
 * Outlook 的 IMAP 不会像 HTTP 那样回 429。并发一多它就用
 * `NO [UNAVAILABLE]`、`BAD Request is throttled. Suggested Backoff Time: N milliseconds`、
 * `NO [AUTHENTICATIONFAILED] ... too many`，甚至直接 `* BYE Too many connections` 断链
 * 来表达「慢点」。这些形状里有一半带着 authenticationFailed=true，
 * 用「message 里有没有 auth/login」这种模糊匹配去判，必然把限流判成凭据失效，
 * 于是一个 token 刚刷新成功的账号被标红，要求用户去做完全不必要的设备码授权。
 *
 * 分类结果的用途：
 *  - throttled —— 上游明确要求降速：退避重试 + 给该账号加冷却，**绝不**动账号状态；
 *  - transient —— 网络抖动 / 连接被掐：退避重试，**绝不**动账号状态；
 *  - auth      —— 凭据或 token 真的被拒：标 auth_error，重新授权有意义；
 *  - smtp_disabled —— 邮箱侧关掉了 SMTP 提交：终态，但**不是**凭据问题，重新授权无用；
 *  - unknown   —— 配置错误（主机写错、端口不通）等：标 error，交给人看。
 */

import { OAuthError } from '../auth/oauth/errors.ts';

/** imapflow 在错误对象上实际会出现的字段（见 lib/imap-flow.js、lib/commands/authenticate.js）。 */
interface MailErrorShape {
  code?: unknown;
  /** imapflow：`NO`/`BAD` 后面方括号里的响应码，已大写。 */
  serverResponseCode?: unknown;
  /** imapflow：`NO` | `BAD`。 */
  responseStatus?: unknown;
  /** imapflow：响应码之后的自由文本。 */
  responseText?: unknown;
  /** imapflow 编译回的整条响应；nodemailer 则是完整的 SMTP 应答行。 */
  response?: unknown;
  /** imapflow：连接被服务端 BYE 掐断时的理由，例如 "Too many connections"。 */
  reason?: unknown;
  /** imapflow：ETHROTTLE 时服务端建议的退避毫秒数。 */
  throttleReset?: unknown;
  /** imapflow：任何 AUTHENTICATE 失败都会置 true——限流也会。 */
  authenticationFailed?: unknown;
  /** nodemailer：SMTP 数字应答码。 */
  responseCode?: unknown;
  message?: unknown;
}

export type MailFailureKind = 'throttled' | 'transient' | 'auth' | 'smtp_disabled' | 'unknown';

export interface MailFailure {
  kind: MailFailureKind;
  /** 服务端明确给出的建议退避毫秒数；没给就是 null。 */
  retryAfterMs: number | null;
  /** 判定依据，写日志和拼提示用，永远不含凭据。 */
  signal: string;
}

/**
 * 邮箱侧禁用 SMTP 提交时给用户看的话。
 * 必须说清「重新授权没用」——这是本次改动的全部意义：
 * 535 5.7.139 不是 token 问题，把用户推去做设备码流程只会浪费他的时间。
 */
export const SMTP_SUBMISSION_DISABLED_MESSAGE =
  'SMTP 发信被服务端关闭：该邮箱的 SmtpClientAuthentication 处于禁用状态（535 5.7.139）。' +
  '这不是 token 失效，重新授权不能解决；收信（IMAP）不受影响。' +
  '详见 https://aka.ms/smtp_auth_disabled';

/** imapflow / nodemailer / node 网络层表示「连接没建起来或半路断了」的 code。 */
const TRANSIENT_CODES = new Set([
  // imapflow 自造
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'NOCONNECTION',
  'ECONNECTIONCLOSED',
  'CLOSEDAFTERCONNECTTLS',
  'CLOSEDAFTERCONNECTTEXT',
  // nodemailer
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  // node net / tls
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
]);

/**
 * ENOTFOUND / ECONNREFUSED 刻意不在上面：那是「主机写错了」或「端口没开」，
 * 重试一万次也一样，落到 unknown 让账号标 error 才能被人看见。
 */

/**
 * Node 把 OpenSSL 记录层/握手失败统一成 `ERR_SSL_*`（另带 library='SSL routines'）。
 *
 * 生产实测：29 个账号并发同步时，偶发两条连接在 outlook.live.com:993 上收到
 * `tls_validate_record_header:wrong version number`——同一分钟内另外 25 条到同一端点的
 * TLS 连接全部正常，两个账号下一轮即自愈。端口与 secure 都是对的（993 + secure=true），
 * 每条连接都是独立的 ImapFlow 实例、独立 socket，不存在复用或并发竞争，
 * 所以这是上游/中间设备偶尔回了一段非 TLS 字节，属于网络抖动。
 *
 * 证书校验类失败（CERT_HAS_EXPIRED、UNABLE_TO_VERIFY_LEAF_SIGNATURE 等）不以 ERR_SSL_ 开头，
 * 仍然落到 unknown——那是配置或中间人问题，必须有人看见。
 */
const TLS_RECORD_CODE = /^ERR_SSL_/;

/** imapflow 自己识别出的 MS365 限流。 */
const THROTTLE_CODE = 'ETHROTTLE';

/** IMAP 响应码里表示「现在不行，等会儿再来」的（RFC 5530 + Microsoft 扩展）。 */
const THROTTLE_RESPONSE_CODES = new Set(['UNAVAILABLE', 'THROTTLED', 'INUSE', 'LIMIT', 'TOOMANYREQUESTS']);

/** 服务端自己出错，不是账号的问题。 */
const TRANSIENT_RESPONSE_CODES = new Set(['SERVERBUG']);

const AUTH_RESPONSE_CODES = new Set(['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED']);

/**
 * SMTP 里表示「认证被拒」的数字码。
 * 535 留在里面是安全的：`535 5.7.139 SmtpClientAuthentication is disabled` 在更早一步
 * 就被 SMTP_DISABLED_TEXT 截走了，走到这里的 535 才是真的凭据不对。
 */
const SMTP_AUTH_CODES = new Set([530, 534, 535, 538]);

const THROTTLE_TEXT =
  /request is throttled|throttl|too many (?:concurrent |simultaneous )?(?:connection|request|login|session|command)|maximum number of connections|connection limit|rate limit|server (?:is )?(?:too )?busy|temporarily unavailable|try again later|服务器繁忙/i;

/** 生产上实测到的原文：`535 5.7.139 ... SmtpClientAuthentication is disabled for the Mailbox.` */
const SMTP_DISABLED_TEXT = /smtpclientauthentication is disabled|smtp_auth_disabled/i;

/**
 * 认证失败的文本兜底。
 * 刻意窄：旧版那条 `/auth|login|credential|password|xoauth/i` 会把
 * "Too many login attempts" 和 "SmtpClientAuthentication is disabled" 一起吃掉。
 */
const AUTH_TEXT =
  /authentication (?:failed|unsuccessful)|invalid (?:credential|login|user|password|grant)|login (?:failed|denied)|bad credentials|authentication failure/i;

/** imapflow 在 ETHROTTLE 之外的场合不设 throttleReset，这里再从文本兜一次。 */
const BACKOFF_HINT = /backoff time[:=\s]+(\d+)/i;

/** 包装层数上限。ProviderError 只包一层，5 层足够覆盖任何合理的嵌套，也挡住了环。 */
const MAX_CAUSE_DEPTH = 5;

/**
 * 分类整条错误链。
 *
 * `connectImap` 会把底层错误包成 `ProviderError`，消息已经被翻译成中文，
 * 结构化字段（code / serverResponseCode）也不在外层——只看最外层必然判成 unknown，
 * 于是限流又会被当成账号故障。所以逐层往里找，取第一个有结论的。
 */
export function classifyMailFailure(cause: unknown): MailFailure {
  for (const current of causeChain(cause)) {
    const failure = classifyOne(current);
    if (failure.kind !== 'unknown') return failure;
  }
  return classifyOne(cause);
}

/**
 * 失败发生时，凭据是不是已经成功拿到手了（见 `ProviderError.credentialsResolved`）。
 *
 * 对 OAuth 账号，true 等于「刷新 + 轮换落库刚刚成功」，refresh token 是活的。
 * 这一条比任何错误文本都硬：拿着一个刚铸出来的 access token 还被 IMAP 拒绝，
 * 说明的是服务端此刻不想让我们进来，而不是凭据失效——后者必须靠持续失败来证明。
 *
 * 反过来 false 意味着建连根本没走到「带着凭据去认证」那一步：
 * 唯一能在这种状态下产出认证类失败的就是凭据解析本身（terminal OAuthError），
 * 那才是真的需要重新授权。
 */
export function credentialsWereResolved(cause: unknown): boolean {
  for (const current of causeChain(cause)) {
    if ((current as { credentialsResolved?: unknown }).credentialsResolved === true) return true;
  }
  return false;
}

/** 逐层遍历 `cause` 链，带深度上限与环检测。 */
function* causeChain(cause: unknown): Generator<object> {
  const seen = new Set<unknown>();
  let current: unknown = cause;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'object') yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

function classifyOne(cause: unknown): MailFailure {
  // OAuth 刷新这一步就失败了：token 服务已经给出了权威结论，不必再从文本里猜。
  // 少了这一条，`invalid_grant`（refresh token 真的死了）会落到 unknown 被标成
  // 普通 error，把 tokenStore 刚写好的 auth_error 覆盖掉；而一次 429/网络抖动
  // 同样会落到 unknown，把一个完全健康的账号标红。
  if (cause instanceof OAuthError) {
    return cause.isTerminal
      ? { kind: 'auth', retryAfterMs: null, signal: `OAuth ${cause.code}` }
      : { kind: 'transient', retryAfterMs: cause.retryAfterMs, signal: `OAuth ${cause.code}` };
  }

  const err = (cause ?? {}) as MailErrorShape;
  const code = upper(err.code);
  const responseCode = upper(err.serverResponseCode);
  const text = failureText(err);
  const retryAfterMs = backoffHintMs(err, text);

  // 顺序即语义：最具体的终态在前，限流/抖动在认证之前，模糊文本匹配永远垫底。
  if (SMTP_DISABLED_TEXT.test(text)) {
    return { kind: 'smtp_disabled', retryAfterMs: null, signal: 'SmtpClientAuthentication disabled' };
  }
  if (code === THROTTLE_CODE) return { kind: 'throttled', retryAfterMs, signal: 'ETHROTTLE' };
  if (THROTTLE_RESPONSE_CODES.has(responseCode)) {
    return { kind: 'throttled', retryAfterMs, signal: `[${responseCode}]` };
  }
  if (THROTTLE_TEXT.test(text)) return { kind: 'throttled', retryAfterMs, signal: '服务端要求降速' };

  if (TRANSIENT_CODES.has(code)) return { kind: 'transient', retryAfterMs, signal: code };
  if (TLS_RECORD_CODE.test(code)) return { kind: 'transient', retryAfterMs, signal: code };
  if (TRANSIENT_RESPONSE_CODES.has(responseCode)) {
    return { kind: 'transient', retryAfterMs, signal: `[${responseCode}]` };
  }

  if (isAuthSignal(err, responseCode, code, text)) {
    return { kind: 'auth', retryAfterMs: null, signal: responseCode || code || '认证被拒' };
  }
  return { kind: 'unknown', retryAfterMs: null, signal: code || responseCode || '未分类' };
}

/** 值得退避重试的失败。账号状态在这两类下一律不动。 */
export function isRetryableFailure(failure: MailFailure): boolean {
  return failure.kind === 'throttled' || failure.kind === 'transient';
}

/** 该邮箱在服务端被关掉了 SMTP 提交能力。 */
export function isSmtpSubmissionDisabled(cause: unknown): boolean {
  return classifyMailFailure(cause).kind === 'smtp_disabled';
}

function isAuthSignal(
  err: MailErrorShape,
  responseCode: string,
  code: string,
  text: string,
): boolean {
  if (AUTH_RESPONSE_CODES.has(responseCode)) return true;
  if (code === 'EAUTH') return true;
  if (typeof err.responseCode === 'number' && SMTP_AUTH_CODES.has(err.responseCode)) return true;
  // authenticationFailed 只是「AUTHENTICATE 命令没成功」，限流也会置它；
  // 走到这里说明前面所有限流/抖动信号都没命中，才敢按认证失败处理。
  if (err.authenticationFailed === true) return true;
  return AUTH_TEXT.test(text);
}

/** 把错误里所有可能带线索的文本拼成一条，统一做模式匹配。 */
function failureText(err: MailErrorShape): string {
  return [err.responseText, err.reason, err.response, err.message]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}

function backoffHintMs(err: MailErrorShape, text: string): number | null {
  const reset = Number(err.throttleReset);
  if (Number.isFinite(reset) && reset > 0) return reset;

  const hinted = BACKOFF_HINT.exec(text)?.[1];
  if (hinted === undefined) return null;
  const ms = Number(hinted);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().trim() : '';
}
