import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearUndoables,
  dropUndoable,
  pendingUndoables,
  pushUndoable,
  runLatestUndo,
} from './undo.ts';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn(), success: vi.fn() }),
}));

const NOW = 1_000_000;

function action(id: string, undo = vi.fn(), expiresIn = 5000) {
  return { id, label: id, undo, expiresAt: NOW + expiresIn };
}

beforeEach(() => {
  clearUndoables();
});

describe('撤销栈', () => {
  it('z 撤销最近一条', () => {
    const first = vi.fn();
    const second = vi.fn();
    pushUndoable(action('archive', first));
    pushUndoable(action('delete', second));

    expect(runLatestUndo(NOW)).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it('同一个 id 合并而不是堆叠（3 秒内连续归档 5 封只有一条）', () => {
    pushUndoable(action('archive-batch'));
    pushUndoable(action('archive-batch'));

    expect(pendingUndoables(NOW)).toHaveLength(1);
  });

  it('过期的操作不再可撤销', () => {
    const undo = vi.fn();
    pushUndoable(action('archive', undo, 5000));

    expect(runLatestUndo(NOW + 6000)).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it('没有可撤销的操作时返回 false（调用方据此 toast 提示）', () => {
    expect(runLatestUndo(NOW)).toBe(false);
  });

  it('撤销一次后就出栈，连按两次不会执行两遍', () => {
    const undo = vi.fn();
    pushUndoable(action('archive', undo));

    expect(runLatestUndo(NOW)).toBe(true);
    expect(runLatestUndo(NOW)).toBe(false);
    expect(undo).toHaveBeenCalledOnce();
  });

  it('toast 自动消失后从栈里摘掉', () => {
    pushUndoable(action('archive'));
    dropUndoable('archive');

    expect(pendingUndoables(NOW)).toHaveLength(0);
  });

  it('跳过已过期的条目继续往前找', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    pushUndoable(action('stale', stale, 1000));
    pushUndoable(action('fresh', fresh, 10_000));

    expect(runLatestUndo(NOW + 2000)).toBe(true);
    expect(fresh).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });
});
