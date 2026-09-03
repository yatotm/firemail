import { describe, expect, it } from 'vitest';
import { filenameFromDisposition, safeFilename } from '@/lib/accounts/download';

/**
 * 服务端给的文件名仍然是外部输入。这里守两件事：常规名字要能取出来，
 * 带路径分隔符或控制字符的名字不能原样进 `<a download>`。
 */

describe('从 Content-Disposition 取文件名', () => {
  it('取带引号的 filename', () => {
    expect(filenameFromDisposition('attachment; filename="firemail-credentials-2026.txt"')).toBe(
      'firemail-credentials-2026.txt',
    );
  });

  it('优先用 RFC 5987 的 filename*', () => {
    expect(
      filenameFromDisposition(`attachment; filename="_.txt"; filename*=UTF-8''%E5%A4%87%E4%BB%BD.txt`),
    ).toBe('备份.txt');
  });

  it('filename* 的百分号编码坏掉时退回 filename', () => {
    expect(filenameFromDisposition(`attachment; filename="ok.txt"; filename*=UTF-8''%E4%A`)).toBe(
      'ok.txt',
    );
  });

  it('不带引号的 filename 也能取', () => {
    expect(filenameFromDisposition('attachment; filename=plain.txt')).toBe('plain.txt');
  });

  it('路径分隔符被替换掉，不会写出目录', () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe(
      '.._.._etc_passwd',
    );
  });

  it('没有头或认不出来时返回 null', () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('attachment')).toBeNull();
  });
});

describe('兜底文件名', () => {
  it('空、纯点、缺失都退回默认名', () => {
    for (const value of [null, undefined, '', '   ', '.', '..']) {
      expect(safeFilename(value)).toBe('firemail-credentials.txt');
    }
  });

  it('正常名字原样保留', () => {
    expect(safeFilename('firemail-credentials-2026.txt')).toBe('firemail-credentials-2026.txt');
  });
});
