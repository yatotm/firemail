import {
  CREDENTIAL_EXPORT_COUNT_HEADER,
  CREDENTIAL_EXPORT_SKIPPED_HEADER,
  accountSchema,
  apiErrorSchema,
  emptyDataSchema,
  healthSchema,
  revealedAccountPasswordSchema,
  testConnectionResultSchema,
  userSchema,
  userSettingsSchema,
  type Account,
  type AccountAuthType,
  type AccountProvider,
  type ChangePasswordRequest,
  type ExportCredentialsRequest,
  type Health,
  type TestConnectionResult,
  type UpdateUserSettings,
  type User,
  type UserSettings,
} from '@firemail/shared';
import { API_BASE, ApiError, api, apiFetch, isApiError } from '@/lib/api';
import { filenameFromDisposition } from '@/lib/accounts/download';
import {
  accountEndpoints,
  adminEndpoints,
  credentialEndpoints,
  securityEndpoints,
  settingsEndpoints,
} from '@/lib/accounts/endpoints';
import {
  accountListSchema,
  bulkImportOutcomeSchema,
  bulkSyncStartedSchema,
  deviceCodeStateSchema,
  reauthCancelledSchema,
  registrationSchema,
  sessionListSchema,
  syncStartedSchema,
  userListSchema,
  type BulkImportOutcome,
  type BulkSyncStarted,
  type CreateAccountPayload,
  type DeviceCodeState,
  type SessionView,
  type SyncStarted,
  type UpdateAccountPayload,
} from '@/lib/accounts/schemas';

/**
 * 账号 / 用户 / 会话 / 设置四组接口的唯一出口。
 * 组件与 hook 都不直接拼路径，也不直接碰 `fetch` —— 旧版有一份绕过 API 客户端、
 * 用 `alert()` 报错的管理页，就是从「组件里自己发请求」开始的。
 */

export async function fetchAccounts(signal?: AbortSignal): Promise<Account[]> {
  return api.get(accountEndpoints.list, {
    schema: accountListSchema,
    query: { limit: 200 },
    ...(signal ? { signal } : {}),
  });
}

export async function fetchAccount(id: number, signal?: AbortSignal): Promise<Account> {
  return api.get(accountEndpoints.detail(id), {
    schema: accountSchema,
    ...(signal ? { signal } : {}),
  });
}

export async function createAccount(body: CreateAccountPayload): Promise<Account> {
  return api.post(accountEndpoints.list, body, { schema: accountSchema });
}

export async function updateAccount(id: number, body: UpdateAccountPayload): Promise<Account> {
  return api.patch(accountEndpoints.detail(id), body, { schema: accountSchema });
}

export async function deleteAccount(id: number): Promise<void> {
  await api.delete(accountEndpoints.detail(id), { schema: emptyDataSchema });
}

export async function setAccountSyncEnabled(id: number, enabled: boolean): Promise<Account> {
  return apiFetch(accountEndpoints.syncEnabled(id), {
    method: 'PUT',
    body: { enabled },
    schema: accountSchema,
  });
}

/** 202 + SSE 推进度，这里只负责发起。 */
export async function syncAccount(id: number): Promise<SyncStarted> {
  return api.post(accountEndpoints.sync(id), undefined, { schema: syncStartedSchema });
}

/** 批量同步：**一次**请求带走整批，不是 N 个单账号请求。见 lib/accounts/sync.ts。 */
export async function syncAccounts(accountIds: number[]): Promise<BulkSyncStarted> {
  return api.post(accountEndpoints.bulkSync, { accountIds }, { schema: bulkSyncStartedSchema });
}

/** 服务端有 25 秒硬时限，前端不再加自己的超时。 */
export async function testAccount(id: number): Promise<TestConnectionResult> {
  return api.post(accountEndpoints.test(id), undefined, { schema: testConnectionResultSchema });
}

export interface BulkImportPayload {
  provider: AccountProvider;
  authType: AccountAuthType;
  separator: string;
  payload: string;
}

export async function importAccounts(body: BulkImportPayload): Promise<BulkImportOutcome> {
  return api.post(accountEndpoints.import, body, { schema: bulkImportOutcomeSchema });
}

// ---------------------------------------------------------------------------
// 设备码重新授权
// ---------------------------------------------------------------------------

export async function startReauth(id: number): Promise<DeviceCodeState> {
  return api.post(accountEndpoints.reauth(id), undefined, { schema: deviceCodeStateSchema });
}

/** 没有进行中的流程时服务端返回 404 —— 那不是错误，是「还没开始」。 */
export async function pollReauth(id: number, signal?: AbortSignal): Promise<DeviceCodeState | null> {
  try {
    return await api.get(accountEndpoints.reauth(id), {
      schema: deviceCodeStateSchema,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}

export async function cancelReauth(id: number): Promise<boolean> {
  const result = await api.delete(accountEndpoints.reauth(id), { schema: reauthCancelledSchema });
  return result.cancelled;
}

// ---------------------------------------------------------------------------
// 凭据
//
// 这两个函数是明文凭据在前端唯一的入口。调用方拿到值之后自己负责尽快丢掉：
// 密码只放组件的局部 state（带自动过期），导出文件直接落盘，两者都不进 query 缓存。
// ---------------------------------------------------------------------------

/** 单个账号的明文密码。只在用户点「显示密码」时调用，不做预取、不做缓存。 */
export async function revealAccountPassword(accountId: number): Promise<string> {
  const revealed = await api.post(
    credentialEndpoints.reveal,
    { accountId },
    { schema: revealedAccountPasswordSchema },
  );
  return revealed.password;
}

export interface CredentialExportFile {
  filename: string;
  /** 文件正文。拿到后应立即写盘并丢弃，不要放进任何长期状态。 */
  text: string;
  /** 服务端实际导出的账号数。 */
  exported: number;
  /** 四字段格式表达不了、因而**没有**进文件的账号数；> 0 时必须提示用户。 */
  skipped: number;
}

/**
 * 全量导出。响应是文件而不是 JSON 信封，所以这里绕开 `apiFetch` 直接用 fetch，
 * 但错误路径仍然解同一种信封 —— 调用方只需要处理 ApiError。
 */
export async function exportCredentials(): Promise<CredentialExportFile> {
  const body: ExportCredentialsRequest = { confirm: true };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${credentialEndpoints.export}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/plain' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接到服务器，请检查网络或服务是否在运行', {
      code: 'network_error',
      status: 0,
    });
  }

  const text = await response.text();
  if (!response.ok) throw toApiError(text, response.status);

  return {
    filename: filenameFromDisposition(response.headers.get('content-disposition')) ?? 'firemail-credentials.txt',
    text,
    exported: headerCount(response, CREDENTIAL_EXPORT_COUNT_HEADER),
    skipped: headerCount(response, CREDENTIAL_EXPORT_SKIPPED_HEADER),
  };
}

function headerCount(response: Response, name: string): number {
  const value = Number(response.headers.get(name));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function toApiError(text: string, status: number): ApiError {
  try {
    const envelope = apiErrorSchema.safeParse(JSON.parse(text));
    if (envelope.success) {
      return new ApiError(envelope.data.error.message, {
        code: envelope.data.error.code,
        status,
      });
    }
  } catch {
    // 不是 JSON 就走下面的兜底文案
  }
  return new ApiError(`导出失败（HTTP ${String(status)}）`, { code: 'internal_error', status });
}

// ---------------------------------------------------------------------------
// 用户管理（仅管理员）
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  username: string;
  password: string;
  isAdmin: boolean;
}

export async function fetchUsers(signal?: AbortSignal): Promise<User[]> {
  return api.get(adminEndpoints.users, {
    schema: userListSchema,
    query: { limit: 200 },
    ...(signal ? { signal } : {}),
  });
}

export async function createUser(input: CreateUserInput): Promise<User> {
  return api.post(adminEndpoints.users, input, { schema: userSchema });
}

export async function setUserAdmin(id: number, isAdmin: boolean): Promise<User> {
  return api.patch(adminEndpoints.user(id), { isAdmin }, { schema: userSchema });
}

export async function resetUserPassword(id: number, newPassword: string): Promise<void> {
  await api.post(adminEndpoints.userPassword(id), { newPassword }, { schema: emptyDataSchema });
}

export async function deleteUser(id: number): Promise<void> {
  await api.delete(adminEndpoints.user(id), { schema: emptyDataSchema });
}

export async function fetchRegistrationAllowed(signal?: AbortSignal): Promise<boolean> {
  const result = await api.get(adminEndpoints.registration, {
    schema: registrationSchema,
    ...(signal ? { signal } : {}),
  });
  return result.allowed;
}

export async function setRegistrationAllowed(allowed: boolean): Promise<boolean> {
  const result = await apiFetch(adminEndpoints.registration, {
    method: 'PUT',
    body: { allowed },
    schema: registrationSchema,
  });
  return result.allowed;
}

// ---------------------------------------------------------------------------
// 安全（会话与口令）
// ---------------------------------------------------------------------------

export async function fetchSessions(signal?: AbortSignal): Promise<SessionView[]> {
  return api.get(securityEndpoints.sessions, {
    schema: sessionListSchema,
    query: { limit: 200 },
    ...(signal ? { signal } : {}),
  });
}

export async function revokeSession(id: number): Promise<void> {
  await api.delete(securityEndpoints.session(id), { schema: emptyDataSchema });
}

/** 改完口令服务端会吊销除当前会话之外的全部会话。 */
export async function changePassword(body: ChangePasswordRequest): Promise<void> {
  await api.post(securityEndpoints.changePassword, body, { schema: emptyDataSchema });
}

// ---------------------------------------------------------------------------
// 偏好设置
// ---------------------------------------------------------------------------

export async function fetchSettings(signal?: AbortSignal): Promise<UserSettings> {
  return api.get(settingsEndpoints.settings, {
    schema: userSettingsSchema,
    ...(signal ? { signal } : {}),
  });
}

export async function updateSettings(patch: UpdateUserSettings): Promise<UserSettings> {
  return api.patch(settingsEndpoints.settings, patch, { schema: userSettingsSchema });
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  return api.get(settingsEndpoints.health, {
    schema: healthSchema,
    ...(signal ? { signal } : {}),
  });
}
