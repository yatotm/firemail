import { describe, expect, it } from 'vitest';
import { dayEnd, dayStart, formatBytes } from '@/lib/logs';

/**
 * 日期筛选按**用户看到的日历天**算，不是 UTC 天。差一个时区就会出现
 * 「选了今天，最近一小时的日志不见了」这种最难自证的现象。
 */
describe('日期区间', () => {
  it('起始日期取当天 00:00:00.000（本地时区）', () => {
    const start = dayStart('2026-03-18')!;
    expect(start).toBe(new Date('2026-03-18T00:00:00').getTime());
    expect(new Date(start).getHours()).toBe(0);
  });

  it('结束日期取当天 23:59:59.999，是闭区间', () => {
    const end = dayEnd('2026-03-18')!;
    const next = dayStart('2026-03-19')!;
    expect(end).toBe(next - 1);
    expect(new Date(end).getDate()).toBe(18);
  });

  it('同一天的起止能圈住这一天，不多不少', () => {
    expect(dayEnd('2026-03-18')! - dayStart('2026-03-18')!).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('空值与非法值都是 undefined，不往查询串里塞 NaN', () => {
    expect(dayStart('')).toBeUndefined();
    expect(dayEnd('')).toBeUndefined();
    expect(dayStart('不是日期')).toBeUndefined();
  });
});

describe('占用显示', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [Math.round(3.7 * 1024 * 1024), '3.7 MB'],
  ])('%d 字节显示成 %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
