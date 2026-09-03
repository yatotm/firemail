import type { Account } from '@firemail/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountActions } from '@/hooks/accounts/use-account-actions';
import { ActivityContext, type ActivityContextValue } from '@/hooks/use-activity';
import { useSyncScope } from '@/hooks/use-sync';
import { ALL_SCOPE } from '@/lib/nav';

/**
 * 同步的分层契约（apps/server/src/sync/scheduler.ts）：
 *  - 多账号 = 第 2 层 `POST /accounts/sync`，**一次**请求，会抢占后台基线；
 *  - 单账号 = 第 3 层 `POST /accounts/:id/sync`，插队跑。
 *
 * 这一层只回 202，没有逐账号结果可言，所以测试盯的是三件事：
 * 请求发了几个、点击有没有立刻产生「进行中」、以及**不会有账号卡在进行中**。
 */

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn(), success: vi.fn() }),
}));

function account(id: number, overrides: Partial<Account> = {}): Account {
  return {
    id,
    userId: 1,
    email: `a${String(id)}@outlook.com`,
    displayName: null,
    provider: 'outlook',
    authType: 'oauth2',
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
    hasPassword: false,
    hasOAuthToken: true,
    oauthClientId: null,
    oauthTokenExpiresAt: null,
    oauthScope: null,
    status: 'active',
    lastError: null,
    lastErrorAt: null,
    smtpStatus: 'unknown',
    smtpError: null,
    smtpCheckedAt: null,
    syncEnabled: true,
    syncIntervalSeconds: 300,
    lastSyncedAt: null,
    unreadCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 活动记录与网络请求写进同一条时间线，才能断言「begin 在请求之前」。 */
let timeline: string[] = [];

const activity: ActivityContextValue = {
  entries: [],
  pending: 0,
  connected: true,
  begin: (kind, accountId) => timeline.push(`begin:${kind}:${String(accountId)}`),
  settle: (kind, accountId, status, detail) =>
    timeline.push(`settle:${kind}:${String(accountId)}:${status}:${detail ?? ''}`),
  clear: () => undefined,
};

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

function jsonResponse(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function respond(body: unknown, status = 202): void {
  fetchMock.mockImplementation((input) => {
    timeline.push(`fetch:${urlOf(input)}`);
    return Promise.resolve(jsonResponse(body, status));
  });
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => urlOf(call[0]));
}

function bodyOf(call: number): { accountIds?: number[] } {
  const raw = fetchMock.mock.calls[call]?.[1]?.body;
  return JSON.parse(typeof raw === 'string' ? raw : '{}') as { accountIds?: number[] };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <ActivityContext value={activity}>{children}</ActivityContext>
    </QueryClientProvider>
  );
}

function setup() {
  return renderHook(() => useAccountActions(), { wrapper });
}

beforeEach(() => {
  timeline = [];
  fetchMock = vi.fn<FetchFn>();
  respond({ ok: true, data: { accountIds: [], status: 'started' } });
  vi.stubGlobal('fetch', fetchMock);
});

describe('多账号同步走第 2 层', () => {
  it('一次批量请求，而不是 N 个单账号请求', async () => {
    respond({ ok: true, data: { accountIds: [1, 2, 3], status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(1), account(2), account(3)]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(requestedUrls()).toEqual(['/api/accounts/sync']);
    expect(bodyOf(0)).toEqual({ accountIds: [1, 2, 3] });
  });

  it('请求发出之前，每个目标都已经有一条「进行中」', async () => {
    respond({ ok: true, data: { accountIds: [1, 2], status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(1), account(2)]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(timeline.slice(0, 3)).toEqual([
      'begin:sync:1',
      'begin:sync:2',
      'fetch:/api/accounts/sync',
    ]);
  });

  it('请求本身失败时，整批就地落定成 error（SSE 不会再管它们）', async () => {
    respond({ ok: false, error: { code: 'internal_error', message: '调度器起不来' } }, 500);
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(1), account(2)]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('同步请求失败', expect.anything());
    });
    expect(timeline).toContain('settle:sync:1:error:调度器起不来');
    expect(timeline).toContain('settle:sync:2:error:调度器起不来');
  });

  it('服务端没接受的账号既落定成 error，也不算进「已请求同步」', async () => {
    respond({ ok: true, data: { accountIds: [1], status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(1), account(2)]);
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith('已请求同步 1 个账号（1 个未被服务端接受）', expect.anything());
    });
    expect(timeline).toContain('settle:sync:2:error:服务端没有接受这个账号，同步没有开始');
    expect(timeline).not.toContain('settle:sync:1:error:服务端没有接受这个账号，同步没有开始');
  });

  it('一个都没被接受时按失败报，不谎称同步已开始', async () => {
    respond({ ok: true, data: { accountIds: [], status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(1), account(2)]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('没有账号进入同步', expect.anything());
    });
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('已请求同步'), expect.anything());
  });

  it('停用的账号不进批量请求：第 2 层会跳过它们，否则记录永远转圈', async () => {
    respond({ ok: true, data: { accountIds: [1, 3], status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(1), account(2, { status: 'disabled' }), account(3)]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(0)).toEqual({ accountIds: [1, 3] });
    expect(timeline).not.toContain('begin:sync:2');
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        '已请求同步 2 个账号（1 个已停用未同步）',
        expect.anything(),
      );
    });
  });
});

describe('单账号同步留在第 3 层', () => {
  it('打的是 /accounts/:id/sync', async () => {
    respond({ ok: true, data: { accountId: 7, status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(7)]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(requestedUrls()).toEqual(['/api/accounts/7/sync']);
    expect(timeline[0]).toBe('begin:sync:7');
  });

  it('停用的账号照发：第 3 层不看状态', async () => {
    respond({ ok: true, data: { accountId: 7, status: 'started' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(7, { status: 'disabled' })]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(requestedUrls()).toEqual(['/api/accounts/7/sync']);
  });

  it('already_running 只在这一层出现，文案照实说', async () => {
    respond({ ok: true, data: { accountId: 7, status: 'already_running' } });
    const view = setup();

    act(() => {
      view.result.current.syncNow([account(7)]);
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith('这个账号本来就在同步中', expect.anything());
    });
  });
});

describe('空选择', () => {
  it('不发请求、不产生活动记录', async () => {
    const view = setup();

    act(() => {
      view.result.current.syncNow([]);
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith('没有可同步的账号', expect.anything());
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(timeline).toEqual([]);
  });

  it('选中的全是停用账号时也不发请求', async () => {
    const view = setup();

    act(() => {
      view.result.current.syncNow([
        account(1, { status: 'disabled' }),
        account(2, { status: 'disabled' }),
      ]);
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith('选中的账号都已停用', expect.anything());
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(timeline).toEqual([]);
  });
});

describe('顶栏 Shift+R（全部账号作用域）', () => {
  it('同样只发一次批量请求，停用账号不在其中', async () => {
    respond({ ok: true, data: { accountIds: [1, 3], status: 'started' } });
    const accounts = [account(1), account(2, { status: 'disabled' }), account(3)];
    const view = renderHook(() => useSyncScope(accounts, ALL_SCOPE), { wrapper });

    act(() => {
      view.result.current.mutate();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(requestedUrls()).toEqual(['/api/accounts/sync']);
    expect(bodyOf(0)).toEqual({ accountIds: [1, 3] });
  });
});
