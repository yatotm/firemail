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
      link: 'offline',
    });

    expect(entries[0]?.status).toBe('stale');
    expect(unresolvedCount(entries)).toBe(1);
  });

  it('转 stale 时写上 endedAt，否则这条记录永远等不到 TTL 清理', () => {
    const now = T0 + ACTIVITY_STALE_AFTER_MS + 1;
    const stale = tick([running()], { now, link: 'offline' });
    expect(stale[0]?.endedAt).toBe(now);

    // 一直断着也不能让角标永远亮着
    const aged = tick(stale, { now: now + ACTIVITY_TTL_MS + 1, link: 'offline' });
    expect(aged).toEqual([]);
    expect(unresolvedCount(aged)).toBe(0);
  });

  it('连接恢复后清掉 stale 记录 —— 重连时已经全量刷过，真实状态就在页面上', () => {
    const stale = tick([running()], { now: T0 + ACTIVITY_STALE_AFTER_MS + 1, link: 'offline' });
    expect(stale[0]?.status).toBe('stale');

    const recovered = tick(stale, { now: T0 + ACTIVITY_STALE_AFTER_MS + 2, link: 'online' });
    expect(recovered).toEqual([]);
    expect(unresolvedCount(recovered)).toBe(0);
  });

  it('SSE 连着的时候不标 stale —— 事件迟早会来', () => {
    const entries = tick([running()], { now: T0 + 10 * ACTIVITY_STALE_AFTER_MS, link: 'online' });
    expect(entries[0]?.status).toBe('running');
  });

  it('刚发起、还没超过阈值的不标 stale', () => {
    const entries = tick([running()], { now: T0 + ACTIVITY_STALE_AFTER_MS - 1, link: 'offline' });
    expect(entries[0]?.status).toBe('running');
  });

  it('宽限期内的重连（connecting）不标 stale —— 一秒的抖动不是「状态未知」', () => {
    const entries = tick([running()], {
      now: T0 + ACTIVITY_STALE_AFTER_MS + 1,
      link: 'connecting',
    });
    expect(entries[0]?.status).toBe('running');
  });

  it('connecting 也不清 stale —— 只有真的连上才算真相回来了', () => {
    const stale = tick([running()], { now: T0 + ACTIVITY_STALE_AFTER_MS + 1, link: 'offline' });
    const during = tick(stale, { now: T0 + ACTIVITY_STALE_AFTER_MS + 2, link: 'connecting' });
    expect(during[0]?.status).toBe('stale');
  });

  it('完成很久的记录会被清掉，活动中心不是日志系统', () => {
    const done = running({ status: 'success', endedAt: T0 });
    expect(tick([done], { now: T0 + ACTIVITY_TTL_MS + 1, link: 'online' })).toEqual([]);
    expect(tick([done], { now: T0 + ACTIVITY_TTL_MS - 1, link: 'online' })).toHaveLength(1);
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

  /**
   * 第一级后台基线是常驻的，把它记进来角标就永远亮着「进行中」，
   * 图标也永远是个转圈——那时候转圈已经不指示任何东西了。
   */
  describe('第一级后台基线不进活动中心', () => {
    it.each(['sync:start', 'sync:done', 'sync:error'] as const)('%s 带 background 时返回 null', (type) => {
      const event =
        type === 'sync:done'
          ? { type, accountId: 3, newMessages: 5, tier: 'background' as const }
          : type === 'sync:error'
            ? { type, accountId: 3, message: '连不上', tier: 'background' as const }
            : { type, accountId: 3, tier: 'background' as const };
      expect(activityFromEvent(event)).toBeNull();
    });

    it.each(['bulk', 'interactive'] as const)('用户发起的 %s 照常记录', (tier) => {
      expect(activityFromEvent({ type: 'sync:start', accountId: 3, tier })).not.toBeNull();
      expect(
        activityFromEvent({ type: 'sync:done', accountId: 3, newMessages: 1, tier }),
      ).toMatchObject({ status: 'success' });
      expect(
        activityFromEvent({ type: 'sync:error', accountId: 3, message: '超时', tier }),
      ).toMatchObject({ status: 'error' });
    });

    it('不带 tier 的事件按「用户发起」处理，宁可多显示也不要漏掉用户点的那一下', () => {
      expect(activityFromEvent({ type: 'sync:start', accountId: 3 })).not.toBeNull();
    });

    it('后台同步把账号弄挂了仍然到得了用户眼前——那走的是 account:status', () => {
      expect(activityFromEvent({ type: 'account:status', accountId: 3, status: 'auth_error' })).
        toMatchObject({ kind: 'reauth', status: 'error' });
    });
  });
});
