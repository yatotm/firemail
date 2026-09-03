import type { Account, MessageSummary } from '@firemail/shared';
import { useCallback, useEffect, useMemo, useRef, type MouseEvent, type RefObject } from 'react';
import { ListSkeleton } from '@/components/common/skeletons';
import { MessageRow, type HighlightRanges } from '@/components/mail/message-row';
import type { Density } from '@/hooks/use-density';
import { useVirtualRows } from '@/hooks/mail/use-virtual-rows';
import { GROUP_HEADER_HEIGHT, ROW_HEIGHT } from '@/lib/mail/density';
import { extractOtp, type OtpMatch } from '@/lib/mail/otp';
import { messageRowIndexes, type ListRow } from '@/lib/mail/rows';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface MessageListProps {
  rows: ListRow[];
  messages: readonly MessageSummary[];
  accountsById: Map<number, Account>;
  density: Density;
  activeId: number | null;
  selected: ReadonlySet<number>;
  selectionMode: boolean;
  label: string;
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  busy: boolean;
  relativeTime?: boolean;
  highlightsFor?: (message: MessageSummary) => HighlightRanges | undefined;
  contextLabelFor?: (message: MessageSummary) => string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onOpen: (message: MessageSummary, event: MouseEvent<HTMLElement>) => void;
  onToggleCheck: (message: MessageSummary, event: MouseEvent<HTMLElement>) => void;
  onLoadMore: () => void;
  /** 虚拟滚动的控制句柄交给页面，`j`/`k` 要能把行滚进视口。 */
  onReady?: (controls: MessageListControls) => void;
}

export interface MessageListControls {
  scrollToMessage: (id: number) => void;
  scrollToTop: (smooth?: boolean) => void;
  isAtTop: () => boolean;
}

/** 距底部这么近就预取下一页，用户不会看到「加载更多」的空档。 */
const LOAD_MORE_THRESHOLD = 320;

/**
 * 虚拟滚动的邮件列表。
 *
 * 用 `role="listbox"` 而不是 `grid`/`table`：行内没有可独立聚焦的控件，
 * listbox 的「列表项 3/124」播报正是我们要的，ARIA 出错面也最小（accessibility.md §2.2）。
 */
export function MessageList({
  rows,
  messages,
  accountsById,
  density,
  activeId,
  selected,
  selectionMode,
  label,
  total,
  hasMore,
  loadingMore,
  busy,
  relativeTime,
  highlightsFor,
  contextLabelFor,
  containerRef,
  onOpen,
  onToggleCheck,
  onLoadMore,
  onReady,
}: MessageListProps) {
  const sizes = useMemo(
    () => rows.map((row) => (row.kind === 'header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT[density])),
    [rows, density],
  );

  const virtual = useVirtualRows({
    sizes,
    containerRef,
    scrollPaddingTop: GROUP_HEADER_HEIGHT,
    scrollPaddingBottom: 8,
  });

  const otpCache = useMemo(() => {
    const cache = new Map<number, OtpMatch | null>();
    for (const message of messages) {
      cache.set(message.id, extractOtp(message.subject, message.snippet));
    }
    return cache;
  }, [messages]);

  const messageIndexes = useMemo(() => messageRowIndexes(rows), [rows]);

  const scrollToMessage = useCallback(
    (id: number) => {
      const index = rows.findIndex((row) => row.kind === 'message' && row.message.id === id);
      if (index >= 0) virtual.scrollToIndex(index);
    },
    [rows, virtual],
  );

  const readyRef = useRef(onReady);
  useEffect(() => {
    readyRef.current = onReady;
  });
  useEffect(() => {
    readyRef.current?.({
      scrollToMessage,
      scrollToTop: virtual.scrollToTop,
      isAtTop: virtual.isAtTop,
    });
  }, [scrollToMessage, virtual.scrollToTop, virtual.isAtTop]);

  const handleScroll = useCallback(() => {
    virtual.onScroll();
    const element = containerRef.current;
    if (!element || !hasMore || loadingMore) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < LOAD_MORE_THRESHOLD) {
      onLoadMore();
    }
  }, [virtual, containerRef, hasMore, loadingMore, onLoadMore]);

  const visible = rows.slice(virtual.startIndex, virtual.endIndex);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      aria-busy={busy || undefined}
      {...(activeId === null ? {} : { 'aria-activedescendant': `msg-${String(activeId)}` })}
      tabIndex={0}
      className="group/list min-h-0 flex-1 overflow-y-auto scroll-pt-6 outline-none focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div style={{ height: virtual.totalSize }} className="relative">
        <div style={{ transform: `translateY(${String(virtual.paddingTop)}px)` }}>
          {visible.map((row) =>
            row.kind === 'header' ? (
              <div
                key={row.key}
                aria-hidden
                style={{ height: GROUP_HEADER_HEIGHT }}
                className="sticky top-0 z-sticky flex items-center bg-background/85 px-3 text-2xs font-medium text-muted-foreground backdrop-blur"
              >
                {row.label}
              </div>
            ) : (
              <MessageRow
                key={row.key}
                message={row.message}
                accountEmail={accountsById.get(row.message.accountId)?.email ?? '未知账号'}
                density={density}
                active={row.message.id === activeId}
                checked={selected.has(row.message.id)}
                selectionMode={selectionMode}
                otp={otpCache.get(row.message.id) ?? null}
                {...(highlightsFor
                  ? { highlights: highlightsFor(row.message) ?? { subject: [], snippet: [] } }
                  : {})}
                contextLabel={contextLabelFor?.(row.message) ?? null}
                {...(relativeTime === undefined ? {} : { relativeTime })}
                ariaPosInSet={row.index + 1}
                ariaSetSize={total ?? messageIndexes.length}
                onOpen={onOpen}
                onToggleCheck={onToggleCheck}
              />
            ),
          )}
        </div>
      </div>

      {loadingMore ? <ListSkeleton rows={3} /> : null}

      <ListFooter
        loaded={messages.length}
        total={total}
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

/**
 * 底部永远有一行状态。「无限滚动没有底部状态」是自托管应用最常见的反模式之一：
 * 用户分不清是加载完了还是卡住了（accessibility.md §6 #5）。
 */
function ListFooter({
  loaded,
  total,
  hasMore,
  loading,
  onLoadMore,
}: {
  loaded: number;
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (loaded === 0) return null;

  const totalLabel = total === null ? `${formatCount(loaded)}+` : formatCount(total);

  return (
    <div className={cn('flex h-7 items-center justify-center gap-2 text-2xs text-muted-foreground')}>
      <span className="tnum">
        {totalLabel} 封 · 已加载 {loaded}
      </span>
      {hasMore && !loading ? (
        <button type="button" onClick={onLoadMore} className="text-primary hover:underline">
          加载更多
        </button>
      ) : null}
      {!hasMore ? <span>已到底</span> : null}
    </div>
  );
}
