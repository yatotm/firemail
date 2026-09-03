import { describe, expect, it } from 'vitest';
import { previewImport, parseImportLine, IMPORT_SEPARATOR } from './import-parse.ts';

const S = IMPORT_SEPARATOR;
const line = (email: string) => `${email}${S}pass${S}client${S}token`;

describe('单行解析', () => {
  it('四个字段齐全就是可导入', () => {
    const row = parseImportLine(line('a@outlook.com'), 1);
    expect(row.status).toBe('ready');
    expect(row.values).toEqual({
      email: 'a@outlook.com',
      password: 'pass',
      clientId: 'client',
      refreshToken: 'token',
    });
  });

  it('字段数不对时说明实际有几个', () => {
    expect(parseImportLine(`a@outlook.com${S}pass${S}client`, 3)).toMatchObject({
      status: 'invalid',
      line: 3,
      reason: '格式错误，需要 4 个字段，实际 3 个',
    });
    expect(parseImportLine(`a@x.com${S}p${S}c${S}t${S}extra`, 4)).toMatchObject({
      status: 'invalid',
      reason: '格式错误，需要 4 个字段，实际 5 个',
    });
  });

  it('有空字段时不放行', () => {
    expect(parseImportLine(`a@outlook.com${S}${S}client${S}token`, 1)).toMatchObject({
      status: 'invalid',
      reason: '有空白字段',
    });
  });

  it('邮箱不合法时把原值回显出来，方便定位', () => {
    const row = parseImportLine(`not-an-email${S}p${S}c${S}t`, 7);
    expect(row.status).toBe('invalid');
    expect(row.line).toBe(7);
    expect(row.reason).toContain('not-an-email');
  });
});

describe('整段预览', () => {
  it('统计可导入 / 已存在 / 有问题', () => {
    const preview = previewImport(
      [line('a@outlook.com'), line('bad'), line('b@outlook.com')].join('\n'),
      { existingEmails: ['b@outlook.com'] },
    );

    expect(preview.total).toBe(3);
    expect(preview.ready).toBe(1);
    expect(preview.invalid).toBe(1);
    expect(preview.duplicate).toBe(1);
    expect(preview.rows.map((row) => row.line)).toEqual([1, 2, 3]);
  });

  it('CRLF 文本照样能解析', () => {
    const preview = previewImport(`${line('a@outlook.com')}\r\n${line('b@outlook.com')}\r\n`);
    expect(preview.ready).toBe(2);
    expect(preview.invalid).toBe(0);
    expect(preview.rows[0]?.values?.refreshToken).toBe('token');
  });

  it('结尾的空行不算一行', () => {
    const preview = previewImport(`${line('a@outlook.com')}\n\n\n`);
    expect(preview.total).toBe(1);
  });

  it('中间的空行被跳过，但后续行号继续递增（与服务端一致）', () => {
    const preview = previewImport([line('a@outlook.com'), '', line('bad')].join('\n'));
    expect(preview.rows.map((row) => row.line)).toEqual([1, 3]);
  });

  it('行号从 trim 之后的第一行算起，与服务端的 errors[].line 对得上', () => {
    // 服务端是 payload.trim().split('\n')，所以开头的空行不占行号
    const preview = previewImport(`\n\n${line('bad')}`);
    expect(preview.rows[0]?.line).toBe(1);
  });

  it('同一段里重复的邮箱只留第一条，其余标为重复', () => {
    const preview = previewImport([line('a@outlook.com'), line('A@Outlook.com')].join('\n'));
    expect(preview.ready).toBe(1);
    expect(preview.duplicate).toBe(1);
    expect(preview.rows[1]?.reason).toContain('重复');
  });

  it('与已有账号重复时提示会被跳过（忽略大小写）', () => {
    const preview = previewImport(line('a@outlook.com'), {
      existingEmails: ['A@OUTLOOK.COM'],
    });
    expect(preview.duplicate).toBe(1);
    expect(preview.rows[0]?.reason).toContain('已存在');
  });

  it('空内容不产生任何行', () => {
    expect(previewImport('   \n  ').total).toBe(0);
  });

  it('支持自定义分隔符', () => {
    const preview = previewImport('a@outlook.com|p|c|t', { separator: '|' });
    expect(preview.ready).toBe(1);
  });
});
