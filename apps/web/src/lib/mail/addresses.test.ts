import type { Message } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import {
  forwardSubject,
  isValidEmail,
  parseAddressList,
  replyRecipients,
  replySubject,
} from '@/lib/mail/addresses';

describe('parseAddressList', () => {
  it('拆分逗号、分号与换行', () => {
    const parsed = parseAddressList('a@x.com, b@x.com; c@x.com\nd@x.com');
    expect(parsed.addresses.map((item) => item.address)).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
    expect(parsed.invalid).toEqual([]);
  });

  it('解析 `名字 <地址>`', () => {
    const [first] = parseAddressList('张三 <zhang@x.com>').addresses;
    expect(first).toEqual({ name: '张三', address: 'zhang@x.com' });
  });

  it('引号里的逗号不拆', () => {
    const parsed = parseAddressList('"Doe, John" <john@x.com>, b@x.com');
    expect(parsed.addresses).toHaveLength(2);
    expect(parsed.addresses[0]?.name).toBe('Doe, John');
  });

  it('尖括号里的分隔符不拆', () => {
    expect(parseAddressList('A <a@x.com>').addresses).toHaveLength(1);
  });

  it('非法地址不丢弃，原样留给用户改', () => {
    const parsed = parseAddressList('good@x.com, 这不是地址');
    expect(parsed.addresses.map((item) => item.address)).toEqual(['good@x.com']);
    expect(parsed.invalid).toEqual(['这不是地址']);
  });

  it('重复地址只保留一个', () => {
    expect(parseAddressList('a@x.com, A@x.com').addresses).toHaveLength(1);
  });

  it.each(['a@b.com', 'a.b+c@sub.example.co.uk'])('%s 合法', (address) => {
    expect(isValidEmail(address)).toBe(true);
  });

  it.each(['a@b', 'a b@c.com', '@b.com', 'a@.com', 'plain'])('%s 非法', (address) => {
    expect(isValidEmail(address)).toBe(false);
  });
});

describe('replyRecipients', () => {
  const base = {
    from: { name: 'Alice', address: 'alice@x.com' },
    to: [
      { name: null, address: 'me@x.com' },
      { name: null, address: 'bob@x.com' },
    ],
    cc: [{ name: null, address: 'carol@x.com' }],
    replyTo: [],
  } satisfies Pick<Message, 'from' | 'to' | 'cc' | 'replyTo'>;

  it('回复只发给原发件人', () => {
    const { to, cc } = replyRecipients(base, 'me@x.com', 'reply');
    expect(to.map((item) => item.address)).toEqual(['alice@x.com']);
    expect(cc).toEqual([]);
  });

  it('Reply-To 优先于 From', () => {
    const { to } = replyRecipients(
      { ...base, replyTo: [{ name: null, address: 'noreply@x.com' }] },
      'me@x.com',
      'reply',
    );
    expect(to.map((item) => item.address)).toEqual(['noreply@x.com']);
  });

  it('全部回复把 To + Cc 放进 Cc，并去掉自己', () => {
    const { to, cc } = replyRecipients(base, 'me@x.com', 'reply_all');
    expect(to.map((item) => item.address)).toEqual(['alice@x.com']);
    expect(cc.map((item) => item.address)).toEqual(['bob@x.com', 'carol@x.com']);
  });

  it('全部回复不会把已经在 To 里的人再抄送一遍', () => {
    const { cc } = replyRecipients(
      { ...base, cc: [{ name: null, address: 'alice@x.com' }] },
      'me@x.com',
      'reply_all',
    );
    expect(cc.map((item) => item.address)).not.toContain('alice@x.com');
  });

  it('大小写不同的同一个地址算重复', () => {
    const { cc } = replyRecipients(
      { ...base, cc: [{ name: null, address: 'BOB@x.com' }] },
      'me@x.com',
      'reply_all',
    );
    expect(cc.filter((item) => item.address.toLowerCase() === 'bob@x.com')).toHaveLength(1);
  });

  it('回复自己发出的信时保留原样，而不是把 To 清空', () => {
    const { to } = replyRecipients(
      { ...base, from: { name: null, address: 'me@x.com' } },
      'me@x.com',
      'reply',
    );
    expect(to.map((item) => item.address)).toEqual(['me@x.com']);
  });

  it('没有发件人时收件人为空，由界面提示用户填写', () => {
    expect(replyRecipients({ ...base, from: null }, 'me@x.com', 'reply').to).toEqual([]);
  });
});

describe('主题前缀', () => {
  it.each([
    ['安全提醒', 'Re: 安全提醒'],
    ['Re: 安全提醒', 'Re: 安全提醒'],
    ['回复：安全提醒', '回复：安全提醒'],
    [null, 'Re: '],
  ])('replySubject(%s) = %s', (input, expected) => {
    expect(replySubject(input)).toBe(expected);
  });

  it.each([
    ['账单', 'Fwd: 账单'],
    ['Fwd: 账单', 'Fwd: 账单'],
    ['转发：账单', '转发：账单'],
  ])('forwardSubject(%s) = %s', (input, expected) => {
    expect(forwardSubject(input)).toBe(expected);
  });
});
