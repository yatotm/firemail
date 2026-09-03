import type { Account, MessageSummary } from '@firemail/shared';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageList } from '@/components/mail/message-list';
import { buildRows } from '@/lib/mail/rows';

/** jsdom 里所有元素的 clientHeight 都是 0，虚拟滚动会算出 0 行；这里假装视口有 640px。 */
const VIEWPORT = 640;
let restore: (() => void) | null = null;

beforeAll(() => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  });
  restore = () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
  };
});

afterAll(() => restore?.());

const ACCOUNT: Account = {
  id: 1,
  userId: 1,
  email: 'a@outlook.com',
  displayName: null,
  provider: 'outlook',
  authType: 'oauth2',
  imapHost: null,
  imapPort: null,
  imapSecure: true,
  smtpHost: null,
  smtpPort: null,
  smtpSecure: true,
  smtpStatus: 'unknown' as const,
  smtpError: null,
  smtpCheckedAt: null,
  hasPassword: false,
  hasOAuthToken: true,
  oauthClientId: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
  status: 'active',
  lastError: null,
  lastErrorAt: null,
  syncEnabled: true,
  syncIntervalSeconds: 300,
  lastSyncedAt: null,
  unreadCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

function message(id: number, overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    accountId: 1,
    folderId: 10,
    uid: id,
    messageId: null,
    threadId: null,
    subject: `主题 ${String(id)}`,
    from: { name: `发件人 ${String(id)}`, address: 'x@y.com' },
    to: [],
    sentAt: 0,
    receivedAt: Date.now(),
    snippet: null,
    hasAttachments: false,
    size: null,
    isRead: true,
    isStarred: false,
    isAnswered: false,
    isDraft: false,
    isDeleted: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderList(messages: MessageSummary[], total = messages.length) {
  const containerRef = createRef<HTMLDivElement>();
  const onLoadMore = vi.fn();

  render(
    <MessageList
      rows={buildRows(messages)}
      messages={messages}
      accountsById={new Map([[1, ACCOUNT]])}
      density="cozy"
      activeId={messages[0]?.id ?? null}
      selected={new Set()}
      selectionMode={false}
      label="全部收件箱 · 全部账号"
      total={total}
      hasMore={false}
      loadingMore={false}
      busy={false}
      containerRef={containerRef}
      onOpen={vi.fn()}
      onToggleCheck={vi.fn()}
      onLoadMore={onLoadMore}
    />,
  );

  return { onLoadMore };
}

describe('虚拟滚动', () => {
  it('一万封邮件只渲染视口内的几十行', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) => message(index + 1));
    renderList(messages);

    const rendered = screen.getAllByRole('option');
    expect(rendered.length).toBeGreaterThan(0);
    // 640px 视口 / 64px 行高 ≈ 10 行，加 overscan 也远小于 60
    expect(rendered.length).toBeLessThan(60);
  });

  it('渲染的是最靠前的那些行', () => {
    renderList(Array.from({ length: 500 }, (_, index) => message(index + 1)));
    expect(screen.getByText('主题 1')).toBeInTheDocument();
    expect(screen.queryByText('主题 400')).not.toBeInTheDocument();
  });
});

describe('listbox 语义', () => {
  it('列表整体只占一个 Tab 停靠点', () => {
    renderList([message(1), message(2)]);
    const list = screen.getByRole('listbox');
    expect(list).toHaveAttribute('tabindex', '0');
    for (const option of screen.getAllByRole('option')) {
      expect(option).toHaveAttribute('tabindex', '-1');
    }
  });

  it('aria-activedescendant 指向当前打开的那一封', () => {
    renderList([message(1), message(2)]);
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'msg-1');
  });

  it('虚拟滚动下仍然播报「第几封 / 共几封」', () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index + 1));
    renderList(messages, 1240);

    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveAttribute('aria-posinset', '1');
    expect(first).toHaveAttribute('aria-setsize', '1240');
  });

  it('行的 aria-label 是一句人话，含未读、发件人、主题与账号', () => {
    renderList([message(1, { isRead: false, hasAttachments: true, subject: '安全提醒' })]);
    const label = screen.getAllByRole('option')[0]?.getAttribute('aria-label') ?? '';
    expect(label).toContain('未读');
    expect(label).toContain('来自 发件人 1');
    expect(label).toContain('主题 安全提醒');
    expect(label).toContain('有附件');
    expect(label).toContain('账号 a@outlook.com');
  });
});

describe('底部状态', () => {
  it('永远告诉用户加载到哪了，而不是一片空白', () => {
    renderList(Array.from({ length: 20 }, (_, index) => message(index + 1)), 124);
    expect(screen.getByText(/124 封 · 已加载 20/)).toBeInTheDocument();
    expect(screen.getByText('已到底')).toBeInTheDocument();
  });

  it('服务端放弃精确计数时显示 20+ 而不是编一个数字', () => {
    render(
      <MessageList
        rows={buildRows([message(1)])}
        messages={[message(1)]}
        accountsById={new Map([[1, ACCOUNT]])}
        density="compact"
        activeId={null}
        selected={new Set()}
        selectionMode={false}
        label="搜索结果"
        total={null}
        hasMore
        loadingMore={false}
        busy={false}
        containerRef={createRef<HTMLDivElement>()}
        onOpen={vi.fn()}
        onToggleCheck={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/1\+ 封 · 已加载 1/)).toBeInTheDocument();
  });
});

describe('验证码', () => {
  it('列表行里直接把验证码提出来，扫一眼就能看到', () => {
    renderList([message(1, { subject: '验证码', snippet: '您的验证码是 738214' })]);
    expect(screen.getByTitle('复制验证码 738214')).toBeInTheDocument();
  });
});
