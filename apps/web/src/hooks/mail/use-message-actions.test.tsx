import type { Folder, MessageSummary, Summary } from '@firemail/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageActions } from '@/hooks/mail/use-message-actions';
import { allMessages, type MessagePages } from '@/lib/mail/cache';
import { mailKeys } from '@/lib/mail/keys';
import { queryKeys } from '@/lib/query-keys';
import { ALL_SCOPE } from '@/lib/nav';

/**
 * 乐观更新的两条铁律（interactions.md §4）：
 *  - 成功：先本地生效，服务端确认后给一条可撤销的 toast；
 *  - 失败：**整体回滚**，并把具体原因告诉用户。
 */

const INBOX = 10;
const ARCHIVE = 11;

function message(id: number): MessageSummary {
  return {
    id,
    accountId: 1,
    folderId: INBOX,
    uid: id,
    messageId: null,
    threadId: null,
    subject: `主题 ${String(id)}`,
    from: null,
    to: [],
    sentAt: 0,
    receivedAt: 0,
    snippet: null,
    hasAttachments: false,
    size: null,
    isRead: false,
    isStarred: false,
    isAnswered: false,
    isDraft: false,
    isDeleted: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function starred(id: number, isStarred: boolean): MessageSummary {
  return { ...message(id), isStarred };
}

const FOLDERS: Folder[] = [
  {
    id: INBOX,
    accountId: 1,
    path: 'INBOX',
    name: '收件箱',
    delimiter: '/',
    specialUse: 'inbox',
    subscribed: true,
    totalCount: 0,
    unreadCount: 0,
    lastSyncedAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: ARCHIVE,
    accountId: 1,
    path: 'Archive',
    name: '归档',
    delimiter: '/',
    specialUse: 'archive',
    subscribed: true,
    totalCount: 0,
    unreadCount: 0,
    lastSyncedAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
];

const SUMMARY: Summary = {
  scopes: { all: counts(3), '1': counts(3) },
  byView: counts(3),
  health: { active: 1, auth_error: 0, error: 0, disabled: 0 },
  accounts: 1,
  generatedAt: 0,
};

function counts(unread: number) {
  return {
    inbox: 3,
    unread,
    starred: 0,
    codes: 0,
    attachments: 0,
    sent: 0,
    drafts: 0,
    archive: 0,
    junk: 0,
    trash: 0,
    notes: 0,
    outbox: 0,
  };
}

const LIST_KEY = mailKeys.list(ALL_SCOPE, 'inbox', {});

function seed(client: QueryClient, items: MessageSummary[]): void {
  const data: MessagePages = {
    pages: [
      {
        items,
        page: { total: items.length, limit: 50, offset: 0, hasMore: false, nextCursor: null },
      },
    ],
    pageParams: [0],
  };
  client.setQueryData(LIST_KEY, data);
  client.setQueryData(queryKeys.summary, SUMMARY);
}

function setup(items: MessageSummary[], onFocusNext?: (id: number | null) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  seed(client, items);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  const view = renderHook(
    () =>
      useMessageActions({
        scope: ALL_SCOPE,
        view: 'inbox',
        folders: FOLDERS,
        currentMessageId: 1,
        ordered: items,
        ...(onFocusNext ? { onFocusNext } : {}),
      }),
    { wrapper },
  );

  return { client, view };
}

function listItems(client: QueryClient): MessageSummary[] {
  return allMessages(client.getQueryData<MessagePages>(LIST_KEY));
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

/** 第 n 次请求的 JSON body。 */
function bodyOf(call: number): { ids?: number[]; action?: string; targetFolderId?: number } {
  const raw = fetchMock.mock.calls[call]?.[1]?.body;
  return JSON.parse(typeof raw === 'string' ? raw : '{}') as {
    ids?: number[];
    action?: string;
    targetFolderId?: number;
  };
}

beforeEach(() => {
  fetchMock = vi.fn<FetchFn>(
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(JSON.stringify({ ok: true, data: { updated: [1], failed: [] } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }, 0);
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

describe('标记已读 / 星标', () => {
  it('立刻本地生效，不等服务端', async () => {
    const { client, view } = setup([message(1), message(2)]);

    act(() => {
      view.result.current.toggleRead([message(1)]);
    });

    expect(listItems(client)[0]?.isRead).toBe(true);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('未读计数同步扣减，避免「列表已读但侧栏还是 3」', async () => {
    const { client, view } = setup([message(1), message(2), message(3)]);

    act(() => {
      view.result.current.toggleRead([message(1), message(2)]);
    });

    expect(client.getQueryData<Summary>(queryKeys.summary)?.byView.unread).toBe(1);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

describe('归档', () => {
  it('把行从当前列表里摘掉，并按账号找到各自的归档目录', async () => {
    const { client, view } = setup([message(1), message(2)]);

    act(() => {
      view.result.current.archive([message(1)]);
    });

    expect(listItems(client).map((item) => item.id)).toEqual([2]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(bodyOf(0)).toMatchObject({ action: 'move', targetFolderId: ARCHIVE, ids: [1] });
  });

  it('归档当前打开的那封时把焦点交给下一封，而不是让阅读区变空', () => {
    const onFocusNext = vi.fn();
    const { view } = setup([message(1), message(2)], onFocusNext);

    act(() => {
      view.result.current.archive([message(1)]);
    });

    expect(onFocusNext).toHaveBeenCalledWith(2);
  });
});

describe('失败回滚', () => {
  it('服务端报错时列表与计数整体还原', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error: { code: 'upstream_error', message: 'IMAP 连接失败' } }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { client, view } = setup([message(1), message(2)]);

    act(() => {
      view.result.current.archive([message(1)]);
    });
    // 乐观阶段：行已经消失
    expect(listItems(client).map((item) => item.id)).toEqual([2]);

    await waitFor(() => {
      expect(listItems(client).map((item) => item.id)).toEqual([1, 2]);
    });
    expect(client.getQueryData<Summary>(queryKeys.summary)?.byView.unread).toBe(3);
  });

  it('标记失败也整体还原', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: { code: 'internal_error', message: '炸了' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const { client, view } = setup([starred(1, false)]);

    act(() => {
      view.result.current.toggleStar([starred(1, false)]);
    });
    expect(listItems(client)[0]?.isStarred).toBe(true);

    await waitFor(() => {
      expect(listItems(client)[0]?.isStarred).toBe(false);
    });
  });
});

describe('部分失败（服务器先行，写回 IMAP 可能只成一半）', () => {
  it('一封都没成功时按失败处理并整体回滚 —— 200 不等于生效', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            data: { updated: [], failed: [{ id: 1, error: '账号 1 缺少 oauth_client_id' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { client, view } = setup([message(1), message(2)]);

    act(() => {
      view.result.current.archive([message(1)]);
    });
    expect(listItems(client).map((item) => item.id)).toEqual([2]);

    await waitFor(() => {
      expect(listItems(client).map((item) => item.id)).toEqual([1, 2]);
    });
  });

  it('部分成功时保留已生效的部分，不整体回滚', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            data: { updated: [1], failed: [{ id: 2, error: '账号 2 授权失效' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { client, view } = setup([message(1), message(2), message(3)]);

    act(() => {
      view.result.current.archive([message(1), message(2)]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(listItems(client).map((item) => item.id)).toEqual([3]);
  });
});

describe('批量上限', () => {
  it('超过 500 封时分批发送，而不是报错', async () => {
    const many = Array.from({ length: 501 }, (_, index) => message(index + 1));
    const { view } = setup(many);

    act(() => {
      view.result.current.toggleRead(many);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(bodyOf(0).ids).toHaveLength(500);
    expect(bodyOf(1).ids).toHaveLength(1);
  });
});
