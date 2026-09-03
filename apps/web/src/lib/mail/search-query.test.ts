import { describe, expect, it } from 'vitest';
import {
  applyTokens,
  DEFAULT_SEARCH_FILTERS,
  highlightTerms,
  parseDate,
  parseSearchInput,
  searchFiltersFromParams,
  searchFiltersToParams,
} from '@/lib/mail/search-query';

describe('parseSearchInput', () => {
  it('识别 from / is / has / after', () => {
    const parsed = parseSearchInput('验证码 from:github.com is:unread has:attachment after:2026-08-01');
    expect(parsed.text).toBe('验证码');
    expect(parsed.tokens.map((token) => token.kind)).toEqual(['from', 'is', 'has', 'after']);
    expect(parsed.unknown).toEqual([]);
  });

  it('不支持的操作符不静默吞掉，回显并当作关键词', () => {
    const parsed = parseSearchInput('subject:账单 larger:10M');
    expect(parsed.unknown).toEqual(['subject:账单', 'larger:10M']);
    expect(parsed.tokens).toEqual([]);
  });

  it('取值非法的时间操作符也算未识别', () => {
    expect(parseSearchInput('after:昨天').unknown).toEqual(['after:昨天']);
  });

  it('中文两个字的查询原样保留（后端 LIKE 兜底，前端不设最小长度）', () => {
    expect(parseSearchInput('账单').text).toBe('账单');
  });

  it('引号里的值支持空格', () => {
    expect(parseSearchInput('from:"Alice Smith"').tokens[0]?.value).toBe('Alice Smith');
  });
});

describe('applyTokens', () => {
  it('把 token 折成筛选条件', () => {
    const parsed = parseSearchInput('from:github.com is:starred has:attachment after:2026-08-01 before:2026-08-31');
    const filters = applyTokens(DEFAULT_SEARCH_FILTERS, parsed);

    expect(filters.from).toBe('github.com');
    expect(filters.starred).toBe(true);
    expect(filters.hasAttachments).toBe(true);
    expect(filters.since).toBe(parseDate('2026-08-01'));
    // before 是「那一天结束之前」，不是「那一天 0 点之前」
    expect(filters.until).toBe((parseDate('2026-08-31') ?? 0) + 24 * 60 * 60 * 1000 - 1);
  });

  it('has:code 走客户端筛选而不是服务端条件', () => {
    expect(applyTokens(DEFAULT_SEARCH_FILTERS, parseSearchInput('has:code')).hasCode).toBe(true);
  });
});

describe('URL 往返', () => {
  it('筛选条件写进 URL 后能原样读回来（可分享、可刷新）', () => {
    const filters = {
      ...DEFAULT_SEARCH_FILTERS,
      accountId: 3,
      from: 'a@x.com',
      unread: true,
      hasAttachments: true,
      since: 1_700_000_000_000,
      sort: 'receivedAt' as const,
    };
    const params = searchFiltersToParams('验证码', filters);
    expect(params.get('q')).toBe('验证码');
    expect(searchFiltersFromParams(params)).toEqual(filters);
  });
});

describe('highlightTerms', () => {
  it('只高亮自由关键词，不高亮操作符', () => {
    expect(highlightTerms(parseSearchInput('github 验证码 from:x.com'))).toEqual([
      'github',
      '验证码',
    ]);
  });

  it('未识别的操作符也参与高亮（它被当成关键词搜了）', () => {
    expect(highlightTerms(parseSearchInput('subject:账单'))).toEqual(['subject:账单']);
  });
});

describe('parseDate', () => {
  it.each(['2026-08-01', '2026/8/1'])('%s 可解析', (input) => {
    expect(parseDate(input)).not.toBeNull();
  });

  it.each(['2026-13-01x', '昨天', ''])('%s 不可解析', (input) => {
    expect(parseDate(input)).toBeNull();
  });
});
