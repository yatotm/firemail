import type { LogEntry, LogStatus, UpdateLogConfig } from '@firemail/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clearLogs, fetchLogStatus, fetchLogs, updateLogConfig, type LogFilters } from '@/lib/logs';
import { showErrorToast } from '@/lib/undo';

export const logStatusKey = ['logs', 'status'] as const;

/** 实时模式的轮询间隔。日志不是聊天，两秒足够「跟着走」，也不至于把服务端问穿。 */
const LIVE_POLL_MS = 2_000;

/** 内存里最多留这么多条。实时开着不管的话它会一直涨，最后是浏览器先撑不住。 */
const MAX_BUFFERED = 2_000;

export function useLogStatus(): UseQueryResult<LogStatus> {
  return useQuery({ queryKey: logStatusKey, queryFn: ({ signal }) => fetchLogStatus(signal) });
}

export interface LogConfigController {
  save: (patch: UpdateLogConfig) => void;
  clear: () => void;
  isSaving: boolean;
  isClearing: boolean;
}

export function useLogConfig(onCleared?: () => void): LogConfigController {
  const client = useQueryClient();
  const settle = (status: LogStatus) => client.setQueryData(logStatusKey, status);

  const save = useMutation({
    mutationFn: updateLogConfig,
    onSuccess: settle,
    onError: (error: unknown) => showErrorToast('保存日志设置失败', error),
  });

  const wipe = useMutation({
    mutationFn: clearLogs,
    onSuccess: (status) => {
      settle(status);
      onCleared?.();
    },
    onError: (error: unknown) => showErrorToast('清空日志失败', error),
  });

  return {
    save: save.mutate,
    clear: wipe.mutate,
    isSaving: save.isPending,
    isClearing: wipe.isPending,
  };
}

export interface LogFeed {
  entries: readonly LogEntry[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/** 已经落定的那一页。`key` 是它对应的筛选条件，用来判断「手上这份还算不算数」。 */
interface FeedState {
  key: string;
  entries: readonly LogEntry[];
  hasMore: boolean;
  error: string | null;
}

const EMPTY: FeedState = { key: '', entries: [], hasMore: false, error: null };

/**
 * 日志列表的取数。
 *
 * 刻意不用 react-query 的 useInfiniteQuery：这里有两个方向的增量——
 * 「往旧里翻」和「实时往新里追」——而后者要把新条目插到**第一页的前面**。
 * 用分页缓存表达它，每次追加都得手工改写 pages 数组，比自己拿一个数组还绕。
 * 日志也不需要跨组件共享缓存，它只有这一个消费者。
 *
 * 「正在加载」是**推导**出来的（手上这份的 key 对不上当前 key），不是一个
 * 状态位。否则筛选条件一变就得先 setState 再取数，多刷一次不说，
 * 中途组件重挂还可能把 loading 卡在 true。
 */
export function useLogFeed(filters: LogFilters, live: boolean): LogFeed {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<FeedState>(EMPTY);
  const [isLoadingMore, setLoadingMore] = useState(false);

  // 调用方可能每次渲染都传一个新对象，序列化之后再还原，依赖就稳定了
  const filtersJson = JSON.stringify(filters);
  const key = `${filtersJson}#${String(reloadToken)}`;
  const stable = useMemo(() => JSON.parse(filtersJson) as LogFilters, [filtersJson]);

  const isLoading = state.key !== key;

  useEffect(() => {
    const controller = new AbortController();

    fetchLogs(stable, {}, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setState({ key, entries: page.entries, hasMore: page.hasMore, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : '读取日志失败';
        setState({ key, entries: [], hasMore: false, error: message });
      });

    return () => controller.abort();
  }, [key, stable]);

  // 实时追加：只问「比我手上最新的那条更新的有哪些」，不重拉整页
  const newestId = state.entries[0]?.id;
  useEffect(() => {
    if (!live || newestId === undefined) return undefined;

    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchLogs(stable, { after: newestId })
        .then((page) => {
          if (cancelled || page.entries.length === 0) return;
          setState((current) => ({
            ...current,
            entries: [...page.entries, ...current.entries].slice(0, MAX_BUFFERED),
          }));
        })
        .catch(() => {
          // 实时模式下的单次失败不弹错：下一轮就会补上，弹了反而是噪声
        });
    }, LIVE_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [live, newestId, stable]);

  const oldestId = state.entries.at(-1)?.id;
  const loadMore = useCallback(() => {
    if (oldestId === undefined || isLoadingMore) return;

    setLoadingMore(true);
    void fetchLogs(stable, { before: oldestId })
      .then((page) => {
        setState((current) => ({
          ...current,
          entries: [...current.entries, ...page.entries],
          hasMore: page.hasMore,
        }));
      })
      .catch((cause: unknown) => showErrorToast('加载更多日志失败', cause))
      .finally(() => setLoadingMore(false));
  }, [oldestId, isLoadingMore, stable]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    entries: isLoading ? [] : state.entries,
    isLoading,
    error: isLoading ? null : state.error,
    hasMore: state.hasMore,
    isLoadingMore,
    loadMore,
    reload,
  };
}
