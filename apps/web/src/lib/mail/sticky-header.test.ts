import type { MessageSummary } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import type { ListRow } from '@/lib/mail/rows';
import { headerRowIndexes, stickyHeaderFor } from '@/lib/mail/sticky-header';
import { measureOffsets } from '@/lib/mail/virtual';

const HEADER = 24;
const ROW = 64;

/** 3 组，每组 1 个日期头 + 3 封信。分组头落在行 0 / 4 / 8，偏移 0 / 216 / 432。 */
const ROWS: ListRow[] = ['今天', '昨天', '周三'].flatMap((label, group) => [
  { kind: 'header' as const, key: `h-${label}`, label },
  ...[0, 1, 2].map((n) => {
    const index = group * 3 + n;
    return {
      kind: 'message' as const,
      key: `m-${index}`,
      index,
      message: { id: index } as MessageSummary,
    };
  }),
]);

const SIZES = ROWS.map((row) => (row.kind === 'header' ? HEADER : ROW));
const OFFSETS = measureOffsets(SIZES);
const HEADERS = headerRowIndexes(ROWS);

function at(scrollTop: number) {
  return stickyHeaderFor(ROWS, OFFSETS, HEADERS, scrollTop, HEADER);
}

describe('headerRowIndexes', () => {
  it('挑出全部分组头的下标', () => {
    expect(HEADERS).toEqual([0, 4, 8]);
  });

  it('未分组的列表没有分组头', () => {
    const flat: ListRow[] = [{ kind: 'message', key: 'm-1', index: 0, message: { id: 1 } as MessageSummary }];
    expect(headerRowIndexes(flat)).toEqual([]);
  });
});

describe('stickyHeaderFor', () => {
  it('列表顶部钉住第一组', () => {
    expect(at(0)).toEqual({ index: 0, label: '今天', offset: 0 });
  });

  it('滚到第一组的邮件里，钉的还是第一组', () => {
    expect(at(100)).toEqual({ index: 0, label: '今天', offset: 0 });
  });

  it('滚过第二个分组头之后，钉住的换成第二组', () => {
    // 第二个头在 216，滚到 216 时它正好贴住顶部
    expect(at(216)).toEqual({ index: 4, label: '昨天', offset: 0 });
    expect(at(300)).toEqual({ index: 4, label: '昨天', offset: 0 });
  });

  it('滚到最后一组', () => {
    expect(at(432)).toEqual({ index: 8, label: '周三', offset: 0 });
    expect(at(600)).toEqual({ index: 8, label: '周三', offset: 0 });
  });

  // 「上一个头被下一个顶出去」是这个交互唯一的动效，边界必须钉死
  describe('下一个分组头顶上来时的上推', () => {
    it('下一个头还差一整格时不推', () => {
      expect(at(216 - HEADER)?.offset).toBe(0);
    });

    it('下一个头进来一半，推一半', () => {
      expect(at(216 - HEADER / 2)?.offset).toBe(-HEADER / 2);
    });

    it('下一个头贴到顶部的那一刻，上一个刚好被完全推出，同时换成下一个', () => {
      const justBefore = at(215);
      expect(justBefore).toEqual({ index: 0, label: '今天', offset: -23 });
      expect(at(216)).toEqual({ index: 4, label: '昨天', offset: 0 });
    });

    it('最后一组没有下一个头，永远不推', () => {
      expect(at(999)?.offset).toBe(0);
    });
  });

  it('未分组的列表不钉任何东西', () => {
    const flat: ListRow[] = [{ kind: 'message', key: 'm-1', index: 0, message: { id: 1 } as MessageSummary }];
    expect(stickyHeaderFor(flat, measureOffsets([ROW]), [], 0, HEADER)).toBeNull();
  });

  it('空列表不炸', () => {
    expect(stickyHeaderFor([], [0], [], 0, HEADER)).toBeNull();
  });

  it('第一个分组头之前（列表以邮件行开头）不钉', () => {
    const rows: ListRow[] = [
      { kind: 'message', key: 'm-0', index: 0, message: { id: 0 } as MessageSummary },
      { kind: 'header', key: 'h-1', label: '昨天' },
    ];
    expect(stickyHeaderFor(rows, measureOffsets([ROW, HEADER]), [1], 0, HEADER)).toBeNull();
  });
});
