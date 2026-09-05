import type { ServerEvent } from '@firemail/shared';
import type { SseLinkState } from '@/lib/sse';

/**
 * 活动中心的纯状态模型（无 React、无网络，好测）。
 *
 * 为什么需要它：同步 / 连接测试 / 重新授权都是「点了之后服务端异步跑」的操作，
 * 服务端只回 202，真正的结果通过 SSE 回来。旧版把这三件事都做成了点完没有任何反馈
 * ——用户不知道点没点上、在跑没跑、成没成。这里把它们统一成一条条可见的活动记录：
 * **点击立刻产生一条 running 记录**，SSE 事件到达时把它落成 success / error。
 */

export type ActivityKind = 'sync' | 'test' | 'reauth';
export type ActivityStatus = 'running' | 'success' | 'error' | 'stale';

export interface ActivityEntry {
  /** 同一个账号的同一类操作复用同一条记录，避免连点刷出一串。 */
  id: string;
  kind: ActivityKind;
  accountId: number;
  /** 记录创建时的邮箱地址；账号后来被删掉了，这条历史也还读得懂。 */
  accountEmail: string;
  status: ActivityStatus;
  startedAt: number;
  endedAt?: number;
  /** 结果说明：`新增 3 封` / 后端返回的错误原因。 */
  detail?: string;
}

/** 最多留这么多条，超出丢最旧的。 */
export const ACTIVITY_LIMIT = 50;
/** 完成的记录留这么久就自动清掉，活动中心不是日志系统。 */
export const ACTIVITY_TTL_MS = 10 * 60_000;
/** SSE 断开后，超过这个时长还没有结果的 running 记录标成 stale（状态未知）。 */
export const ACTIVITY_STALE_AFTER_MS = 20_000;

export const KIND_LABEL: Record<ActivityKind, string> = {
  sync: '同步',
  test: '连接测试',
  reauth: '重新授权',
};

export function activityId(kind: ActivityKind, accountId: number): string {
  return `${kind}:${accountId}`;
}

export interface BeginInput {
  kind: ActivityKind;
  accountId: number;
  accountEmail: string;
  now?: number;
}

/** 点击的那一刻就插入 running 记录 —— 这是「立刻确认收到了点击」的唯一来源。 */
export function begin(entries: readonly ActivityEntry[], input: BeginInput): ActivityEntry[] {
  const now = input.now ?? Date.now();
  const id = activityId(input.kind, input.accountId);
  const entry: ActivityEntry = {
    id,
    kind: input.kind,
    accountId: input.accountId,
    accountEmail: input.accountEmail,
    status: 'running',
    startedAt: now,
  };
  return cap([entry, ...entries.filter((item) => item.id !== id)]);
}

export interface SettleInput {
  kind: ActivityKind;
  accountId: number;
  status: Exclude<ActivityStatus, 'running'>;
  detail?: string;
  /** 事件先于点击到达时（后台自动同步）也要能建一条记录。 */
  accountEmail?: string;
  now?: number;
}

/** 落定一条记录。找不到对应的 running 记录时补建一条，后台自动同步也要看得见。 */
export function settle(entries: readonly ActivityEntry[], input: SettleInput): ActivityEntry[] {
  const now = input.now ?? Date.now();
  const id = activityId(input.kind, input.accountId);
  const existing = entries.find((item) => item.id === id);

  const settled: ActivityEntry = {
    id,
    kind: input.kind,
    accountId: input.accountId,
    accountEmail: existing?.accountEmail ?? input.accountEmail ?? '',
    status: input.status,
    startedAt: existing?.startedAt ?? now,
    endedAt: now,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  return cap([settled, ...entries.filter((item) => item.id !== id)]);
}

/**
 * 时间推进：清掉过期的完成记录；SSE 不通时把久等无果的 running 记录标成 stale。
 * stale ≠ 失败：它明确表示「连接断了，这个操作的结果我们不知道」，
 * 比继续转圈假装一切正常诚实得多。
 *
 * 三条规则，缺一不可：
 *  - 转 stale 时**必须**写上 `endedAt`，否则它永远不满足 TTL 清理条件，
 *    角标会一直亮着「N 个进行中」，降级轮询也会一直跑下去；
 *  - 连接恢复后 stale 记录要清掉：重连时已经做过一次全量 invalidate，
 *    真实状态就在页面上，再留一条「状态未知」反而是新的误导；
 *  - 只在 `offline`（断开已过宽限期）时才标 stale。一次一秒的重连不能把
 *    正在跑的操作说成「状态未知」——那和横幅乱闪是同一种撒谎。
 */
export function tick(
  entries: readonly ActivityEntry[],
  options: { now: number; link: SseLinkState },
): ActivityEntry[] {
  const { now, link } = options;
  const next: ActivityEntry[] = [];

  for (const entry of entries) {
    if (entry.endedAt !== undefined && now - entry.endedAt > ACTIVITY_TTL_MS) continue;
    if (link === 'online' && entry.status === 'stale') continue;
    if (
      link === 'offline' &&
      entry.status === 'running' &&
      now - entry.startedAt > ACTIVITY_STALE_AFTER_MS
    ) {
      next.push({ ...entry, status: 'stale', endedAt: now });
      continue;
    }
    next.push(entry);
  }

  return sameEntries(entries, next) ? [...entries] : next;
}

export function runningCount(entries: readonly ActivityEntry[]): number {
  return entries.filter((entry) => entry.status === 'running').length;
}

export function unresolvedCount(entries: readonly ActivityEntry[]): number {
  return entries.filter((entry) => entry.status === 'running' || entry.status === 'stale').length;
}

/**
 * 第一级后台基线是**常驻**的：29 个账号、每个 5 分钟一轮，任意时刻几乎总有一个在跑。
 * 把它们记进活动中心，角标就长期亮着「N 个操作进行中」、图标长期是个转圈——
 * 那不是「有事在发生」，那是这个应用活着的常态，而常态不该占用一个提示位。
 *
 * 活动中心只记用户自己发起的事（第二级批量、第三级单账号、连接测试、重新授权），
 * 它回答的问题是「我刚点的那下怎么样了」。后台基线的流水去设置里的日志页看。
 *
 * 后台同步真出了事仍然到得了用户眼前：账号状态跃迁会推 `account:status`，
 * 那条不带层级、照常落成一条记录并弹 toast。
 */
function isBackground(event: { tier?: string }): boolean {
  return event.tier === 'background';
}

/**
 * SSE 事件 → 活动记录的映射。返回 null 表示这个事件与活动中心无关。
 * 只认 `sync:*` 与 `account:status`：连接测试和重新授权没有对应的服务端事件，
 * 由发起它们的 mutation 自己 settle。
 */
export function activityFromEvent(event: ServerEvent): BeginInput | SettleInput | null {
  switch (event.type) {
    case 'sync:start':
      return isBackground(event) ? null : { kind: 'sync', accountId: event.accountId, accountEmail: '' };
    case 'sync:done':
      return isBackground(event)
        ? null
        : {
            kind: 'sync',
            accountId: event.accountId,
            status: 'success',
            detail: event.newMessages > 0 ? `新增 ${event.newMessages} 封` : '没有新邮件',
          };
    case 'sync:error':
      return isBackground(event)
        ? null
        : { kind: 'sync', accountId: event.accountId, status: 'error', detail: event.message };
    case 'account:status':
      return event.status === 'auth_error'
        ? {
            kind: 'reauth',
            accountId: event.accountId,
            status: 'error',
            detail: '授权已失效，需要重新授权',
          }
        : null;
    default:
      return null;
  }
}

export function isSettle(input: BeginInput | SettleInput): input is SettleInput {
  return 'status' in input;
}

function cap(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.length > ACTIVITY_LIMIT ? entries.slice(0, ACTIVITY_LIMIT) : entries;
}

function sameEntries(a: readonly ActivityEntry[], b: readonly ActivityEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}
