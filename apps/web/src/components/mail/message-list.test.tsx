import type { Account, MessageSummary } from '@firemail/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

/**
 * 日期分组头必须一直钉在列表顶部，并在滚进下一天时就地换成那一天。
 *
 * 原来的实现是给行内的头加 `position: sticky`，两处都不成立：
 * 滚过去的头会被虚拟滚动从 DOM 里卸载（顶部于是空了），
 * 而且所有行共享同一个 transform 容器，sticky 只会让两个头重叠、不会互推。
 */
describe('日期分组头', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** 每组 20 封：组高 24 + 20×64 = 1304，滚进组内足够深时组头会被卸载。 */
  const PER_GROUP = 20;
  const NOW = new Date('2026-03-18T12:00:00Z').getTime();

  function grouped() {
    return [0, 1, 2].flatMap((day) =>
      Array.from({ length: PER_GROUP }, (_, n) =>
        message(day * PER_GROUP + n + 1, { receivedAt: NOW - day * DAY }),
      ),
    );
  }

  function renderGrouped(messages = grouped()) {
    const containerRef = createRef<HTMLDivElement>();
    render(
      <MessageList
        rows={buildRows(messages, { now: NOW })}
        messages={messages}
        accountsById={new Map([[1, ACCOUNT]])}
        density="cozy"
        activeId={null}
        selected={new Set()}
        selectionMode={false}
        label="收件箱"
        total={messages.length}
        hasMore={false}
        loadingMore={false}
        busy={false}
        containerRef={containerRef}
        onOpen={vi.fn()}
        onToggleCheck={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );
    return containerRef;
  }

  /** 滚动后要等一帧：虚拟滚动把 scrollTop 的读取放在 requestAnimationFrame 里。 */
  async function scrollTo(container: HTMLDivElement, top: number) {
    await act(async () => {
      container.scrollTop = top;
      fireEvent.scroll(container);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  const pinned = () => screen.getByTestId('pinned-group-header').textContent;

  it('列表顶部就钉着第一组', () => {
    renderGrouped();
    expect(pinned()).toBe('今天');
  });

  it('钉住的那一个在行内被藏起来，不会两层毛玻璃叠出一道深边', () => {
    renderGrouped();
    const inline = screen.getAllByText('今天').find((el) => el.dataset.testid === undefined);
    expect(inline).toHaveStyle({ visibility: 'hidden' });
  });

  it('滚进第二天，钉住的就地换成第二天', async () => {
    const ref = renderGrouped();
    await scrollTo(ref.current!, 1304);
    expect(pinned()).toBe('昨天');
  });

  // 这条是原来那个 bug 的回归用例：滚到这里时第二组的组头早已不在 DOM 里
  it('滚到组内很深处、组头已被虚拟滚动卸载时，顶部仍然钉着这一组', async () => {
    const ref = renderGrouped();
    await scrollTo(ref.current!, 2000);

    const inlineHeaders = screen.getAllByText(/今天|昨天/).filter((el) => el.dataset.testid === undefined);
    expect(inlineHeaders).toHaveLength(0);
    expect(pinned()).toBe('昨天');
  });

  it('下一组的头顶上来时，当前这个被推出去', async () => {
    const ref = renderGrouped();
    // 第二组的头在 1304，滚到 1292 时它离顶部还有 12px，正好推走半个头
    await scrollTo(ref.current!, 1292);
    expect(pinned()).toBe('今天');
    expect(screen.getByTestId('pinned-group-header')).toHaveStyle({ transform: 'translateY(-12px)' });
  });

  it('未分组的列表（搜索按相关度排）不画悬浮头', () => {
    const messages = [message(1), message(2)];
    render(
      <MessageList
        rows={buildRows(messages, { grouped: false })}
        messages={messages}
        accountsById={new Map([[1, ACCOUNT]])}
        density="cozy"
        activeId={null}
        selected={new Set()}
        selectionMode={false}
        label="搜索结果"
        total={2}
        hasMore={false}
        loadingMore={false}
        busy={false}
        containerRef={createRef<HTMLDivElement>()}
        onOpen={vi.fn()}
        onToggleCheck={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pinned-group-header')).not.toBeInTheDocument();
  });
});
