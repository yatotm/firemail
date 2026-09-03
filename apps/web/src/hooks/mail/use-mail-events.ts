import type { Folder } from '@firemail/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useServerEvent } from '@/hooks/use-server-events';
import { listContextOf } from '@/hooks/mail/use-message-actions';
import {
  applyPatch,
  dropMessages,
  patchFlags,
  reconcileMoved,
  visibleFolderIds,
  type MessagePages,
} from '@/lib/mail/cache';
import { mailKeys } from '@/lib/mail/keys';
import type { Message } from '@firemail/shared';
import { scopeAccountId, type MailScope, type MailView } from '@/lib/nav';
import type { MailFilters } from '@/lib/mail/query';

/**
 * SSE 对账（interactions.md §5）。
 *
 * 核心约束：**正在阅读或正在扫描的内容，位置绝不能变。**
 * 所以标记与移动直接改缓存（不改变行数或位置的那部分立刻生效），
 * 而新邮件只累加一个横幅计数，由用户决定什么时候让列表动。
 */

export interface MailEventsOptions {
  scope: MailScope;
  view: MailView;
  filters: MailFilters;
  folders: Folder[] | undefined;
  /** 列表在顶部、没有勾选、没有打开邮件时才允许直接插入。 */
  canAutoInsert: () => boolean;
  /** 新邮件属于当前打开的会话时直接追加并播报。 */
  onThreadMessage?: (count: number) => void;
  currentAccountIds?: readonly number[] | null;
}

export interface MailEventsState {
  /** 待插入的新邮件数，横幅显示它。 */
  pendingCount: number;
  /** 点横幅：拉最新数据并清零。 */
  flushPending: () => void;
  clearPending: () => void;
}

export function useMailEvents(options: MailEventsOptions): MailEventsState {
  const queryClient = useQueryClient();
  const { scope, view, filters, folders, canAutoInsert, onThreadMessage } = options;

  const [pendingCount, setPendingCount] = useState(0);
  const pendingIds = useRef(new Set<number>());

  const listKey = mailKeys.list(scope, view, filters);

  const refreshCurrentList = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: listKey });
  }, [queryClient, listKey]);

  const flushPending = useCallback(() => {
    pendingIds.current.clear();
    setPendingCount(0);
    refreshCurrentList();
  }, [refreshCurrentList]);

  const clearPending = useCallback(() => {
    pendingIds.current.clear();
    setPendingCount(0);
  }, []);

  useServerEvent((event) => {
    switch (event.type) {
      case 'message:flags': {
        const ids = new Set(event.messageIds);
        for (const [key] of queryClient.getQueriesData<MessagePages>({ queryKey: mailKeys.lists })) {
          queryClient.setQueryData<MessagePages>(key, (data) => patchFlags(data, ids, event.patch));
        }
        for (const id of event.messageIds) {
          queryClient.setQueryData<Message>(mailKeys.detail(id), (detail) =>
            detail ? applyPatch(detail, event.patch) : detail,
          );
        }
        break;
      }

      case 'message:moved': {
        const ids = new Set(event.messageIds);
        for (const [key] of queryClient.getQueriesData<MessagePages>({ queryKey: mailKeys.lists })) {
          const context = listContextOf(key);
          queryClient.setQueryData<MessagePages>(key, (data) => {
            if (!context) return dropMessages(data, ids);
            const visible = visibleFolderIds(folders, context.scope, context.view);
            return reconcileMoved(data, ids, event.toFolderId, visible);
          });
        }
        for (const id of event.messageIds) {
          queryClient.setQueryData<Message>(mailKeys.detail(id), (detail) =>
            detail ? { ...detail, folderId: event.toFolderId } : detail,
          );
        }
        break;
      }

      case 'message:new': {
        if (!isRelevant(event.accountId, scope, options.currentAccountIds)) break;
        onThreadMessage?.(event.messageIds.length);

        if (canAutoInsert()) {
          refreshCurrentList();
          break;
        }
        for (const id of event.messageIds) pendingIds.current.add(id);
        setPendingCount(pendingIds.current.size);
        break;
      }

      default:
        break;
    }
  });

  return { pendingCount, flushPending, clearPending };
}

/** 新邮件属于当前作用域才值得提示；别的账号只更新侧栏计数（provider 已经做了）。 */
function isRelevant(
  accountId: number,
  scope: MailScope,
  currentAccountIds: readonly number[] | null | undefined,
): boolean {
  const scoped = scopeAccountId(scope);
  if (scoped !== null) return scoped === accountId;
  if (currentAccountIds && currentAccountIds.length > 0) return currentAccountIds.includes(accountId);
  return true;
}
