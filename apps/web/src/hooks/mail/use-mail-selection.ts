import type { MessageSummary } from '@firemail/shared';
import { useCallback, useMemo, useState } from 'react';

/**
 * 批量勾选。
 *
 * **切 scope 或 view 时必须清空**（IA §8）：跨视图保留选择是 bug 之源 ——
 * 用户在收件箱勾了 12 封，切到垃圾箱按了删除，删掉的是他看不见的那 12 封。
 */

export interface MailSelection {
  selected: ReadonlySet<number>;
  count: number;
  selectedMessages: MessageSummary[];
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  /** Shift+点击 / Shift+J：从上一个锚点到这一行整段选中。 */
  extendTo: (id: number) => void;
  selectAll: () => void;
  clear: () => void;
  /** 已加载项是否全部选中 —— 决定要不要显示「全选 124 封」。 */
  allLoadedSelected: boolean;
}

export function useMailSelection(
  messages: readonly MessageSummary[],
  resetKey: string,
): MailSelection {
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<number>; anchor: number | null }>(
    () => ({ key: resetKey, ids: new Set(), anchor: null }),
  );

  // 渲染期间派生：切视图就重置，不用 effect（effect 会先渲染一帧旧选择）
  const selected = state.key === resetKey ? state.ids : EMPTY;
  const anchor = state.key === resetKey ? state.anchor : null;

  const update = useCallback(
    (ids: ReadonlySet<number>, nextAnchor: number | null) => {
      setState({ key: resetKey, ids, anchor: nextAnchor });
    },
    [resetKey],
  );

  const toggle = useCallback(
    (id: number) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      update(next, id);
    },
    [selected, update],
  );

  const extendTo = useCallback(
    (id: number) => {
      const from = messages.findIndex((message) => message.id === (anchor ?? id));
      const to = messages.findIndex((message) => message.id === id);
      if (from === -1 || to === -1) {
        toggle(id);
        return;
      }
      const [start, end] = from <= to ? [from, to] : [to, from];
      const next = new Set(selected);
      for (let i = start; i <= end; i++) {
        const message = messages[i];
        if (message) next.add(message.id);
      }
      update(next, anchor ?? id);
    },
    [anchor, messages, selected, toggle, update],
  );

  const selectAll = useCallback(() => {
    update(new Set(messages.map((message) => message.id)), anchor);
  }, [messages, anchor, update]);

  const clear = useCallback(() => {
    update(EMPTY, null);
  }, [update]);

  const selectedMessages = useMemo(
    () => messages.filter((message) => selected.has(message.id)),
    [messages, selected],
  );

  return {
    selected,
    count: selected.size,
    selectedMessages,
    isSelected: (id: number) => selected.has(id),
    toggle,
    extendTo,
    selectAll,
    clear,
    allLoadedSelected: messages.length > 0 && selected.size === messages.length,
  };
}

const EMPTY: ReadonlySet<number> = new Set();
