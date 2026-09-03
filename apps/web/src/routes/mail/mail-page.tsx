import type { Account, MessageSummary } from '@firemail/shared';
import {
  ArchiveIcon,
  CopyIcon,
  CornerUpLeftIcon,
  FolderInputIcon,
  MailPlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ErrorBanner } from '@/components/common/error-state';
import { ListSkeleton } from '@/components/common/skeletons';
import { ComposeWindow } from '@/components/compose/compose-window';
import { BulkActionBar } from '@/components/mail/bulk-action-bar';
import { ListEmptyState } from '@/components/mail/list-empty-state';
import { ListToolbar } from '@/components/mail/list-toolbar';
import { MessageList, type MessageListControls } from '@/components/mail/message-list';
import { MoveToDialog } from '@/components/mail/move-to-menu';
import { NewMailBanner } from '@/components/mail/new-mail-banner';
import { PaneDivider } from '@/components/mail/pane-divider';
import { ReadingPane } from '@/components/mail/reading-pane';
import { useAccounts } from '@/hooks/use-accounts';
import { useAnnouncer } from '@/hooks/use-announcer';
import { useRegisterCommands } from '@/hooks/use-commands';
import { useDensity } from '@/hooks/use-density';
import { useMailLocation } from '@/hooks/use-mail-location';
import { useIsMobileLayout } from '@/hooks/use-media-query';
import { useShortcuts, useShortcutScope } from '@/hooks/use-shortcuts';
import { useSummary, viewCount } from '@/hooks/use-summary';
import { useSyncScope } from '@/hooks/use-sync';
import { useComposeIntent } from '@/hooks/mail/use-compose';
import { useFolders } from '@/hooks/mail/use-folders';
import { useMailEvents } from '@/hooks/mail/use-mail-events';
import { useMailSelection } from '@/hooks/mail/use-mail-selection';
import { useMessageActions } from '@/hooks/mail/use-message-actions';
import { useMessageDetail, useMessageThread } from '@/hooks/mail/use-message-detail';
import { useMessageList } from '@/hooks/mail/use-messages';
import { useReadingSettings, shouldShowRemoteImages } from '@/hooks/mail/use-reading-settings';
import { copyOtp, copyText } from '@/lib/mail/clipboard';
import { effectiveDensity } from '@/lib/mail/density';
import { readListWidth } from '@/lib/mail/layout';
import { extractOtp } from '@/lib/mail/otp';
import {
  activeFilterLabels,
  filtersFromSearchParams,
  filtersToSearchParams,
  type MailFilters,
} from '@/lib/mail/query';
import { buildRows } from '@/lib/mail/rows';
import { mailPath, viewLabel } from '@/lib/nav';
import { readSessionNumber, writeSessionNumber } from '@/lib/storage';
import { showInfoToast } from '@/lib/undo';
import { cn } from '@/lib/utils';

/**
 * 主邮箱（screens.md §1）。
 *
 * 三栏里的后两栏在这里：列表 + 阅读区。侧栏、顶栏、命令面板都归外壳。
 * 导航状态（scope / view / messageId / 筛选 / compose）**全部在 URL 里**，
 * 刷新、后退、分享链接才都正确。
 */
export function MailPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { scope, view, messageId } = useMailLocation();
  const { density: preference, setDensity } = useDensity();
  const isMobile = useIsMobileLayout();
  const density = effectiveDensity(preference, isMobile);
  const { announce } = useAnnouncer();

  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);

  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsById = useMemo(
    () => new Map<number, Account>(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const foldersQuery = useFolders();
  const summaryQuery = useSummary();
  const settingsQuery = useReadingSettings();
  const syncScope = useSyncScope(accounts, scope);

  const list = useMessageList(scope, view, filters);
  const { messages, total } = list;

  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const controls = useRef<MessageListControls | null>(null);
  const [listWidth, setListWidth] = useState(readListWidth);
  const [moveOpen, setMoveOpen] = useState(false);

  const selection = useMailSelection(messages, `${JSON.stringify(scope)}:${view}`);
  const compose = useComposeIntent();

  const openMessage = useCallback(
    (id: number | null) => {
      const params = searchParams.toString();
      void navigate({
        pathname: mailPath(scope, view, id),
        search: params ? `?${params}` : '',
      });
    },
    [navigate, scope, view, searchParams],
  );

  const actions = useMessageActions({
    scope,
    view,
    folders: foldersQuery.data,
    currentMessageId: messageId,
    ordered: messages,
    // 归档/删除当前打开的那封时导航到下一封，而不是让阅读区变空
    onFocusNext: (nextId) => openMessage(nextId),
  });

  const detail = useMessageDetail(messageId);
  const thread = useMessageThread(messageId, { enabled: settingsQuery.data?.threadView !== false });

  const events = useMailEvents({
    scope,
    view,
    filters,
    folders: foldersQuery.data,
    canAutoInsert: () =>
      (controls.current?.isAtTop() ?? true) && selection.count === 0 && messageId === null,
  });

  const current = useMemo(
    () => messages.find((message) => message.id === messageId),
    [messages, messageId],
  );
  const currentAccount = accountsById.get(detail.data?.accountId ?? current?.accountId ?? -1);

  /**
   * 光标行。**不等于「已打开的那封」** —— 刚切到一个视图时什么都没打开，
   * 但 `x` / `e` / `s` 必须立刻有作用对象，否则单键操作要先点一下鼠标才生效。
   */
  const [cursorId, setCursorId] = useState<number | null>(null);
  const activeId =
    messageId ??
    (cursorId !== null && messages.some((message) => message.id === cursorId)
      ? cursorId
      : (messages[0]?.id ?? null));
  const cursor = useMemo(
    () => messages.find((message) => message.id === activeId),
    [messages, activeId],
  );

  /** 键盘操作的目标：有勾选就是勾选集，否则是光标所在的那一封。 */
  const targets = useMemo<MessageSummary[]>(() => {
    if (selection.count > 0) return selection.selectedMessages;
    return cursor ? [cursor] : [];
  }, [selection.count, selection.selectedMessages, cursor]);

  // 打开邮件即标记已读（乐观），这是所有邮件客户端的默认行为
  const markedRead = useRef<number | null>(null);
  useEffect(() => {
    if (!current || current.isRead || markedRead.current === current.id) return;
    markedRead.current = current.id;
    actions.setFlags([current], { isRead: true });
  }, [current, actions]);

  // 列表滚动位置按 scope+view 记忆，切回来不跳顶部（accessibility.md #14）
  const scrollKey = `fm.scroll.${JSON.stringify(scope)}.${view}`;
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const saved = readSessionNumber(scrollKey);
    if (saved !== null) element.scrollTop = saved;
    return () => {
      writeSessionNumber(scrollKey, element.scrollTop);
    };
  }, [scrollKey]);

  const rows = useMemo(
    () => buildRows(messages, { grouped: view !== 'codes' }),
    [messages, view],
  );

  /**
   * `j`/`k`：移动光标。阅读区**已经打开**时顺带打开下一封（连续处理），
   * 没打开时只移动光标，由 `Enter` / `o` 决定什么时候打开（interactions.md §1.2）。
   */
  const move = useCallback(
    (index: number) => {
      const next = messages[index];
      if (!next) return;
      setCursorId(next.id);
      controls.current?.scrollToMessage(next.id);
      if (messageId !== null) openMessage(next.id);
    },
    [messages, messageId, openMessage],
  );

  const currentIndex = messages.findIndex((message) => message.id === activeId);

  const setFilters = useCallback(
    (next: MailFilters) => {
      setSearchParams(filtersToSearchParams(next, searchParams), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const copyCurrentOtp = useCallback(() => {
    const message = targets[0];
    const otp = message ? extractOtp(message.subject, message.snippet) : null;
    if (!otp || !message) {
      showInfoToast('这封邮件里没有识别到验证码');
      return;
    }
    const host = message.from?.address.split('@')[1] ?? '未知发件人';
    void copyOtp(otp.code, `来自 ${host} → ${accountsById.get(message.accountId)?.email ?? ''}`);
  }, [targets, accountsById]);

  useShortcutScope('list');
  useShortcutScope('message', messageId !== null);

  useShortcuts([
    { keys: 'j', label: '下一封', group: '导航', scope: 'list', run: () => move(currentIndex + 1) },
    { keys: 'k', label: '上一封', group: '导航', scope: 'list', run: () => move(currentIndex - 1) },
    { keys: 'ArrowDown', label: '下一封', group: '导航', scope: 'list', hidden: true, run: () => move(currentIndex + 1) },
    { keys: 'ArrowUp', label: '上一封', group: '导航', scope: 'list', hidden: true, run: () => move(currentIndex - 1) },
    { keys: 'Home', label: '列表首', group: '导航', scope: 'list', run: () => move(0) },
    { keys: 'End', label: '列表尾', group: '导航', scope: 'list', run: () => move(messages.length - 1) },
    {
      keys: 'Enter',
      label: '打开当前邮件',
      group: '导航',
      scope: 'list',
      run: () => {
        if (events.pendingCount > 0 && messageId === null) {
          events.flushPending();
          controls.current?.scrollToTop(true);
          return;
        }
        if (cursor) openMessage(cursor.id);
        readerRef.current?.focus();
      },
    },
    {
      keys: 'o',
      label: '打开当前邮件',
      group: '导航',
      scope: 'list',
      hidden: true,
      run: () => {
        if (cursor) openMessage(cursor.id);
      },
    },
    {
      keys: 'Escape',
      label: '逐层退出',
      group: '导航',
      scope: 'list',
      run: () => {
        if (selection.count > 0) {
          selection.clear();
          return;
        }
        if (messageId !== null) {
          openMessage(null);
          listRef.current?.focus();
          return;
        }
        return false;
      },
    },

    { keys: '/', label: '聚焦搜索框', group: '搜索', scope: 'list', run: () => searchRef.current?.focus() },

    { keys: 'e', label: '归档', group: '邮件操作', scope: 'list', run: () => actions.archive(targets) },
    { keys: 'Shift+E', label: '移回收件箱', group: '邮件操作', scope: 'list', run: () => actions.unarchive(targets) },
    { keys: '#', label: '删除', group: '邮件操作', scope: 'list', run: () => actions.remove(targets) },
    { keys: '!', label: '标记垃圾邮件', group: '邮件操作', scope: 'list', run: () => actions.markJunk(targets) },
    { keys: 's', label: '切换星标', group: '邮件操作', scope: 'list', run: () => actions.toggleStar(targets) },
    { keys: 'u', label: '切换已读/未读', group: '邮件操作', scope: 'list', run: () => actions.toggleRead(targets) },
    { keys: 'v', label: '移动到文件夹', group: '邮件操作', scope: 'list', run: () => setMoveOpen(targets.length > 0) },
    { keys: 'y', label: '复制验证码', group: '邮件操作', scope: 'list', run: copyCurrentOtp },
    {
      keys: 'Shift+Y',
      label: '复制发件人地址',
      group: '邮件操作',
      scope: 'list',
      run: () => {
        const address = targets[0]?.from?.address;
        if (!address) {
          showInfoToast('没有可复制的发件人地址');
          return;
        }
        void copyText(address).then((ok) => {
          showInfoToast(ok ? `已复制 ${address}` : '无法访问剪贴板');
        });
      },
    },

    {
      keys: 'x',
      label: '勾选当前行',
      group: '选择',
      scope: 'list',
      run: () => {
        if (cursor) selection.toggle(cursor.id);
      },
    },
    {
      keys: 'Shift+J',
      label: '向下扩展选择',
      group: '选择',
      scope: 'list',
      run: () => {
        const next = messages[currentIndex + 1];
        if (!next) return;
        selection.extendTo(next.id);
        move(currentIndex + 1);
      },
    },
    {
      keys: 'Shift+K',
      label: '向上扩展选择',
      group: '选择',
      scope: 'list',
      run: () => {
        const previous = messages[currentIndex - 1];
        if (!previous) return;
        selection.extendTo(previous.id);
        move(currentIndex - 1);
      },
    },
    { keys: 'Mod+A', label: '全选已加载的邮件', group: '选择', scope: 'list', run: selection.selectAll },

    { keys: 'c', label: '写新邮件', group: '撰写', scope: 'list', run: () => compose.open('new') },
    {
      keys: 'r',
      label: '回复',
      group: '撰写',
      scope: 'list',
      run: () => {
        if (messageId !== null) compose.open('reply', messageId);
      },
    },
    {
      keys: 'a',
      label: '全部回复',
      group: '撰写',
      scope: 'list',
      run: () => {
        if (messageId !== null) compose.open('replyAll', messageId);
      },
    },
    {
      keys: 'f',
      label: '转发',
      group: '撰写',
      scope: 'list',
      run: () => {
        if (messageId !== null) compose.open('forward', messageId);
      },
    },
  ]);

  const otpForCommand = cursor ? extractOtp(cursor.subject, cursor.snippet) : null;

  useRegisterCommands([
    {
      id: 'message.compose',
      title: '写新邮件',
      group: '邮件操作',
      icon: MailPlusIcon,
      shortcut: 'c',
      run: () => compose.open('new'),
    },
    {
      id: 'message.reply',
      title: '回复这封邮件',
      group: '建议',
      icon: CornerUpLeftIcon,
      shortcut: 'r',
      enabled: () => messageId !== null,
      run: () => {
        if (messageId !== null) compose.open('reply', messageId);
      },
    },
    {
      id: 'message.archive',
      title: '归档',
      group: '邮件操作',
      icon: ArchiveIcon,
      shortcut: 'e',
      enabled: () => targets.length > 0,
      run: () => actions.archive(targets),
    },
    {
      id: 'message.delete',
      title: '删除',
      group: '邮件操作',
      icon: Trash2Icon,
      shortcut: '#',
      enabled: () => targets.length > 0,
      run: () => actions.remove(targets),
    },
    {
      id: 'message.move',
      title: '移动到…',
      group: '邮件操作',
      icon: FolderInputIcon,
      shortcut: 'v',
      enabled: () => targets.length > 0,
      run: () => setMoveOpen(true),
    },
    {
      id: 'message.copyOtp',
      title: otpForCommand ? `复制验证码 ${otpForCommand.code}` : '复制验证码',
      group: '建议',
      icon: CopyIcon,
      shortcut: 'y',
      enabled: () => otpForCommand !== null,
      run: copyCurrentOtp,
    },
  ]);

  // 加载完成播报一次，不给每封新邮件都播报（那会疯掉）
  const announced = useRef(0);
  useEffect(() => {
    if (messages.length === 0 || messages.length === announced.current) return;
    announced.current = messages.length;
    announce(`已加载 ${messages.length} 封邮件`);
  }, [messages.length, announce]);

  const onRowClick = useCallback(
    (message: MessageSummary, event: MouseEvent<HTMLElement>) => {
      setCursorId(message.id);
      if (event.shiftKey) {
        selection.extendTo(message.id);
        return;
      }
      openMessage(message.id);
    },
    [openMessage, selection],
  );

  const showList = !isMobile || messageId === null;
  const showReader = !isMobile || messageId !== null;

  const listPane = (
    <section
      aria-label="邮件列表"
      className={cn('flex min-h-0 flex-col', isMobile ? 'w-full' : 'shrink-0')}
      style={isMobile ? undefined : { width: listWidth }}
    >
      <ListToolbar
        view={view}
        viewName={viewLabel(view)}
        count={viewCount(summaryQuery.data, scope, view)}
        filters={filters}
        onFiltersChange={setFilters}
        onToggleCodes={() =>
          void navigate(mailPath(scope, view === 'codes' ? 'inbox' : 'codes'))
        }
        density={preference}
        onDensityChange={setDensity}
        searchRef={searchRef}
        onSubmitSearch={(query) => {
          const params = new URLSearchParams({ q: query });
          if (scope.kind === 'account') params.set('scope', `a${String(scope.accountId)}`);
          void navigate({ pathname: '/search', search: params.toString() });
        }}
        onRefresh={() => void list.query.refetch()}
        refreshing={list.query.isFetching}
      />

      {list.query.isError && messages.length > 0 ? (
        <ErrorBanner
          title="无法刷新邮件"
          error={list.query.error}
          onRetry={() => void list.query.refetch()}
        />
      ) : null}

      <NewMailBanner
        count={events.pendingCount}
        onClick={() => {
          events.flushPending();
          controls.current?.scrollToTop(true);
        }}
      />

      {list.query.isPending ? (
        <div aria-busy className="min-h-0 flex-1 overflow-hidden">
          <ListSkeleton rows={12} />
        </div>
      ) : list.query.isError && messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <ErrorBanner
            title="无法加载邮件"
            error={list.query.error}
            onRetry={() => void list.query.refetch()}
            className="rounded-md"
          />
        </div>
      ) : messages.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ListEmptyState
            view={view}
            activeFilters={activeFilterLabels(filters, view)}
            onClearFilters={() => setFilters({})}
            onSync={() => syncScope.mutate()}
          />
        </div>
      ) : (
        <MessageList
          rows={rows}
          messages={messages}
          accountsById={accountsById}
          density={density}
          activeId={activeId}
          selected={selection.selected}
          selectionMode={selection.count > 0}
          label={`${viewLabel(view)} · ${scope.kind === 'all' ? '全部账号' : (accountsById.get(scope.accountId)?.email ?? '账号')}`}
          total={total}
          hasMore={list.query.hasNextPage}
          loadingMore={list.query.isFetchingNextPage}
          busy={list.query.isFetching}
          relativeTime={view === 'codes'}
          containerRef={listRef}
          onOpen={onRowClick}
          onToggleCheck={(message) => selection.toggle(message.id)}
          onLoadMore={() => void list.query.fetchNextPage()}
          onReady={(next) => {
            controls.current = next;
          }}
        />
      )}

      <BulkActionBar
        selected={selection.selectedMessages}
        total={total}
        allLoadedSelected={selection.allLoadedSelected}
        hasMore={list.query.hasNextPage}
        onSelectAllLoaded={() => void list.query.fetchNextPage()}
        onClear={selection.clear}
        onToggleRead={() => actions.toggleRead(selection.selectedMessages)}
        onToggleStar={() => actions.toggleStar(selection.selectedMessages)}
        onArchive={() => actions.archive(selection.selectedMessages)}
        onDelete={() => actions.remove(selection.selectedMessages)}
        onMove={() => setMoveOpen(true)}
      />
    </section>
  );

  const readerPane = (
    <div className="min-w-0 flex-1">
      <ReadingPane
        message={detail.data}
        summary={current}
        account={currentAccount}
        loading={detail.isPending && messageId !== null}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        position={messageId === null ? null : { index: currentIndex + 1, total }}
        thread={thread.data?.items ?? []}
        onOpenThreadMessage={openMessage}
        alwaysShowImages={shouldShowRemoteImages(settingsQuery.data)}
        containerRef={readerRef}
        showBack={isMobile}
        onClose={() => openMessage(null)}
        onReply={() => messageId !== null && compose.open('reply', messageId)}
        onReplyAll={() => messageId !== null && compose.open('replyAll', messageId)}
        onForward={() => messageId !== null && compose.open('forward', messageId)}
        onToggleRead={() => actions.toggleRead(targets)}
        onToggleStar={() => actions.toggleStar(targets)}
        onArchive={() => actions.archive(targets)}
        onDelete={() => actions.remove(targets)}
        onJunk={() => actions.markJunk(targets)}
        onMove={() => setMoveOpen(true)}
        onReauth={() => void navigate('/accounts?status=auth_error')}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      {showList ? listPane : null}
      {!isMobile ? <PaneDivider width={listWidth} onWidthChange={setListWidth} /> : null}
      {showReader ? readerPane : null}

      <MoveToDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        folders={foldersQuery.data ?? []}
        accountsById={accountsById}
        accountIds={[...new Set(targets.map((message) => message.accountId))]}
        onSelect={(folderId) => actions.moveTo(targets, folderId)}
      />

      {compose.intent ? (
        <ComposeWindow
          intent={compose.intent}
          accounts={accounts}
          defaultAccountId={settingsQuery.data?.defaultAccountId ?? current?.accountId ?? null}
          onClose={compose.close}
        />
      ) : null}
    </div>
  );
}
