/**
 * oklch → sRGB → WCAG 相对亮度，用来在 CI 里守住 tokens.md §10 的对比度结论。
 * 只做颜色数学，不读文件；调用方（tokens.test.ts）负责把 globals.css 解析成令牌表。
 */

export interface Rgb {
  /** 0–1 的 gamma 编码 sRGB 分量。 */
  r: number;
  g: number;
  b: number;
  /** 0–1 alpha。 */
  a: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 线性光 → sRGB 传输函数。 */
function encodeGamma(x: number): number {
  const v = clamp01(x);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB 传输函数的逆，WCAG 相对亮度用的就是这个。 */
function decodeGamma(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** CSS Color 4 的 oklch → sRGB（超出色域的分量直接钳到 [0,1]，与浏览器显示一致）。 */
export function oklchToRgb(l: number, c: number, hDeg: number, alpha = 1): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const bb = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = l - 0.0894841775 * a - 1.291485548 * bb;

  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  return {
    r: encodeGamma(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    g: encodeGamma(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    b: encodeGamma(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
    a: alpha,
  };
}

const OKLCH = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseNumber(raw: string, percentBase: number): number {
  return raw.endsWith('%') ? Number.parseFloat(raw) / 100 * percentBase : Number.parseFloat(raw);
}

/** 支持 `oklch(...)`、`#rrggbb`；其它写法一律抛错，避免静默算出错误的对比度。 */
export function parseColor(value: string): Rgb {
  const input = value.trim();

  const hex = HEX.exec(input);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (ch) => ch + ch) : hex[1];
    return {
      r: Number.parseInt(h.slice(0, 2), 16) / 255,
      g: Number.parseInt(h.slice(2, 4), 16) / 255,
      b: Number.parseInt(h.slice(4, 6), 16) / 255,
      a: 1,
    };
  }

  const m = OKLCH.exec(input);
  if (!m?.[1] || !m[2] || !m[3]) {
    throw new Error(`无法解析颜色: ${value}`);
  }
  return oklchToRgb(
    parseNumber(m[1], 1),
    parseNumber(m[2], 0.4),
    Number.parseFloat(m[3]),
    m[4] === undefined ? 1 : parseNumber(m[4], 1),
  );
}

/** 半透明前景（如 `oklch(1 0 0 / 14%)`）压在不透明底色上的实际显示色。 */
export function composite(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** 量化到 8bit，和屏幕上真正显示的像素一致。 */
export function toHex(color: Rgb): string {
  const to255 = (x: number) => Math.round(clamp01(x) * 255);
  return `#${[to255(color.r), to255(color.g), to255(color.b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** WCAG 2.x 相对亮度，输入按 8bit 量化后再算。 */
export function relativeLuminance(color: Rgb): number {
  const q = (x: number) => decodeGamma(Math.round(clamp01(x) * 255) / 255);
  return 0.2126 * q(color.r) + 0.7152 * q(color.g) + 0.0722 * q(color.b);
}

/** WCAG 2.x 对比度；前景带 alpha 时先压到背景上。 */
export function contrast(foreground: string, background: string): number {
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  const solidFg = fg.a < 1 ? composite(fg, bg) : fg;

  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 保留两位小数，避免断言消息里出现 5.280000000000001。 */
export function ratio(foreground: string, background: string): number {
  return Math.round(contrast(foreground, background) * 100) / 100;
}

export type TokenMap = Record<string, string>;

/**
 * 从 `globals.css` 里抽出 `:root` / `.dark` 的自定义属性，并把 `var(--x)` 解引用掉。
 * 直接读真实 CSS 而不是在测试里手抄一份，令牌改了测试必然跟着变。
 */
export function extractTokens(css: string): { light: TokenMap; dark: TokenMap } {
  const light = readBlock(css, ':root');
  const dark = { ...light, ...readBlock(css, '.dark') };
  return { light: resolveVars(light), dark: resolveVars(dark) };
}

function readBlock(css: string, selector: string): TokenMap {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`globals.css 里找不到 ${selector} 块`);

  let depth = 0;
  let end = start;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }

  const body = css.slice(start, end);
  const out: TokenMap = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] && m[2]) out[m[1].slice(2)] = m[2].trim();
  }
  return out;
}

function resolveVars(tokens: TokenMap): TokenMap {
  const out: TokenMap = {};
  for (const key of Object.keys(tokens)) {
    let value = tokens[key] ?? '';
    for (let i = 0; i < 5 && value.includes('var('); i++) {
      value = value.replace(/var\(\s*--([\w-]+)\s*\)/g, (_, ref: string) => tokens[ref] ?? '');
    }
    out[key] = value.trim();
  }
  return out;
}
