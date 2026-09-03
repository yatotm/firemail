import { toast } from 'sonner';
import { humanizeApiError } from '@/lib/api';

/**
 * 可撤销操作的 toast（interactions.md §4）。
 * 规则：可撤销的动作**不弹确认框**，先本地生效再后台同步，失败回滚。
 * 只有真正不可逆的动作才用 ConfirmDialog。
 */

export const UNDO_DURATION_SINGLE = 5000;
export const UNDO_DURATION_BULK = 8000;

export interface UndoableAction {
  /** 同类操作复用同一个 id：3 秒内连续归档 5 封会合并成一条 toast。 */
  id: string;
  label: string;
  undo: () => void | Promise<void>;
  expiresAt: number;
}

const stack: UndoableAction[] = [];

export function pushUndoable(action: UndoableAction): void {
  const existing = stack.findIndex((item) => item.id === action.id);
  if (existing >= 0) stack.splice(existing, 1);
  stack.push(action);
}

export function dropUndoable(id: string): void {
  const index = stack.findIndex((item) => item.id === id);
  if (index >= 0) stack.splice(index, 1);
}

export function clearUndoables(): void {
  stack.length = 0;
}

export function pendingUndoables(now = Date.now()): UndoableAction[] {
  return stack.filter((item) => item.expiresAt > now);
}

/** `z` 键：撤销最近一条还没过期的操作。返回 false 表示没有可撤销的。 */
export function runLatestUndo(now = Date.now()): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const action = stack[i];
    if (!action) continue;
    if (action.expiresAt <= now) {
      stack.splice(i, 1);
      continue;
    }
    stack.splice(i, 1);
    void action.undo();
    toast.dismiss(action.id);
    return true;
  }
  return false;
}

export interface UndoToastOptions {
  /** 同类操作用同一个 id 合并，例如 `archive-batch`。 */
  id: string;
  message: string;
  description?: string;
  undo: () => void | Promise<void>;
  /** 批量操作给更长的窗口。 */
  bulk?: boolean;
}

export function showUndoToast({ id, message, description, undo, bulk }: UndoToastOptions): void {
  const duration = bulk ? UNDO_DURATION_BULK : UNDO_DURATION_SINGLE;
  pushUndoable({ id, label: message, undo, expiresAt: Date.now() + duration });

  toast(message, {
    id,
    ...(description ? { description } : {}),
    duration,
    action: {
      label: '撤销',
      onClick: () => {
        dropUndoable(id);
        void undo();
      },
    },
    onAutoClose: () => dropUndoable(id),
    onDismiss: () => dropUndoable(id),
  });
}

/** 失败 toast：主文案说人话，description 放后端的具体原因。 */
export function showErrorToast(context: string, error: unknown, retry?: () => void): void {
  toast.error(context, {
    description: humanizeApiError(error),
    duration: 8000,
    ...(retry ? { action: { label: '重试', onClick: retry } } : {}),
  });
}

export function showSuccessToast(message: string, description?: string): void {
  toast.success(message, { ...(description ? { description } : {}), duration: 3000 });
}

export function showInfoToast(message: string): void {
  toast(message, { duration: 2000 });
}
