import type {
  Folder,
  FolderSpecialUse,
  Message,
  MessageFlagPatch,
  MessageSummary,
  Summary,
  SummaryCounts,
} from '@firemail/shared';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { mailKeys } from '@/lib/mail/keys';
import {
  applyPatch,
  dropMessages,
  nextFocusId,
  patchFlags,
  patchSummaryCounts,
  reconcileMoved,
  visibleFolderIds,
  type MessagePages,
} from '@/lib/mail/cache';
import { folderFor } from '@/hooks/mail/use-folders';
import { queryKeys } from '@/lib/query-keys';
import { showErrorToast, showInfoToast, showUndoToast } from '@/lib/undo';
import { isKnownView, type MailScope, type MailView } from '@/lib/nav';

/**
 * 邮件操作的乐观更新（interactions.md §4）。
 *
 * 三条规则决定了这里的形状：
 *  1. 可撤销的操作**不弹确认框** —— 先本地生效，失败整体回滚，成功给一条带「撤销」的 toast。
 *  2. 撤销是**反向操作**而不是事务回滚，所以 `onMutate` 必须先把每封信的原 folderId 存下来。
 *  3. 侧栏计数要跟着一起动，否则会出现「列表空了但计数还是 12」。
 */

/** `bulkMessageActionSchema.ids` 上限。超过就分批，不是报错。 */
const BULK_LIMIT = 500;

type BulkAction = 'read' | 'unread' | 'star' | 'unstar' | 'delete' | 'restore' | 'move';

export interface MoveGroup {
  targetFolderId: number;
  ids: number[];
}

export type ActionPlan =
  | { kind: 'flags'; ids: number[]; patch: MessageFlagPatch; affected: MessageSummary[] }
  | {
      kind: 'move';
      groups: MoveGroup[];
      affected: MessageSummary[];
      /** 撤销时把每封信送回原处。 */
      origin: MoveGroup[];
      label: string;
      undoId: string;
      /** 这一次本身就是撤销：不再给「撤销的撤销」toast，也不动计数。 */
      isUndo?: boolean;
      /** 从回收站还原时要顺便清掉 `\Deleted`。 */
      restore?: boolean;
    }
  | {
      kind: 'delete';
      ids: number[];
      affected: MessageSummary[];
      origin: MoveGroup[];
      label: string;
      undoId: string;
    };

export interface MessageActionsOptions {
  scope: MailScope;
  view: MailView;
  folders: Folder[] | undefined;
  /** 当前打开的邮件；被移走时要把阅读区挪到下一封而不是变空。 */
  currentMessageId?: number | null;
  /** 当前列表的顺序，用来算「下一封」。 */
  ordered?: readonly MessageSummary[];
  onFocusNext?: (nextId: number | null) => void;
}

export interface MessageActions {
  setFlags: (messages: readonly MessageSummary[], patch: MessageFlagPatch) => void;
  toggleRead: (messages: readonly MessageSummary[]) => void;
  toggleStar: (messages: readonly MessageSummary[]) => void;
  archive: (messages: readonly MessageSummary[]) => void;
  unarchive: (messages: readonly MessageSummary[]) => void;
  markJunk: (messages: readonly MessageSummary[]) => void;
  remove: (messages: readonly MessageSummary[]) => void;
  moveTo: (messages: readonly MessageSummary[], targetFolderId: number) => void;
  isPending: boolean;
}

export function useMessageActions(options: MessageActionsOptions): MessageActions {
  const queryClient = useQueryClient();
  const { folders, ordered, currentMessageId, onFocusNext } = options;

  const mutation = useMutation({
    mutationKey: ['message-action'],
    mutationFn: (plan: ActionPlan) => runPlan(plan),

    /**
     * **同步**打补丁：`await cancelQueries` 会把补丁推到下一个微任务，
     * 那一帧里行还在原地，点一次归档会看到明显的迟滞。
     * 取消在途请求放在补丁之后，`onSettled` 的 invalidate 兜底对账。
     */
    onMutate: (plan) => {
      const snapshot = takeSnapshot(queryClient);
      const removed = new Set(plan.kind === 'flags' ? [] : plan.affected.map((m) => m.id));

      if (removed.size > 0 && currentMessageId !== null && currentMessageId !== undefined) {
        const next = nextFocusId(ordered ?? [], removed, currentMessageId);
        if (next !== currentMessageId) onFocusNext?.(next);
      }

      applyOptimistic(queryClient, plan, folders);
      void queryClient.cancelQueries({ queryKey: mailKeys.lists });
      return { snapshot };
    },

    onError: (error, plan, context) => {
      if (context) restoreSnapshot(queryClient, context.snapshot);
      showErrorToast(failureLabel(plan), error, () => mutation.mutate(plan));
    },

    onSuccess: (outcome, plan) => {
      // 部分失败：成功的那些已经生效，剩下的交给 onSettled 的 invalidate 拉回真相
      if (outcome.failed.length > 0) {
        showErrorToast(
          `${outcome.failed.length} 封邮件操作失败`,
          new Error(outcome.failed[0]?.error ?? '未知原因'),
        );
      }
      if (plan.kind === 'flags') return;
      if (plan.kind === 'move' && plan.isUndo === true) {
        showInfoToast(plan.label);
        return;
      }
      showUndoToast({
        id: plan.undoId,
        message: plan.label,
        bulk: plan.affected.length > 1,
        undo: () => {
          mutation.mutate(undoPlan(plan));
        },
      });
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: mailKeys.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary });
    },
  });

  const { mutate } = mutation;

  const run = useCallback((plan: ActionPlan) => { mutate(plan); }, [mutate]);

  const moveBySpecialUse = useCallback(
    (messages: readonly MessageSummary[], specialUse: FolderSpecialUse, label: string) => {
      const plan = buildMovePlan(messages, folders, specialUse, label);
      if (plan) run(plan);
    },
    [folders, run],
  );

  return useMemo<MessageActions>(
    () => ({
      isPending: mutation.isPending,

      setFlags: (messages, patch) => {
        if (messages.length === 0) return;
        run({ kind: 'flags', ids: messages.map((m) => m.id), patch, affected: [...messages] });
      },

      toggleRead: (messages) => {
        if (messages.length === 0) return;
        // 混合状态时统一走「全部标为已读」，不做三态（interactions.md §3.2）
        const read = messages.some((m) => !m.isRead);
        run({
          kind: 'flags',
          ids: messages.map((m) => m.id),
          patch: { isRead: read },
          affected: [...messages],
        });
      },

      toggleStar: (messages) => {
        if (messages.length === 0) return;
        const starred = messages.some((m) => !m.isStarred);
        run({
          kind: 'flags',
          ids: messages.map((m) => m.id),
          patch: { isStarred: starred },
          affected: [...messages],
        });
      },

      archive: (messages) => moveBySpecialUse(messages, 'archive', `已归档 ${messages.length} 封邮件`),
      unarchive: (messages) =>
        moveBySpecialUse(messages, 'inbox', `已移回收件箱 ${messages.length} 封邮件`),
      markJunk: (messages) =>
        moveBySpecialUse(messages, 'junk', `已标记 ${messages.length} 封为垃圾邮件`),

      remove: (messages) => {
        if (messages.length === 0) return;
        run({
          kind: 'delete',
          ids: messages.map((m) => m.id),
          affected: [...messages],
          origin: groupByFolder(messages),
          label: `已删除 ${messages.length} 封邮件`,
          undoId: 'message-delete',
        });
      },

      moveTo: (messages, targetFolderId) => {
        if (messages.length === 0) return;
        run({
          kind: 'move',
          groups: [{ targetFolderId, ids: messages.map((m) => m.id) }],
          affected: [...messages],
          origin: groupByFolder(messages),
          label: `已移动 ${messages.length} 封邮件`,
          undoId: 'message-move',
        });
      },
    }),
    [mutation.isPending, run, moveBySpecialUse],
  );
}

// ---------------------------------------------------------------------------
// 计划构造
// ---------------------------------------------------------------------------

/**
 * 归档 / 垃圾邮件 / 移回收件箱：29 个账号各有各的目标目录 id，
 * 所以必须按账号分组查表，不能写死一个 folderId。
 */
export function buildMovePlan(
  messages: readonly MessageSummary[],
  folders: Folder[] | undefined,
  specialUse: FolderSpecialUse,
  label: string,
): ActionPlan | null {
  if (messages.length === 0) return null;

  const groups = new Map<number, number[]>();
  const missing: string[] = [];
  const moved: MessageSummary[] = [];

  for (const message of messages) {
    const target = folderFor(folders, message.accountId, specialUse);
    if (!target) {
      missing.push(String(message.accountId));
      continue;
    }
    if (target.id === message.folderId) continue;
    const list = groups.get(target.id) ?? [];
    list.push(message.id);
    groups.set(target.id, list);
    moved.push(message);
  }

  if (moved.length === 0) {
    showErrorToast(
      '无法完成操作',
      new Error(missing.length > 0 ? '这些账号没有对应的目标文件夹' : '邮件已经在目标文件夹里'),
    );
    return null;
  }

  return {
    kind: 'move',
    groups: [...groups].map(([targetFolderId, ids]) => ({ targetFolderId, ids })),
    affected: moved,
    origin: groupByFolder(moved),
    label: label.replace(/\d+/, String(moved.length)),
    undoId: `message-${specialUse}`,
  };
}

function groupByFolder(messages: readonly MessageSummary[]): MoveGroup[] {
  const groups = new Map<number, number[]>();
  for (const message of messages) {
    const list = groups.get(message.folderId) ?? [];
    list.push(message.id);
    groups.set(message.folderId, list);
  }
  return [...groups].map(([targetFolderId, ids]) => ({ targetFolderId, ids }));
}

/** 撤销 = 反向操作。删除的撤销要先送回原目录，再清掉 `\Deleted`。 */
export function undoPlan(plan: Extract<ActionPlan, { kind: 'move' | 'delete' }>): ActionPlan {
  return {
    kind: 'move',
    groups: plan.origin,
    affected: plan.affected,
    origin: plan.kind === 'move' ? plan.groups : [],
    label: `已还原 ${plan.affected.length} 封邮件`,
    undoId: `${plan.undoId}-undo`,
    isUndo: true,
    restore: plan.kind === 'delete',
  };
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 写回是「服务器先行、本地后改」，所以**部分失败是常态**：
 * 服务端返回 200 + `{ updated, failed }`，一个账号授权坏了并不影响别的账号。
 * 把它当成无脑成功会出现「toast 说已归档、刷新之后信还在」——这是最难查的一类 bug。
 */
async function runPlan(plan: ActionPlan): Promise<MutationOutcome> {
  const outcome: MutationOutcome = { updated: [], failed: [] };

  if (plan.kind === 'flags') {
    for (const action of flagActions(plan.patch)) absorb(outcome, await bulk(plan.ids, action));
  } else if (plan.kind === 'delete') {
    absorb(outcome, await bulk(plan.ids, 'delete'));
  } else {
    for (const group of plan.groups) {
      absorb(outcome, await bulk(group.ids, 'move', group.targetFolderId));
    }
    // 从回收站撤销出来的信要同时清掉 `\Deleted`，否则移回去了却还是不显示
    if (plan.restore === true) {
      absorb(outcome, await bulk(plan.groups.flatMap((group) => group.ids), 'restore'));
    }
  }

  // 一封都没成功 = 这次操作没有发生，抛出去让 onError 整体回滚
  if (outcome.updated.length === 0 && outcome.failed.length > 0) {
    throw new ApiError(outcome.failed[0]?.error ?? '服务器拒绝了这次操作', {
      code: 'upstream_error',
      status: 200,
    });
  }
  return outcome;
}

const mutationResultSchema = z.object({
  updated: z.array(z.number().int()).default([]),
  failed: z.array(z.object({ id: z.number().int(), error: z.string() })).default([]),
});
type MutationOutcome = z.infer<typeof mutationResultSchema>;

function absorb(target: MutationOutcome, source: MutationOutcome): void {
  target.updated.push(...source.updated);
  target.failed.push(...source.failed);
}

function flagActions(patch: MessageFlagPatch): BulkAction[] {
  const actions: BulkAction[] = [];
  if (patch.isRead !== undefined) actions.push(patch.isRead ? 'read' : 'unread');
  if (patch.isStarred !== undefined) actions.push(patch.isStarred ? 'star' : 'unstar');
  if (patch.isDeleted !== undefined) actions.push(patch.isDeleted ? 'delete' : 'restore');
  return actions;
}

async function bulk(
  ids: number[],
  action: BulkAction,
  targetFolderId?: number,
): Promise<MutationOutcome> {
  const merged: MutationOutcome = { updated: [], failed: [] };
  for (let i = 0; i < ids.length; i += BULK_LIMIT) {
    const result = await api.post(
      mailEndpoints.bulk,
      {
        ids: ids.slice(i, i + BULK_LIMIT),
        action,
        ...(targetFolderId === undefined ? {} : { targetFolderId }),
      },
      { schema: mutationResultSchema },
    );
    absorb(merged, result);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 缓存快照与乐观补丁
// ---------------------------------------------------------------------------

interface Snapshot {
  lists: [readonly unknown[], MessagePages | undefined][];
  details: [readonly unknown[], Message | undefined][];
  summary: Summary | undefined;
}

function takeSnapshot(queryClient: QueryClient): Snapshot {
  return {
    lists: queryClient.getQueriesData<MessagePages>({ queryKey: mailKeys.lists }),
    details: queryClient.getQueriesData<Message>({ queryKey: mailKeys.details }),
    summary: queryClient.getQueryData<Summary>(queryKeys.summary),
  };
}

function restoreSnapshot(queryClient: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot.lists) queryClient.setQueryData(key, data);
  for (const [key, data] of snapshot.details) queryClient.setQueryData(key, data);
  queryClient.setQueryData(queryKeys.summary, snapshot.summary);
}

/** 查询键里第 3、4 段是 scope 与 view，据此判断某个缓存列表要不要把这些行摘掉。 */
export function listContextOf(
  key: readonly unknown[],
): { scope: MailScope; view: MailView } | null {
  const scope = key[2];
  const view = key[3];
  if (typeof view !== 'string' || !isKnownView(view)) return null;
  if (typeof scope !== 'object' || scope === null || !('kind' in scope)) return null;
  const kind = scope.kind;
  if (kind === 'all') return { scope: { kind: 'all' }, view };
  if (kind !== 'account') return null;
  const accountId = (scope as { accountId?: unknown }).accountId;
  if (typeof accountId !== 'number') return null;
  return { scope: { kind: 'account', accountId }, view };
}

function applyOptimistic(
  queryClient: QueryClient,
  plan: ActionPlan,
  folders: Folder[] | undefined,
): void {
  const ids = new Set(plan.kind === 'flags' ? plan.ids : plan.affected.map((m) => m.id));

  for (const [key] of queryClient.getQueriesData<MessagePages>({ queryKey: mailKeys.lists })) {
    const context = listContextOf(key);
    queryClient.setQueryData<MessagePages>(key, (data) => {
      if (plan.kind === 'flags') return patchFlags(data, ids, plan.patch);

      const visible = context ? visibleFolderIds(folders, context.scope, context.view) : null;
      if (plan.kind === 'delete') {
        // 回收站里的「删除」是就地 EXPUNGE，行仍然留在回收站，只是标记变了
        if (context?.view === 'deleted') return patchFlags(data, ids, { isDeleted: true });
        return dropMessages(data, ids);
      }
      const target = plan.groups[0]?.targetFolderId;
      if (target === undefined) return data;
      return reconcileMoved(data, ids, target, visible);
    });
  }

  for (const message of plan.affected) {
    queryClient.setQueryData<Message>(mailKeys.detail(message.id), (detail) => {
      if (!detail) return detail;
      if (plan.kind === 'flags') return applyPatch(detail, plan.patch);
      if (plan.kind === 'delete') return applyPatch(detail, { isDeleted: true });
      const target = plan.groups.find((group) => group.ids.includes(message.id))?.targetFolderId;
      return target === undefined ? detail : { ...detail, folderId: target };
    });
  }

  queryClient.setQueryData<Summary>(queryKeys.summary, (summary) =>
    patchSummaryCounts(summary, summaryDelta(plan), accountIdsOf(plan.affected)),
  );
}

function accountIdsOf(messages: readonly MessageSummary[]): number[] {
  return [...new Set(messages.map((message) => message.accountId))];
}

/**
 * 侧栏计数的增量。只算能确定的那几项（未读、星标、收件箱条目数），
 * 剩下的交给 `onSettled` 的 invalidate —— 猜一个数比慢半秒更糟。
 */
export function summaryDelta(plan: ActionPlan): Partial<Record<keyof SummaryCounts, number>> {
  const delta: Partial<Record<keyof SummaryCounts, number>> = {};

  if (plan.kind === 'flags') {
    if (plan.patch.isRead !== undefined) {
      const changed = plan.affected.filter((m) => m.isRead !== plan.patch.isRead).length;
      delta.unread = plan.patch.isRead ? -changed : changed;
    }
    if (plan.patch.isStarred !== undefined) {
      const changed = plan.affected.filter((m) => m.isStarred !== plan.patch.isStarred).length;
      delta.starred = plan.patch.isStarred ? changed : -changed;
    }
    return delta;
  }

  // 撤销把信送回原处，计数应该回到操作前 —— 与其在这里算反向增量，不如交给 invalidate
  if (plan.kind === 'move' && plan.isUndo === true) return delta;

  const unread = plan.affected.filter((m) => !m.isRead).length;
  if (unread > 0) delta.unread = -unread;
  return delta;
}

function failureLabel(plan: ActionPlan): string {
  switch (plan.kind) {
    case 'flags':
      return '标记失败';
    case 'delete':
      return '删除失败';
    default:
      return '移动失败';
  }
}
