import { describe, expect, it } from 'vitest';
import { extractOtp, findTermRanges, otpAriaLabel, splitHighlight } from '@/lib/mail/otp';

describe('extractOtp 命中', () => {
  it.each([
    ['Microsoft account security code', 'Security code: 738214 — 使用此代码完成登录', '738214'],
    ['【微信】验证码', '您的验证码是 4821，5 分钟内有效', '4821'],
    [null, '【淘宝】验证码738214，请勿泄露给他人', '738214'],
    ['GitHub', 'your one-time code is 481902', '481902'],
    [null, '动态密码：AB12CD，请在页面中输入', 'AB12CD'],
    [null, 'Your verification code is 123 456', '123456'],
    [null, '安全码 738-214 已发送', '738214'],
    [null, '校验码 9182', '9182'],
    [null, '一次性密码 55123456 有效期 10 分钟', '55123456'],
  ])('主题=%s 摘要=%s → %s', (subject, snippet, expected) => {
    expect(extractOtp(subject, snippet)?.code).toBe(expected);
  });

  it('返回原文里的区间，供行内高亮', () => {
    const snippet = '您的验证码是 4821，请勿泄露';
    const match = extractOtp(null, snippet);
    expect(match).not.toBeNull();
    expect(snippet.slice(match?.start, match?.end)).toBe('4821');
    expect(match?.field).toBe('snippet');
  });

  it('主题与摘要都有码时优先主题', () => {
    expect(extractOtp('验证码 111111', '验证码 222222')?.field).toBe('subject');
  });

  it('选离关键词最近的那个数字，而不是第一个', () => {
    expect(extractOtp(null, '2026 年的活动，验证码 738214，请勿泄露')?.code).toBe('738214');
  });

  it('同等距离下偏好 6 位', () => {
    expect(extractOtp(null, 'verification code 1234 或 567890')?.code).toBe('1234');
  });
});

describe('extractOtp 抗误报', () => {
  it.each([
    ['订单 20260903 已发货', '合计 1234 元'],
    ['会议纪要', '时间 14:30，地点 3021 会议室'],
    ['账单提醒', '您本月消费 5860 元'],
    [null, 'Tracking number 1234567890 shipped'],
  ])('没有上下文词就不提取：%s', (subject, snippet) => {
    expect(extractOtp(subject, snippet)).toBeNull();
  });

  it('年份不是验证码', () => {
    expect(extractOtp(null, '验证码服务条款于 2026 年更新')).toBeNull();
  });

  it('日期串不是验证码', () => {
    expect(extractOtp(null, '验证码有效期至 2026-09-03')).toBeNull();
  });

  it('超过 8 位的数字串（订单号）不是验证码', () => {
    expect(extractOtp(null, '验证码邮件，订单号 987654321012')).toBeNull();
  });

  it('URL 里贴着字母的数字不会被切出来', () => {
    expect(extractOtp(null, 'Please verify at https://x.com/verify/abc123456')).toBeNull();
  });

  it('纯字母不是验证码', () => {
    expect(extractOtp(null, '验证码 ABCDEF 已失效')).toBeNull();
  });

  it('少于 4 位不是验证码', () => {
    expect(extractOtp(null, '验证码 12 已过期')).toBeNull();
  });
});

describe('屏幕阅读器', () => {
  it('逐位读，否则会读成「七十三万八千二百一十四」', () => {
    expect(otpAriaLabel('738214')).toBe('验证码 7 3 8 2 1 4');
  });
});

describe('splitHighlight', () => {
  it('按区间切成片段，交给 React 渲染 mark', () => {
    expect(splitHighlight('验证码 738214 有效', [{ start: 4, end: 10 }])).toEqual([
      { text: '验证码 ', highlight: false },
      { text: '738214', highlight: true },
      { text: ' 有效', highlight: false },
    ]);
  });

  it('没有区间时原样返回一段', () => {
    expect(splitHighlight('abc', [])).toEqual([{ text: 'abc', highlight: false }]);
  });

  it('忽略越界与重叠区间', () => {
    const segments = splitHighlight('abcdef', [
      { start: 1, end: 3 },
      { start: 2, end: 4 },
      { start: 99, end: 100 },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('abcdef');
  });
});

describe('findTermRanges', () => {
  it('大小写不敏感，多次命中都返回', () => {
    expect(findTermRanges('GitHub github', ['github'])).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 13 },
    ]);
  });

  it('中文两个字也能命中（后端 LIKE 兜底，前端不做最小长度限制）', () => {
    expect(findTermRanges('这是验证码邮件', ['验证'])).toEqual([{ start: 2, end: 4 }]);
  });

  it('合并重叠区间', () => {
    expect(findTermRanges('aaaa', ['aa', 'aaa'])).toEqual([{ start: 0, end: 4 }]);
  });
});
