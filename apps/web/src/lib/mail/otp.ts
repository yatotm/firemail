/**
 * 验证码提取（information-architecture.md §3.2）。
 *
 * 全部在本地跑：验证码邮件的措辞高度模板化，正则命中率足够高，
 * 而 LLM 分类要网络往返、要 key、还要把邮件内容送出去 —— 自托管应用的默认答案是本地能算就本地算。
 *
 * 分工：**服务端决定「哪些信要下发」**（`view=codes` 用关键词过滤），
 * **前端决定「高亮哪几个字符」**。所以这里返回的是位置区间而不只是一个字符串。
 */

/** 上下文词。与服务端 `http/messageQuery.ts` 的 OTP_KEYWORDS 同源。 */
const CONTEXT =
  /验证码|校验码|动态密码|动态码|安全码|验证代码|一次性密码|口令|verification|verify|one[- ]?time|passcode|security code|confirm(?:ation)? code|\bOTP\b|\bPIN\b|access code/gi;

/** 4–8 位纯数字（允许空格/连字符分组），或 6–8 位大写字母数字混合；两侧不能贴着别的字母数字。 */
const CANDIDATE = /(?<![0-9A-Za-z])((?:\d[ -]?){3,7}\d|[A-Z0-9]{6,8})(?![0-9A-Za-z])/g;

/** 年份：`2026` 这种在验证码邮件里极常见（「2026 年」「© 2026」）。 */
const YEAR = /^(?:19|20)\d{2}$/;

/** 日期串：`2026-09-03` 会被数字分支整段吃掉，必须按原样拒掉。 */
const DATE_LIKE = /^\d{4}[ -]\d{2}[ -]\d{2}$|^\d{2}[ -]\d{2}[ -]\d{4}$/;

/** 时间：`14:30` 里的两段都不足 4 位，这里只作为兜底与文档。 */
const CLOCK = /^\d{1,2}[:：]\d{2}$/;

const MIN_LENGTH = 4;
const MAX_LENGTH = 8;

/** 6 位是绝对主流，同等距离下优先。 */
const PREFERRED_LENGTH = 6;

export type OtpField = 'subject' | 'snippet';

export interface OtpMatch {
  /** 去掉分隔符后的码，复制和展示都用它。 */
  code: string;
  /** 原文里的匹配区间（含分隔符），用于行内高亮。 */
  start: number;
  end: number;
  field: OtpField;
}

interface Candidate extends OtpMatch {
  distance: number;
}

/**
 * 从主题与摘要里提取验证码。没有上下文词就直接返回 null ——
 * 「4 到 8 位数字」本身信息量太低，脱离上下文一定会误报（订单号、金额、楼层号）。
 */
export function extractOtp(subject: string | null, snippet: string | null): OtpMatch | null {
  const best = [
    ...candidatesIn(subject ?? '', 'subject'),
    ...candidatesIn(snippet ?? '', 'snippet'),
  ].sort(byRelevance)[0];
  return best ? { code: best.code, start: best.start, end: best.end, field: best.field } : null;
}

/** 只要码本身。列表行的 chip、`y` 复制都用它。 */
export function otpCode(subject: string | null, snippet: string | null): string | null {
  return extractOtp(subject, snippet)?.code ?? null;
}

function candidatesIn(text: string, field: OtpField): Candidate[] {
  if (text === '') return [];

  const contexts = [...text.matchAll(CONTEXT)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  if (contexts.length === 0) return [];

  const out: Candidate[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const code = raw.replace(/[ -]/g, '');
    if (!isPlausibleCode(raw, code)) continue;

    const start = match.index;
    out.push({
      code,
      start,
      end: start + raw.length,
      field,
      distance: distanceToContext(contexts, start, start + raw.length),
    });
  }
  return out;
}

function isPlausibleCode(raw: string, code: string): boolean {
  if (code.length < MIN_LENGTH || code.length > MAX_LENGTH) return false;
  if (DATE_LIKE.test(raw) || CLOCK.test(raw)) return false;
  if (YEAR.test(code)) return false;
  // 纯字母不是码；纯数字之外的形态至少要有一个数字
  if (!/\d/.test(code)) return false;
  return true;
}

/**
 * 到最近上下文词的距离。码通常**跟在**关键词后面，
 * 所以出现在关键词之前的候选要加倍惩罚（「2026 年的验证码是 738214」不该选 2026）。
 */
function distanceToContext(
  contexts: { start: number; end: number }[],
  start: number,
  end: number,
): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const context of contexts) {
    const gap = start >= context.end ? start - context.end : (context.start - end) * 2;
    best = Math.min(best, Math.max(gap, 0));
  }
  return best;
}

function byRelevance(a: Candidate, b: Candidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  const lengthDelta = lengthRank(a.code) - lengthRank(b.code);
  if (lengthDelta !== 0) return lengthDelta;
  // 主题里的码比摘要里的更可信
  if (a.field !== b.field) return a.field === 'subject' ? -1 : 1;
  return a.start - b.start;
}

function lengthRank(code: string): number {
  return Math.abs(code.length - PREFERRED_LENGTH);
}

/** 屏幕阅读器要逐位读，否则 738214 会被读成「七十三万八千二百一十四」。 */
export function spellOutCode(code: string): string {
  return code.split('').join(' ');
}

export function otpAriaLabel(code: string): string {
  return `验证码 ${spellOutCode(code)}`;
}

export interface TextSegment {
  text: string;
  highlight: boolean;
}

/**
 * 把一段文本按区间切成片段，交给 React 渲染 `<mark>`。
 * **不走 innerHTML** —— 高亮不是 `react/no-danger` 的例外（email-rendering.md §11）。
 */
export function splitHighlight(text: string, ranges: { start: number; end: number }[]): TextSegment[] {
  const sorted = [...ranges]
    .filter((r) => r.end > r.start && r.start >= 0 && r.start < text.length)
    .sort((a, b) => a.start - b.start);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), highlight: false });
    segments.push({ text: text.slice(range.start, range.end), highlight: true });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlight: false });
  return segments;
}

/** 关键词在文本里的全部出现位置，用于搜索结果的命中高亮。 */
export function findTermRanges(text: string, terms: string[]): { start: number; end: number }[] {
  const haystack = text.toLowerCase();
  const ranges: { start: number; end: number }[] = [];

  for (const term of terms) {
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      ranges.push({ start: index, end: index + needle.length });
      from = index + needle.length;
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}
