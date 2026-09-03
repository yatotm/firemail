/** 旧库遗留数据的规整：时间戳、发件人、摘要。全部纯函数，便于逐条写测试。 */

export interface MailAddress {
  name: string | null;
  address: string | null;
}

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * 把旧库的 TIMESTAMP 文本转成 UTC 毫秒。
 *
 * 旧库两种格式混存：
 *   - `2025-11-30 17:44:54`          —— 无时区，由跑在 UTC 的进程写入，按 UTC 解释
 *   - `2026-09-01 12:47:22-04:00`    —— 带偏移，按偏移换算
 *
 * 不能用 `new Date(str)`：V8 会把无时区的 `YYYY-MM-DD HH:MM:SS` 当**本地时区**，
 * 迁移机器时区一变，349 封邮件的时间就整体漂移。这里全程手工换算。
 */
export function parseLegacyTimestamp(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // 旧库理论上只写文本，这里兜底：小于 1e11 视为秒级 epoch
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const m = TIMESTAMP_RE.exec(text);
  if (!m) return null;

  const [, y, mo, d, hh, mm, ss, frac, zone] = m as unknown as string[];
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  const utc = Date.UTC(+y!, +mo! - 1, +d!, +hh!, +mm!, +ss!, ms);
  if (Number.isNaN(utc)) return null;

  return utc - offsetMinutes(zone) * 60_000;
}

function offsetMinutes(zone: string | undefined): number {
  if (!zone || zone === 'Z' || zone === 'z') return 0;
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/** true 表示该字符串带显式时区偏移（迁移报告里用来区分两类脏数据）。 */
export function hasExplicitZone(value: string): boolean {
  const m = TIMESTAMP_RE.exec(value.trim());
  return Boolean(m?.[8]);
}

/**
 * 解析 RFC5322 发件人。旧库存的是已解码的显示名（无 =?utf-8?B?= 编码字），
 * 但有 76 行是折行后的原文，带 `\n\t`，必须先把空白压平。
 */
export function parseSender(raw: string | null | undefined): MailAddress {
  if (raw == null) return { name: null, address: null };
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { name: null, address: null };

  const angle = /^(.*)<([^<>]*)>$/.exec(text);
  if (angle) {
    return { name: cleanName(angle[1]!), address: emptyToNull(angle[2]!.trim()) };
  }

  // 没有尖括号：形如 `noreply@tm.openai.com` 的裸地址算地址，其余算显示名
  if (/^[^\s@]+@[^\s@]+$/.test(text)) return { name: null, address: text };
  return { name: text, address: null };
}

function cleanName(raw: string): string | null {
  let name = raw.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return emptyToNull(name.trim());
}

const emptyToNull = (v: string): string | null => (v === '' ? null : v);

export const SNIPPET_MAX_CHARS = 200;

/** 列表页预览。按码点截断，避免把 emoji / 代理对劈成两半。 */
export function buildSnippet(body: string | null | undefined, max = SNIPPET_MAX_CHARS): string | null {
  if (body == null) return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
}

const HTML_DOC_START = /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i;

export interface SplitBody {
  text: string;
  html: string;
}

/**
 * 拆分旧库的 `content`。
 *
 * 旧抓取代码（outlook.py）对 multipart 邮件做的是
 * `for part in msg.walk(): if ctype in (text/plain, text/html): content += part.decode()`
 * ——把纯文本正文和整份 HTML 文档**首尾相接拼成一列**存下来。
 * 349 行里 237 行是「纯文本 + HTML」，81 行是纯 HTML，3 行是纯文本，28 行为空。
 *
 * 这里在第一个 HTML 文档起始标记处切开，保证 `text + html === content` 逐字节可还原，
 * 校验环节会对全部邮件断言这一点。
 */
export function splitLegacyBody(content: string | null | undefined): SplitBody {
  if (!content) return { text: '', html: '' };
  const at = HTML_DOC_START.exec(content)?.index ?? -1;
  if (at < 0) return { text: content, html: '' };
  return { text: content.slice(0, at), html: content.slice(at) };
}

/** 只为生成摘要用的粗糙去标签：先干掉 script/style，再抹掉标签，最后解常见实体。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|#x27|#(\d+));/gi, (_, entity: string) => {
      const named: Record<string, string> = {
        nbsp: ' ',
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        '#39': "'",
        '#x27': "'",
      };
      const key = entity.toLowerCase();
      if (key in named) return named[key]!;
      const code = Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}
