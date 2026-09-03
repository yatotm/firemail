import type { Account } from '@firemail/shared';

/**
 * 导出前的本地估算。
 *
 * 权威结论在服务端（它才看得到解密后的值），这里只回答一个问题：
 * **点下去之前**就要让人知道「有账号进不了这个文件」。备份功能最坏的失败方式，
 * 是让人以为它都装进去了。
 */

export interface ExportScope {
  /** 预计能写进文件的账号。 */
  exportable: Account[];
  /** 四字段格式表达不了的账号，附上人话原因。 */
  excluded: { account: Account; reason: string }[];
}

/** 与服务端 `CredentialService#toLine` 同一套判断，只是这里只有布尔位可看。 */
export function exportScope(accounts: Account[]): ExportScope {
  const scope: ExportScope = { exportable: [], excluded: [] };

  for (const account of accounts) {
    const reason = excludeReason(account);
    if (reason === null) scope.exportable.push(account);
    else scope.excluded.push({ account, reason });
  }
  return scope;
}

function excludeReason(account: Account): string | null {
  if (!account.hasOAuthToken || account.oauthClientId === null) {
    return '没有 client_id / refresh_token，四字段格式填不满';
  }
  if (!account.hasPassword) return '没有保存邮箱密码，四字段格式的第 2 段是空的';
  return null;
}
