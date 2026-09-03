import { z } from 'zod';

/**
 * 旧库格式的批量导入：一行一条 `email----password----client_id----refresh_token`。
 *
 * 这里的解析规则与服务端 `parseBulkImportPayload`（apps/server/src/services/accounts.ts）
 * **逐字节一致**，包括行号的算法：先 `trim()` 整段再按 `\n` 切，空行跳过但仍然占行号。
 * 一致是硬要求 —— 预览里说「第 7 行邮箱不合法」，导入结果里也必须是第 7 行，
 * 否则用户拿到两套互相矛盾的行号。
 */

export const IMPORT_SEPARATOR = '----';
export const IMPORT_FIELD_COUNT = 4;

const emailSchema = z.string().email();

export interface ImportLineValues {
  email: string;
  password: string;
  clientId: string;
  refreshToken: string;
}

export type ImportRowStatus = 'ready' | 'duplicate' | 'invalid';

export interface ImportRow {
  /** 与服务端返回的 `errors[].line` 同一套编号。 */
  line: number;
  status: ImportRowStatus;
  email: string | null;
  /** 非 ready 时说明原因，可直接展示。 */
  reason: string | null;
  values: ImportLineValues | null;
}

export interface ImportPreview {
  rows: ImportRow[];
  ready: number;
  duplicate: number;
  invalid: number;
  /** 非空行总数 = ready + duplicate + invalid。 */
  total: number;
}

export interface ImportPreviewOptions {
  separator?: string;
  /** 已存在的账号邮箱，用来提前标出会被服务端跳过的行。 */
  existingEmails?: Iterable<string>;
}

/** 单行解析：只做形状与邮箱格式校验，不做重复检测。 */
export function parseImportLine(raw: string, line: number, separator = IMPORT_SEPARATOR): ImportRow {
  const parts = raw.split(separator);
  if (parts.length !== IMPORT_FIELD_COUNT) {
    return invalidRow(line, `格式错误，需要 ${IMPORT_FIELD_COUNT} 个字段，实际 ${parts.length} 个`);
  }

  const [email = '', password = '', clientId = '', refreshToken = ''] = parts;
  if (!email || !password || !clientId || !refreshToken) {
    return invalidRow(line, '有空白字段');
  }
  if (!emailSchema.safeParse(email).success) {
    return { line, status: 'invalid', email, reason: `邮箱地址不合法: ${email}`, values: null };
  }

  return {
    line,
    status: 'ready',
    email,
    reason: null,
    values: { email, password, clientId, refreshToken },
  };
}

/**
 * 整段解析 + 重复检测。提交前先给用户看这个结果：
 * 29 个账号一次性粘进来，出错的那一行必须能被指出来，而不是提交后才知道。
 */
export function previewImport(payload: string, options: ImportPreviewOptions = {}): ImportPreview {
  const separator = options.separator ?? IMPORT_SEPARATOR;
  const existing = new Set(
    [...(options.existingEmails ?? [])].map((email) => email.trim().toLowerCase()),
  );
  const seen = new Set<string>();

  const rows: ImportRow[] = [];
  // 与服务端一致：先 trim 整段，再按 \n 切；\r 由每行的 trim 吃掉（CRLF 文本照样能用）
  const lines = payload.trim().split('\n');

  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;

    const row = parseImportLine(trimmed, index + 1, separator);
    if (row.status !== 'ready' || !row.values) {
      rows.push(row);
      continue;
    }

    const key = row.values.email.toLowerCase();
    if (existing.has(key) || seen.has(key)) {
      rows.push({
        ...row,
        status: 'duplicate',
        reason: existing.has(key) ? '账号已存在，导入时会跳过' : '本次粘贴内容里重复，只会导入第一条',
      });
      continue;
    }

    seen.add(key);
    rows.push(row);
  }

  return {
    rows,
    ready: rows.filter((row) => row.status === 'ready').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    total: rows.length,
  };
}

function invalidRow(line: number, reason: string): ImportRow {
  return { line, status: 'invalid', email: null, reason, values: null };
}

export const IMPORT_ROW_LABEL: Record<ImportRowStatus, string> = {
  ready: '可导入',
  duplicate: '已存在',
  invalid: '有问题',
};
