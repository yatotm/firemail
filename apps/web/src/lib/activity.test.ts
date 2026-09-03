import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  ACTIVITY_STALE_AFTER_MS,
  ACTIVITY_TTL_MS,
  activityFromEvent,
  activityId,
  begin,
  isSettle,
  runningCount,
  settle,
  tick,
  unresolvedCount,
  type ActivityEntry,
} from '@/lib/activity';

const T0 = 1_700_000_000_000;

function running(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: activityId('sync', 1),
    kind: 'sync',
    accountId: 1,
    accountEmail: 'a@outlook.com',
    status: 'running',
    startedAt: T0,
    ...overrides,
  };
}

describe('活动记录：开始', () => {
  it('点击立刻产生一条 running 记录，最新的排最前', () => {
    const one = begin([], { kind: 'sync', accountId: 1, accountEmail: 'a@x.com', now: T0 });
    const two = begin(one, { kind: 'test', accountId: 2, accountEmail: 'b@x.com', now: T0 + 1 });

    expect(two).toHaveLength(2);
    expect(two[0]?.kind).toBe('test');
    expect(two[1]?.status).toBe('running');
    expect(runningCount(two)).toBe(2);
  });

  it('同一账号的同一类操作连点只保留一条，不刷屏', () => {
    let entries = begin([], { kind: 'sync', accountId: 1, accountEmail: 'a@x.com', now: T0 });
    entries = begin(entries, { kind: 'sync', accountId: 1, accountEmail: 'a@x.com', now: T0 + 50 });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.startedAt).toBe(T0 + 50);
  });

  it('同一账号的不同操作互不覆盖', () => {
    let entries = begin([], { kind: 'sync', accountId: 1, accountEmail: 'a@x.com', now: T0 });
    entries = begin(entries, { kind: 'test', accountId: 1, accountEmail: 'a@x.com', now: T0 });

    expect(entries).toHaveLength(2);
  });

  it('条数有上限，超出丢最旧的', () => {
    let entries: ActivityEntry[] = [];
    for (let id = 1; id <= ACTIVITY_LIMIT + 5; id++) {
      entries = begin(entries, { kind: 'sync', accountId: id, accountEmail: `${id}@x.com`, now: T0 });
    }
    expect(entries).toHaveLength(ACTIVITY_LIMIT);
    expect(entries[0]?.accountId).toBe(ACTIVITY_LIMIT + 5);
  });
});

describe('活动记录：落定', () => {
  it('把 running 落成 success，并保留原来的开始时间', () => {
    const entries = settle([running()], {
      kind: 'sync',
      accountId: 1,
      status: 'success',
      detail: '新增 3 封',
      now: T0 + 4_000,
    });

    expect(entries[0]).toMatchObject({
      status: 'success',
      startedAt: T0,
      endedAt: T0 + 4_000,
      detail: '新增 3 封',
      accountEmail: 'a@outlook.com',
    });
    expect(runningCount(entries)).toBe(0);
  });

  it('没有对应 running 记录时补建一条 —— 后台自动同步也要看得见', () => {
    const entries = settle([], {
      kind: 'sync',
      accountId: 7,
      status: 'error',
      accountEmail: 'g@x.com',
      detail: '连接超时',
      now: T0,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ accountId: 7, status: 'error', detail: '连接超时' });
  });
});

describe('活动记录：时间推进', () => {
  it('SSE 断开且久等无果时标成 stale，而不是继续假装在转圈', () => {
    const entries = tick([running()], {
      now: T0 + ACTIVITY_STALE_AFTER_MS + 1,
      connected: false,
    });

    expect(entries[0]?.status).toBe('stale');
    expect(unresolvedCount(entries)).toBe(1);
  });

  it('SSE 连着的时候不标 stale —— 事件迟早会来', () => {
    const entries = tick([running()], { now: T0 + 10 * ACTIVITY_STALE_AFTER_MS, connected: true });
    expect(entries[0]?.status).toBe('running');
  });

  it('刚发起、还没超过阈值的不标 stale', () => {
    const entries = tick([running()], { now: T0 + ACTIVITY_STALE_AFTER_MS - 1, connected: false });
    expect(entries[0]?.status).toBe('running');
  });

  it('完成很久的记录会被清掉，活动中心不是日志系统', () => {
    const done = running({ status: 'success', endedAt: T0 });
    expect(tick([done], { now: T0 + ACTIVITY_TTL_MS + 1, connected: true })).toEqual([]);
    expect(tick([done], { now: T0 + ACTIVITY_TTL_MS - 1, connected: true })).toHaveLength(1);
  });
});

describe('SSE 事件 → 活动记录', () => {
  it('sync:start 开一条，sync:done 带上新邮件数落定', () => {
    const start = activityFromEvent({ type: 'sync:start', accountId: 3 });
    expect(start).not.toBeNull();
    expect(start && isSettle(start)).toBe(false);

    const done = activityFromEvent({ type: 'sync:done', accountId: 3, newMessages: 2 });
    expect(done).toMatchObject({ status: 'success', detail: '新增 2 封' });

    const empty = activityFromEvent({ type: 'sync:done', accountId: 3, newMessages: 0 });
    expect(empty).toMatchObject({ status: 'success', detail: '没有新邮件' });
  });

  it('sync:error 用后端给的原因，不编自己的文案', () => {
    const event = activityFromEvent({
      type: 'sync:error',
      accountId: 3,
      message: '无法连接到 outlook.office365.com',
    });
    expect(event).toMatchObject({ status: 'error', detail: '无法连接到 outlook.office365.com' });
  });

  it('account:status 只在授权失效时进活动中心，正常状态不刷条目', () => {
    expect(activityFromEvent({ type: 'account:status', accountId: 4, status: 'auth_error' })).
      toMatchObject({ kind: 'reauth', status: 'error' });
    expect(activityFromEvent({ type: 'account:status', accountId: 4, status: 'active' })).toBeNull();
  });

  it('与活动中心无关的事件返回 null', () => {
    expect(
      activityFromEvent({ type: 'message:new', accountId: 1, folderId: 2, messageIds: [9] }),
    ).toBeNull();
  });
});
