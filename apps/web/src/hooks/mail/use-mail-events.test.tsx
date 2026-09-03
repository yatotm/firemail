import type { Folder, MessageSummary, ServerEvent } from '@firemail/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useMailEvents } from '@/hooks/mail/use-mail-events';
import { ServerEventsContext } from '@/hooks/use-server-events';
import { allMessages, type MessagePages } from '@/lib/mail/cache';
import { mailKeys } from '@/lib/mail/keys';
import { ALL_SCOPE, type MailView } from '@/lib/nav';

/**
 * SSE 对账（interactions.md §5）。
 *
 * `message:flags` / `message:moved` 直接改缓存（不改变行位置的那部分立刻生效），
 * `message:new` 只累加横幅计数 —— 正在阅读或正在扫描的内容，位置绝不能变。
 */

const INBOX = 10;
const ARCHIVE = 11;

function message(id: number, overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    accountId: 1,
    folderId: INBOX,
    uid: id,
    messageId: null,
    threadId: null,
    subject: null,
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
    ...overrides,
  };
}

const FOLDERS: Folder[] = [
  folder(INBOX, 'inbox'),
  folder(ARCHIVE, 'archive'),
];

function folder(id: number, specialUse: Folder['specialUse']): Folder {
  return {
    id,
    accountId: 1,
    path: String(specialUse),
    name: String(specialUse),
    delimiter: '/',
    specialUse,
    subscribed: true,
    totalCount: 0,
    unreadCount: 0,
    lastSyncedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

interface Harness {
  client: QueryClient;
  emit: (event: ServerEvent) => void;
  result: { current: ReturnType<typeof useMailEvents> };
  listKey: readonly unknown[];
}

function setup(
  view: MailView,
  items: MessageSummary[],
  options: { canAutoInsert?: boolean } = {},
): Harness {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const listKey = mailKeys.list(ALL_SCOPE, view, {});
  const data: MessagePages = {
    pages: [
      {
        items,
        page: { total: items.length, limit: 50, offset: 0, hasMore: false, nextCursor: null },
      },
    ],
    pageParams: [0],
  };
  client.setQueryData(listKey, data);

  const handlers = new Set<(event: ServerEvent) => void>();
  const value = {
    status: 'open' as const,
    syncingAccountIds: new Set<number>(),
    subscribe: (handler: (event: ServerEvent) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ServerEventsContext value={value}>{children}</ServerEventsContext>
    </QueryClientProvider>
  );

  const rendered = renderHook(
    () =>
      useMailEvents({
        scope: ALL_SCOPE,
        view,
        filters: {},
        folders: FOLDERS,
        canAutoInsert: () => options.canAutoInsert ?? false,
      }),
    { wrapper },
  );

  return {
    client,
    listKey,
    result: rendered.result,
    emit: (event) => {
      act(() => {
        for (const handler of handlers) handler(event);
      });
    },
  };
}

function items(harness: Harness): MessageSummary[] {
  return allMessages(harness.client.getQueryData<MessagePages>(harness.listKey));
}

describe('message:flags', () => {
  it('把服务端的既成事实盖到列表缓存上（另一个标签页改的也能对齐）', () => {
    const harness = setup('inbox', [message(1), message(2)]);

    harness.emit({ type: 'message:flags', messageIds: [1], patch: { isRead: true } });

    expect(items(harness)[0]?.isRead).toBe(true);
    expect(items(harness)[1]?.isRead).toBe(false);
  });

  it('同时更新详情缓存，阅读区的星标图标不会和列表打架', () => {
    const harness = setup('inbox', [message(1)]);
    harness.client.setQueryData(mailKeys.detail(1), { ...message(1), isStarred: false });

    harness.emit({ type: 'message:flags', messageIds: [1], patch: { isStarred: true } });

    expect(harness.client.getQueryData<MessageSummary>(mailKeys.detail(1))?.isStarred).toBe(true);
  });

  it('重复收到同一条事件是幂等的（乐观更新之后服务端会把它再广播回来）', () => {
    const harness = setup('inbox', [message(1)]);
    const event: ServerEvent = { type: 'message:flags', messageIds: [1], patch: { isRead: true } };

    harness.emit(event);
    harness.emit(event);

    expect(items(harness).filter((item) => item.isRead)).toHaveLength(1);
  });
});

describe('message:moved', () => {
  it('移出当前文件夹 → 行消失', () => {
    const harness = setup('inbox', [message(1), message(2)]);

    harness.emit({
      type: 'message:moved',
      messageIds: [1],
      fromFolderId: INBOX,
      toFolderId: ARCHIVE,
    });

    expect(items(harness).map((item) => item.id)).toEqual([2]);
  });

  it('移进当前文件夹 → 行留下并更新 folderId', () => {
    const harness = setup('archive', [message(1, { folderId: ARCHIVE })]);

    harness.emit({
      type: 'message:moved',
      messageIds: [1],
      fromFolderId: INBOX,
      toFolderId: ARCHIVE,
    });

    expect(items(harness).map((item) => item.id)).toEqual([1]);
    expect(items(harness)[0]?.folderId).toBe(ARCHIVE);
  });

  it('智能视图不按文件夹取，移动不该把行弄丢', () => {
    const harness = setup('unread', [message(1)]);

    harness.emit({
      type: 'message:moved',
      messageIds: [1],
      fromFolderId: INBOX,
      toFolderId: ARCHIVE,
    });

    expect(items(harness).map((item) => item.id)).toEqual([1]);
    expect(items(harness)[0]?.folderId).toBe(ARCHIVE);
  });
});

describe('message:new', () => {
  it('正在阅读时不插入，只累加横幅计数', () => {
    const harness = setup('inbox', [message(1)], { canAutoInsert: false });

    harness.emit({ type: 'message:new', accountId: 1, folderId: INBOX, messageIds: [7, 8] });

    expect(harness.result.current.pendingCount).toBe(2);
    expect(items(harness).map((item) => item.id)).toEqual([1]);
  });

  it('服务端合并突发时同一批 id 不会被重复计数', () => {
    const harness = setup('inbox', [message(1)]);

    harness.emit({ type: 'message:new', accountId: 1, folderId: INBOX, messageIds: [7, 8] });
    harness.emit({ type: 'message:new', accountId: 1, folderId: INBOX, messageIds: [8, 9] });

    expect(harness.result.current.pendingCount).toBe(3);
  });

  it('在顶部且没有勾选、没有打开邮件时直接刷新列表', () => {
    const harness = setup('inbox', [message(1)], { canAutoInsert: true });
    const invalidate = vi.spyOn(harness.client, 'invalidateQueries');

    harness.emit({ type: 'message:new', accountId: 1, folderId: INBOX, messageIds: [7] });

    expect(harness.result.current.pendingCount).toBe(0);
    expect(invalidate).toHaveBeenCalled();
  });

  it('点横幅后计数清零', () => {
    const harness = setup('inbox', [message(1)]);
    harness.emit({ type: 'message:new', accountId: 1, folderId: INBOX, messageIds: [7] });

    act(() => {
      harness.result.current.flushPending();
    });

    expect(harness.result.current.pendingCount).toBe(0);
  });
});
