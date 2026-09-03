import type { Folder, MessageSummary, Summary } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import {
  allMessages,
  dropMessages,
  nextFocusId,
  patchFlags,
  patchSummaryCounts,
  reconcileMoved,
  visibleFolderIds,
  type MessagePages,
} from '@/lib/mail/cache';

function message(id: number, overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    accountId: 1,
    folderId: 10,
    uid: id,
    messageId: `m${String(id)}`,
    threadId: null,
    subject: `主题 ${String(id)}`,
    from: { name: null, address: 'a@x.com' },
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

function pages(...items: MessageSummary[][]): MessagePages {
  return {
    pages: items.map((chunk, index) => ({
      items: chunk,
      page: { total: 100, limit: 50, offset: index * 50, hasMore: false, nextCursor: null },
    })),
    pageParams: items.map((_, index) => index * 50),
  };
}

function folder(id: number, accountId: number, specialUse: Folder['specialUse']): Folder {
  return {
    id,
    accountId,
    path: 'INBOX',
    name: 'INBOX',
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

describe('patchFlags', () => {
  it('只改命中的行，其余保持同一个引用（避免整列表重渲染）', () => {
    const untouched = message(2);
    const data = pages([message(1), untouched]);
    const next = patchFlags(data, new Set([1]), { isRead: true });

    expect(next?.pages[0]?.items[0]?.isRead).toBe(true);
    expect(next?.pages[0]?.items[1]).toBe(untouched);
  });

  it('跨页生效', () => {
    const data = pages([message(1)], [message(2)]);
    const next = patchFlags(data, new Set([1, 2]), { isStarred: true });
    expect(allMessages(next).every((item) => item.isStarred)).toBe(true);
  });

  it('空集合是恒等操作', () => {
    const data = pages([message(1)]);
    expect(patchFlags(data, new Set(), { isRead: true })).toBe(data);
  });

  it('undefined 缓存不炸', () => {
    expect(patchFlags(undefined, new Set([1]), { isRead: true })).toBeUndefined();
  });
});

describe('dropMessages', () => {
  it('把行摘掉', () => {
    const next = dropMessages(pages([message(1), message(2)]), new Set([1]));
    expect(allMessages(next).map((item) => item.id)).toEqual([2]);
  });
});

describe('reconcileMoved —— message:moved 的对账', () => {
  const folders = [folder(10, 1, 'inbox'), folder(11, 1, 'archive'), folder(20, 2, 'inbox')];

  it('目标文件夹不在当前视图里 → 摘掉行', () => {
    const visible = visibleFolderIds(folders, { kind: 'all' }, 'inbox');
    const next = reconcileMoved(pages([message(1), message(2)]), new Set([1]), 11, visible);
    expect(allMessages(next).map((item) => item.id)).toEqual([2]);
  });

  it('目标文件夹还在当前视图里 → 只更新 folderId', () => {
    const visible = visibleFolderIds(folders, { kind: 'all' }, 'inbox');
    const next = reconcileMoved(pages([message(1)]), new Set([1]), 20, visible);
    expect(allMessages(next)[0]?.folderId).toBe(20);
  });

  it('智能视图（不按文件夹取）永远不删行：未读的信移到归档后仍然是未读', () => {
    const visible = visibleFolderIds(folders, { kind: 'all' }, 'unread');
    expect(visible).toBeNull();
    const next = reconcileMoved(pages([message(1)]), new Set([1]), 11, visible);
    expect(allMessages(next).map((item) => item.id)).toEqual([1]);
    expect(allMessages(next)[0]?.folderId).toBe(11);
  });

  it('单账号作用域下只认这个账号的收件箱', () => {
    const visible = visibleFolderIds(folders, { kind: 'account', accountId: 1 }, 'inbox');
    expect([...(visible ?? [])]).toEqual([10]);
  });

  it('自定义文件夹视图 f<id> 只认那一个目录', () => {
    expect([...(visibleFolderIds(folders, { kind: 'all' }, 'f42') ?? [])]).toEqual([42]);
  });
});

describe('nextFocusId —— 归档/删除后焦点顺延', () => {
  const list = [message(1), message(2), message(3)];

  it('删掉当前行时落到下一封', () => {
    expect(nextFocusId(list, new Set([2]), 2)).toBe(3);
  });

  it('删掉最后一封时落到上一封', () => {
    expect(nextFocusId(list, new Set([3]), 3)).toBe(2);
  });

  it('批量删除时跳过同样被删的行', () => {
    expect(nextFocusId(list, new Set([2, 3]), 2)).toBe(1);
  });

  it('全删光时返回 null（阅读区回空态）', () => {
    expect(nextFocusId(list, new Set([1, 2, 3]), 2)).toBeNull();
  });

  it('当前行没被删就不动焦点', () => {
    expect(nextFocusId(list, new Set([1]), 3)).toBe(3);
  });
});

describe('patchSummaryCounts —— 侧栏计数跟着列表一起动', () => {
  const summary: Summary = {
    scopes: {
      all: counts({ inbox: 10, unread: 5 }),
      '1': counts({ inbox: 4, unread: 2 }),
      '2': counts({ inbox: 6, unread: 3 }),
    },
    byView: counts({ inbox: 10, unread: 5 }),
    health: { active: 2, auth_error: 0, error: 0, disabled: 0 },
    accounts: 2,
    generatedAt: 0,
  };

  it('同时更新 all 与涉及到的账号作用域', () => {
    const next = patchSummaryCounts(summary, { unread: -2 }, [1]);
    expect(next?.scopes.all?.unread).toBe(3);
    expect(next?.scopes['1']?.unread).toBe(0);
    expect(next?.scopes['2']?.unread).toBe(3);
  });

  it('byView 与 scopes.all 保持同一份', () => {
    const next = patchSummaryCounts(summary, { unread: -1 }, [1]);
    expect(next?.byView).toBe(next?.scopes.all);
  });

  it('不会减到负数', () => {
    const next = patchSummaryCounts(summary, { unread: -99 }, [1]);
    expect(next?.scopes.all?.unread).toBe(0);
  });
});

function counts(overrides: Partial<Summary['byView']>): Summary['byView'] {
  return {
    inbox: 0,
    unread: 0,
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
    ...overrides,
  };
}
